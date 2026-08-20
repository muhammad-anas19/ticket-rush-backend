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

/** Schema only in M2 — rows are created by the RabbitMQ consumer in M6. */
@Entity('tickets')
@Index('idx_tickets_user', ['userId'])
// The consumer's idempotency check is "do tickets already exist for this order?", so this index sits on
// the redelivery path — which by definition runs when something has already gone wrong.
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

  /**
   * The code presented at the door. UNIQUE — two tickets sharing a code means someone gets turned away.
   *
   * Must come from a CSPRNG, not a sequence and not Math.random(). A guessable code is a free ticket:
   * anyone can enumerate valid ones and walk in. Same high-entropy-versus-guessable distinction as
   * refresh tokens — and the same reason a fast hash is right for one and a slow hash for the other.
   */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  code: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'issued_at' })
  issuedAt: Date;
}
