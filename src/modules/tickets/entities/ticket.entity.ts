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
import { Order } from '../../orders/entities/order.entity';
import { User } from '../../users/entities/user.entity';

@Entity('tickets')
@Index('idx_tickets_user', ['userId'])
@Index('idx_tickets_order', ['orderId'])
export class Ticket {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'order_id' })
  orderId: string;

  @ManyToOne(() => Order, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

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

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  code: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'issued_at' })
  issuedAt: Date;
}
