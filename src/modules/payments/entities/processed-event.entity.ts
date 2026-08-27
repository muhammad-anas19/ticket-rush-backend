import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity('processed_events')
export class ProcessedEvent {
  @PrimaryColumn({ type: 'varchar', length: 255, name: 'stripe_event_id' })
  stripeEventId: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'processed_at' })
  processedAt: Date;
}
