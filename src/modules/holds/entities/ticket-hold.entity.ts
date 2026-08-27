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

export enum HoldStatus {
  Active = 'active',
  Converted = 'converted',
  Expired = 'expired',
}

@Entity('ticket_holds')
@Index('idx_ticket_holds_event_status', ['eventId', 'status'])
@Index('idx_ticket_holds_user', ['userId'])
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

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt: Date;

  @Column({ type: 'enum', enum: HoldStatus, default: HoldStatus.Active })
  status: HoldStatus;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  get isExpired(): boolean {
    return this.status === HoldStatus.Active && this.expiresAt.getTime() <= Date.now();
  }
}
