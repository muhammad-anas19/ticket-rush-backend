import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * The most important table in this project, and the smallest.
 *
 * One column, used as the primary key. Its entire job is to make duplicate Stripe webhook delivery
 * harmless — and duplicate delivery is not hypothetical: Stripe retries on any non-2xx, on a timeout,
 * and occasionally just delivers twice. Without this table a retry fulfils a second time, and in this
 * domain double fulfilment means **selling the same seat twice**.
 *
 * Note there is deliberately NO surrogate `id`. The Stripe event id IS the identity, so making it the
 * primary key means the DATABASE enforces "process this once" — a unique violation is the mechanism,
 * not an application `if` that two concurrent webhooks could both pass.
 *
 * ─── The part the build spec gets wrong (TR-DEC-008) ──────────────────────────
 *
 * The spec says: insert the event id FIRST, then fulfil. That is a real bug. If the process dies after
 * that insert commits but before fulfilment finishes, Stripe's retry is rejected as a duplicate and
 * **the order never fulfils** — money taken, nothing issued, no error anywhere to notice it by.
 *
 * The insert and the fulfilment must share ONE transaction, so they commit or roll back together. Then
 * a unique violation genuinely proves a *committed* fulfilment already exists.
 *
 * Idempotency is not a table. It is a table plus a transaction boundary.
 */
@Entity('processed_events')
export class ProcessedEvent {
  @PrimaryColumn({ type: 'varchar', length: 255, name: 'stripe_event_id' })
  stripeEventId: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'processed_at' })
  processedAt: Date;
}
