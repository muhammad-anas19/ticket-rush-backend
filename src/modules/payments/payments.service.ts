import { Inject, Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { DataSource } from 'typeorm';

import { STRIPE_CLIENT } from '../../stripe/stripe.module';
import { HoldStatus, TicketHold } from '../holds/entities/ticket-hold.entity';
import { Order, OrderStatus } from '../orders/entities/order.entity';
import { ProcessedEvent } from './entities/processed-event.entity';

type FulfilmentOutcome =
  | { kind: 'duplicate' }
  | { kind: 'unknown-order' }
  | { kind: 'converted' }
  | { kind: 'recommitted' }
  | { kind: 'refund-needed'; order: Order };

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Pure local HMAC verification — no network call to Stripe happens here, which is exactly
   * why a tampered signature fails immediately rather than after a round trip. Throws
   * `Stripe.errors.StripeSignatureVerificationError` on any mismatch; the controller maps that
   * straight to 400.
   */
  constructEvent(rawBody: Buffer, signature: string, webhookSecret: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  }

  /**
   * Dispatches by event type. Everything this project has no opinion about is acknowledged
   * (200) and ignored — Stripe sends dozens of event types, and a webhook endpoint's job is to
   * react to what it knows, not reject what it doesn't (that would just make Stripe retry an
   * event that will never be understood, forever).
   */
  async handleEvent(event: Stripe.Event): Promise<void> {
    if (event.type !== 'checkout.session.completed') {
      this.logger.debug(`Ignoring unhandled event type: ${event.type}`);
      return;
    }

    const outcome = await this.handleCheckoutCompleted(event);

    if (outcome.kind === 'refund-needed') {
      await this.issueRefund(event.data.object, outcome.order);
    }
  }

  /**
   * `TR-DEC-008`'s mechanism, exactly: the dedupe insert and the fulfilment writes share ONE
   * transaction, so a unique violation on `processed_events` can only mean a COMMITTED
   * fulfilment already happened — never a half-finished one.
   *
   * Uses `INSERT ... ON CONFLICT DO NOTHING` (TypeORM's `.orIgnore()`), not a caught
   * unique-violation exception. That distinction matters specifically under Postgres: an error
   * raised by ANY statement mid-transaction poisons the rest of it — every following statement
   * fails with "current transaction is aborted" until a ROLLBACK, so catching the error and
   * continuing on the same connection would not work without a SAVEPOINT. `ON CONFLICT DO
   * NOTHING` never raises in the first place; a duplicate simply inserts zero rows, and the
   * transaction carries on normally.
   *
   * ─── The bug this caught: `identifiers`, not `raw`, is the signal to check ───
   *
   * The first version of this method checked `insertResult.identifiers.length === 0` to detect
   * a duplicate. That is ALWAYS length 1 here, insert or not — confirmed empirically with a
   * throwaway script, not assumed. TypeORM builds `identifiers` from the entity's primary-key
   * VALUES, and for a column that is not database-generated — `stripeEventId` is a plain
   * string, Stripe's own id, not a serial or a UUID default — there is nothing for TypeORM to
   * have generated and reported back, so it just echoes what was passed into `.values()`
   * regardless of whether Postgres actually inserted a row or silently discarded it on
   * conflict. Checking it made every redelivered webhook look identical to a fresh one:
   * duplicate events were silently REPROCESSED — the exact failure this whole mechanism exists
   * to prevent — behind a check that read reasonably and compiled cleanly.
   *
   * `insertResult.raw` is the real signal: it holds whatever Postgres's own `RETURNING` clause
   * actually returned — one row on a genuine insert, an empty array when `ON CONFLICT DO
   * NOTHING` fired. `raw.length === 0` is the correct check. Worth remembering as the general
   * rule: for an entity with a database-GENERATED key, `identifiers` happens to be reliable
   * too, because there the generated value can only ever come from a real insert. The moment a
   * primary key is caller-supplied, as here, that guarantee is gone.
   */
  private async handleCheckoutCompleted(event: Stripe.Event): Promise<FulfilmentOutcome> {
    const session = event.data.object as Stripe.Checkout.Session;
    const { holdId, orderId } = session.metadata ?? {};

    if (!holdId || !orderId) {
      this.logger.error(`checkout.session.completed ${event.id} is missing metadata — ignoring`);
      return { kind: 'unknown-order' };
    }

    return this.dataSource.transaction(async (manager) => {
      const insertResult = await manager
        .createQueryBuilder()
        .insert()
        .into(ProcessedEvent)
        .values({ stripeEventId: event.id })
        .orIgnore()
        .execute();

      if (insertResult.raw.length === 0) {
        this.logger.log(`Duplicate webhook ${event.id} ignored — already processed`);
        return { kind: 'duplicate' };
      }

      const order = await manager.findOne(Order, { where: { id: orderId } });
      if (!order) {
        this.logger.error(`checkout.session.completed ${event.id}: no order ${orderId}`);
        return { kind: 'unknown-order' };
      }

      const hold = await manager.findOne(TicketHold, { where: { id: holdId } });

      if (hold && hold.status === HoldStatus.Active && !hold.isExpired) {
        // Common path: nothing expired between checkout and payment. `Event.ticketsCommitted`
        // already counts this hold's quantity (M3) — paying just converts the reservation, it
        // does not commit inventory a second time.
        hold.status = HoldStatus.Converted;
        await manager.save(hold);
        order.status = OrderStatus.Paid;
        await manager.save(order);
        this.logger.log(`Order ${order.id} paid — hold ${hold.id} converted`);
        return { kind: 'converted' };
      }

      // TR-DEC-011: the hold expired (or is simply gone) before payment completed, and its
      // inventory was already released back to availability by the same release/sweep path
      // M3 built. Re-run the IDENTICAL atomic conditional UPDATE `HoldsService.create()` uses:
      // if the seat is still free, take it; if someone else has it now, there is nothing left
      // to sell, and the payment must be refunded rather than kept for a seat that no longer
      // exists.
      const [rows] = await manager.query<[Array<{ tickets_committed: number }>, number]>(
        `UPDATE events
            SET tickets_committed = tickets_committed + $1
          WHERE id = $2
            AND tickets_committed + $1 <= total_tickets
        RETURNING tickets_committed`,
        [order.quantity, order.eventId],
      );

      if (rows.length > 0) {
        order.status = OrderStatus.Paid;
        await manager.save(order);
        this.logger.warn(
          `Order ${order.id} paid after its hold had already expired — re-committed ` +
            `${order.quantity} ticket(s) on re-check (TR-DEC-011)`,
        );
        return { kind: 'recommitted' };
      }

      order.status = OrderStatus.Refunded;
      await manager.save(order);
      this.logger.warn(
        `Order ${order.id}: hold expired AND the event sold out before payment completed — ` +
          `refunding (TR-DEC-011)`,
      );
      return { kind: 'refund-needed', order };
    });
  }

  /**
   * Deliberately OUTSIDE the transaction above. A refund is a network call to Stripe — exactly
   * what `HoldsService.create()`'s own comment warns never belongs inside a transaction holding
   * a row lock — and it carries the same "external call after a commit can fail with nothing to
   * retry it" gap `TR-DEC-012` already names for M6's publish step. Logged loudly rather than
   * silently swallowed; a queued retry would close this properly, which is exactly why
   * `TR-DEC-012` leaves that decision for M6 rather than solving it twice, once here and once
   * there.
   */
  private async issueRefund(session: Stripe.Checkout.Session, order: Order): Promise<void> {
    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id;

    if (!paymentIntentId) {
      this.logger.error(
        `Cannot refund order ${order.id}: session ${session.id} has no payment_intent`,
      );
      return;
    }

    try {
      await this.stripe.refunds.create({ payment_intent: paymentIntentId });
      this.logger.log(`Refund issued for order ${order.id} (payment_intent ${paymentIntentId})`);
    } catch (error) {
      this.logger.error(
        `Refund FAILED for order ${order.id}, payment_intent ${paymentIntentId} — needs manual ` +
          `follow-up: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
