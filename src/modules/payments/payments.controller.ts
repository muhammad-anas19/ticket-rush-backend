import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { Request } from 'express';
import Stripe from 'stripe';

import { Public } from '../../common/decorators/public.decorator';
import { AppConfig } from '../../config/configuration';
import { PaymentsService } from './payments.service';

@Controller('webhooks')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Stripe calls this, never a browser — it carries no Bearer token, and never will, so
   * `@Public()` here is not a gap in the auth guard, it's the correct answer for a route this
   * shape. What proves the caller is really Stripe is the signature check below, not a token.
   *
   * `@Body()` deliberately absent. The moment a parameter needs the global `ValidationPipe` to
   * run against a DTO, this route is back in the normal pipeline — and this route can't be,
   * because signature verification needs the exact BYTES Stripe sent, not a value that already
   * round-tripped through JSON.parse. `@Req()` reads `request.rawBody` (populated by
   * `rawBody: true` in `main.ts`, set up back in M0 for exactly this route) instead.
   *
   * Excluded from Swagger — this isn't a route a human calls from the docs UI, and its request
   * shape (raw bytes, a header only Stripe computes) has nothing meaningful to document there.
   */
  @Public()
  @Post('stripe')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async handleStripeWebhook(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ): Promise<{ received: true }> {
    if (!request.rawBody) {
      // Would mean `rawBody: true` regressed in main.ts, or something upstream (a proxy, a
      // different body parser) consumed the stream first. Either way, signature verification
      // is IMPOSSIBLE without the original bytes — fail loudly rather than silently trusting
      // an unverified body.
      throw new BadRequestException('Raw request body unavailable — cannot verify signature');
    }

    let event: Stripe.Event;

    try {
      event = this.payments.constructEvent(
        request.rawBody,
        signature,
        this.config.get('stripe.webhookSecret', { infer: true }),
      );
    } catch (error) {
      // 400, never 500 — this means "the signature didn't match", not "something on our side
      // broke". Stripe does NOT retry a 400 (it assumes the payload itself is bad), which is
      // correct here: retrying an unverifiable request would never start verifying.
      throw new BadRequestException(
        `Webhook signature verification failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    // Anything thrown from here on is a REAL failure (a DB write failing, say) and is left to
    // propagate to the global exception filter as a 5xx — Stripe treats any non-2xx as "retry
    // later," which is exactly the right behaviour for a transient failure on our side, and the
    // wrong one to swallow into a false 200.
    await this.payments.handleEvent(event);

    return { received: true };
  }
}
