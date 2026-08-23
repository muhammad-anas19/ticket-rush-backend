import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Event } from '../../events/entities/event.entity';
import { TicketHold } from '../../holds/entities/ticket-hold.entity';
import { User } from '../../users/entities/user.entity';

export enum OrderStatus {
  Pending = 'pending',
  Paid = 'paid',
  Failed = 'failed',
  /**
   * Beyond the build spec's three, for TR-DEC-011: a Stripe Checkout Session's MINIMUM expiry is 30
   * minutes while our hold is 10, so a user can legitimately pay after their hold expired and the
   * inventory was released. Without a refund path that is money taken for a seat we no longer have.
   */
  Refunded = 'refunded',
}

/** Schema only in M2 — behaviour is M5 (Stripe). */
@Entity('orders')
@Index('idx_orders_user_created', ['userId', 'createdAt'])
@Index('idx_orders_event', ['eventId'])
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'event_id' })
  eventId: string;

  @ManyToOne(() => Event, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'event_id' })
  event: Event;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  /**
   * Nullable, and UNIQUE where present.
   *
   * Unique because one hold must never produce two orders — that is a double charge. Nullable because
   * a hold may be removed while its order history remains: a paid order is a financial record and must
   * outlive the reservation that produced it.
   */
  @Index('idx_orders_hold_unique', { unique: true, where: 'hold_id IS NOT NULL' })
  @Column({ type: 'uuid', name: 'hold_id', nullable: true })
  holdId: string | null;

  @ManyToOne(() => TicketHold, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'hold_id' })
  hold: TicketHold | null;

  @Column({ type: 'integer' })
  quantity: number;

  /** Integer minor units, same reasoning as Event.priceCents. Never a float. */
  @Column({ type: 'integer', name: 'amount_cents' })
  amountCents: number;

  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.Pending })
  status: OrderStatus;

  /**
   * Nullable until a Checkout Session exists; UNIQUE so one Stripe session can never map to two
   * orders. A second, independent line of defence behind `processed_events`: that table stops a
   * duplicate WEBHOOK, this constraint stops a duplicate SESSION.
   */
  @Index('idx_orders_stripe_session_unique', {
    unique: true,
    where: 'stripe_session_id IS NOT NULL',
  })
  @Column({ type: 'varchar', length: 255, name: 'stripe_session_id', nullable: true })
  stripeSessionId: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}
