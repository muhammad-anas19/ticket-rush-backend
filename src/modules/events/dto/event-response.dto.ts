import { ApiProperty } from '@nestjs/swagger';

import { Event } from '../entities/event.entity';

/**
 * The shape clients receive. An explicit projection, not the entity.
 *
 * Two reasons this is worth the extra file:
 *
 * 1. **Nothing leaks by accident.** Returning the entity means every column added to `events` later is
 *    automatically published, including ones nobody thought about. An explicit DTO makes exposure a
 *    decision each time.
 * 2. **The getters are computed here.** `ticketsRemaining` and `isSoldOut` are TypeScript getters on the
 *    entity, and getters do NOT survive `JSON.stringify` — so returning the entity directly would
 *    silently drop exactly the fields the UI needs most.
 */
export class EventResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty()
  venue: string;

  @ApiProperty({ format: 'date-time', description: 'ISO 8601 UTC' })
  startsAt: Date;

  @ApiProperty({ example: 1999, description: 'Integer minor units (cents), never a decimal' })
  priceCents: number;

  @ApiProperty()
  totalTickets: number;

  @ApiProperty({ description: 'Held or sold — a hold is a reservation, not a sale (TR-DEC-014)' })
  ticketsCommitted: number;

  @ApiProperty({
    description:
      'Derived, never stored, and deliberately NOT cached in M4 — a stale title is cosmetic, a stale ' +
      'availability count is a correctness bug because someone acts on it.',
  })
  ticketsRemaining: number;

  @ApiProperty()
  isSoldOut: boolean;

  @ApiProperty({ required: false, description: 'Present when the relation was joined' })
  organiser?: { id: string; email: string };

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  static from(event: Event): EventResponseDto {
    return {
      id: event.id,
      title: event.title,
      description: event.description,
      venue: event.venue,
      startsAt: event.startsAt,
      priceCents: event.priceCents,
      totalTickets: event.totalTickets,
      ticketsCommitted: event.ticketsCommitted,
      // Called explicitly, because a getter would vanish in serialisation.
      ticketsRemaining: event.ticketsRemaining,
      isSoldOut: event.isSoldOut,
      organiser: event.organiser
        ? { id: event.organiser.id, email: event.organiser.email }
        : undefined,
      createdAt: event.createdAt,
    };
  }
}
