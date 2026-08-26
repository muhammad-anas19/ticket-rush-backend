import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentUser, CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { CheckoutSessionResponseDto } from './dto/checkout-session-response.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { OrdersService } from './orders.service';

@ApiTags('orders')
@Controller()
@ApiBearerAuth('access-token')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post('holds/:holdId/checkout')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start (or resume) payment for a held ticket',
    description:
      'Owner only. Creates a Stripe Checkout Session and returns its URL — redirect the browser ' +
      'there. Does NOT mark anything paid; only POST /api/webhooks/stripe does that, because ' +
      'this response is not proof payment happened, only that it was offered.',
  })
  @ApiResponse({ status: 201, type: CheckoutSessionResponseDto })
  @ApiResponse({ status: 404, description: 'No such hold, or not yours' })
  @ApiResponse({ status: 403, description: 'Your hold, but no longer active' })
  @ApiResponse({ status: 409, description: 'Already paid for' })
  async checkout(
    @Param('holdId', ParseUUIDPipe) holdId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<CheckoutSessionResponseDto> {
    return this.orders.createCheckoutSession(holdId, user.id);
  }

  /**
   * Declared BEFORE `:id`, and the order matters — same trap `EventsController` already names:
   * Nest matches routes in declaration order, so `:id` first would swallow `/orders/mine` with
   * `id = 'mine'`, and `ParseUUIDPipe` on the OTHER route would reject it as malformed — a 400 on
   * a route that exists.
   */
  @Get('orders/mine')
  @ApiOperation({
    summary: 'My order history (across every event), newest first',
    description: "`/me/tickets`'s data source — every order the caller has ever placed.",
  })
  async findMine(@CurrentUser() user: CurrentUserPayload, @Query() query: PaginationQueryDto) {
    const result = await this.orders.findMine(user.id, query);
    return { ...result, data: result.data.map((order) => OrderResponseDto.from(order)) };
  }

  @Get('orders/:id')
  @ApiOperation({
    summary: 'Order status',
    description:
      'Owner only. Poll this after a Checkout redirect — the success PAGE proves nothing; this, ' +
      "set only by the webhook, is this project's actual source of truth for whether payment " +
      'landed.',
  })
  @ApiResponse({ status: 200, type: OrderResponseDto })
  @ApiResponse({ status: 404, description: 'No such order, or not yours' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<OrderResponseDto> {
    return OrderResponseDto.from(await this.orders.findOne(id, user.id));
  }
}
