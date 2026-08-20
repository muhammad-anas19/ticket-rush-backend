import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Event } from '../../events/entities/event.entity';
import { User } from '../../users/entities/user.entity';

/**
 * `active` → live, and its quantity is counted in events.tickets_committed.
 * `converted` → paid for; the commitment becomes permanent.
 * `expired` → released; the quantity returned to availability.
 */
export enum HoldStatus {
  Active = 'active',
  Converted = 'converted',
  Expired = 'expired',
}

/**
 * Schema only in M2 — behaviour is M3, the hardest module in the project.
 *
 * Indexing policy here is the OPPOSITE of `events`, deliberately. This table is written on every hold
 * attempt and read comparatively rarely, so every extra index taxes the hot path — and that path is
 * hottest exactly during a flash sale, when the system is already under maximum stress. So: only
 * indexes a real query needs.
 */
@Entity('ticket_holds')
// The sweeper and availability reconciliation both ask "which holds for this event are still active?".
// This serves that, and by leftmost-prefix also serves event_id alone.
@Index('idx_ticket_holds_event_status', ['eventId', 'status'])
// "My holds" — a user checking what they are holding.
@Index('idx_ticket_holds_user', ['userId'])
// The expiry sweeper: active holds past their deadline. A PARTIAL index would be tighter here
// (`WHERE status = 'active'`), since converted and expired rows are dead weight in the index forever
// and this table only grows. Deferred to M3, where the sweeper's real query shape is known — indexing
// before you have the query is guessing.
@Index('idx_ticket_holds_expires_at', ['expiresAt'])
export class TicketHold {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'event_id' })
  eventId: string;

  @ManyToOne(() => Event, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event: Event;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'integer' })
  quantity: number;

  /**
   * THE authority on whether this hold is still valid — not a Redis TTL, not a queued message.
   *
   * TR-DEC-007: availability calculations must treat an expired-but-still-`active` hold as free, so
   * correctness never depends on a timer having fired. RabbitMQ TTL+DLX (M6) is a timely TRIGGER for
   * releasing rows; a periodic sweeper is the backstop for messages the broker loses. Three layers,
   * one authority.
   *
   * A Redis key expiry cannot be the authority: it is not even an event unless keyspace notifications
   * are enabled, and those are fire-and-forget — no subscriber connected at that instant means the
   * notification is gone permanently and the hold leaks forever.
   */
  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt: Date;

  @Column({ type: 'enum', enum: HoldStatus, default: HoldStatus.Active })
  status: HoldStatus;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  /** True when the deadline has passed but nothing has released it yet — the gap the sweeper closes. */
  get isExpired(): boolean {
    return this.status === HoldStatus.Active && this.expiresAt.getTime() <= Date.now();
  }
}
