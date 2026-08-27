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
  Refunded = 'refunded',
}

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

  @Index('idx_orders_hold_unique', { unique: true, where: 'hold_id IS NOT NULL' })
  @Column({ type: 'uuid', name: 'hold_id', nullable: true })
  holdId: string | null;

  @ManyToOne(() => TicketHold, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'hold_id' })
  hold: TicketHold | null;

  @Column({ type: 'integer' })
  quantity: number;

  @Column({ type: 'integer', name: 'amount_cents' })
  amountCents: number;

  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.Pending })
  status: OrderStatus;

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
