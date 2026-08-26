import { ApiProperty } from '@nestjs/swagger';

import { Order, OrderStatus } from '../entities/order.entity';

export class OrderEventSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  venue: string;

  @ApiProperty({ format: 'date-time' })
  startsAt: Date;
}

/**
 * Explicit projection, same reasoning as `EventResponseDto`: an `Order` entity carries
 * `stripeSessionId` and FK columns nobody outside this module needs to see.
 */
export class OrderResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  eventId: string;

  @ApiProperty()
  quantity: number;

  @ApiProperty({ description: 'Integer minor units (cents), never a decimal' })
  amountCents: number;

  @ApiProperty({
    enum: OrderStatus,
    description:
      'The one field worth polling after a Stripe redirect — the success PAGE proves nothing; ' +
      'this, set only by the webhook, is the real outcome.',
  })
  status: OrderStatus;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({
    type: OrderEventSummaryDto,
    required: false,
    description:
      'Present when the relation was joined (the "my orders" list) — a JOIN, not a second ' +
      'query per row, the same reasoning `EventsService.findAll()` already uses for its own ' +
      'organiser column.',
  })
  event?: OrderEventSummaryDto;

  static from(order: Order): OrderResponseDto {
    return {
      id: order.id,
      eventId: order.eventId,
      quantity: order.quantity,
      amountCents: order.amountCents,
      status: order.status,
      createdAt: order.createdAt,
      event: order.event
        ? {
            id: order.event.id,
            title: order.event.title,
            venue: order.event.venue,
            startsAt: order.event.startsAt,
          }
        : undefined,
    };
  }
}
