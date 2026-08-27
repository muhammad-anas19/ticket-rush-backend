import { ApiProperty } from '@nestjs/swagger';

import { HoldStatus, TicketHold } from '../entities/ticket-hold.entity';

export class HoldResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  eventId: string;

  @ApiProperty()
  quantity: number;

  @ApiProperty({ enum: HoldStatus })
  status: HoldStatus;

  @ApiProperty({
    format: 'date-time',
    description: 'The countdown deadline. Ten minutes from creation.',
  })
  expiresAt: Date;

  @ApiProperty({ description: 'The event’s remaining count AFTER this hold was committed.' })
  eventTicketsRemaining: number;

  static from(hold: TicketHold, eventTicketsRemaining: number): HoldResponseDto {
    return {
      id: hold.id,
      eventId: hold.eventId,
      quantity: hold.quantity,
      status: hold.status,
      expiresAt: hold.expiresAt,
      eventTicketsRemaining,
    };
  }
}
