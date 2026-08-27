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

  @Public()
  @Post('stripe')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async handleStripeWebhook(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ): Promise<{ received: true }> {
    if (!request.rawBody) {
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
      throw new BadRequestException(
        `Webhook signature verification failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    await this.payments.handleEvent(event);

    return { received: true };
  }
}
