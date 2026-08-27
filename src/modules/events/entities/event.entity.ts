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

import { User } from '../../users/entities/user.entity';

@Entity('events')
@Index('idx_events_starts_at', ['startsAt'])
@Index('idx_events_organiser_starts_at', ['organiserId', 'startsAt'])
export class Event {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', name: 'organiser_id' })
  organiserId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'organiser_id' })
  organiser: User;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 200 })
  venue: string;

  @Column({ type: 'timestamptz', name: 'starts_at' })
  startsAt: Date;

  @Column({ type: 'integer', name: 'price_cents' })
  priceCents: number;

  @Column({ type: 'integer', name: 'total_tickets' })
  totalTickets: number;

  @Column({ type: 'integer', name: 'tickets_committed', default: 0 })
  ticketsCommitted: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  get ticketsRemaining(): number {
    return this.totalTickets - this.ticketsCommitted;
  }

  get isSoldOut(): boolean {
    return this.ticketsRemaining <= 0;
  }
}
