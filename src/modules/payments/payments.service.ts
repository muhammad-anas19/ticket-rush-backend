import { Inject, Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { DataSource } from 'typeorm';

import { RealtimeService } from '../../realtime/realtime.service';
import { STRIPE_CLIENT } from '../../stripe/stripe.module';
import { HoldStatus, TicketHold } from '../holds/entities/ticket-hold.entity';
import { Order, OrderStatus } from '../orders/entities/order.entity';
import { ProcessedEvent } from './entities/processed-event.entity';

interface AvailabilityChange {
  eventId: string;
  ticketsCommitted: number;
  totalTickets: number;
}

type FulfilmentOutcome =
  | { kind: 'duplicate' }
  | { kind: 'unknown-order' }
  | { kind: 'converted' }
  | { kind: 'recommitted'; availability: AvailabilityChange }
  | { kind: 'refund-needed'; order: Order };

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
    private readonly dataSource: DataSource,
    private readonly realtime: RealtimeService,
  ) {}

  constructEvent(rawBody: Buffer, signature: string, webhookSecret: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  }

  async handleEvent(event: Stripe.Event): Promise<void> {
    if (event.type !== 'checkout.session.completed') {
      this.logger.debug(`Ignoring unhandled event type: ${event.type}`);
      return;
    }

    const outcome = await this.handleCheckoutCompleted(event);

    if (outcome.kind === 'refund-needed') {
      await this.issueRefund(event.data.object, outcome.order);
    }

    if (outcome.kind === 'recommitted') {
      const { eventId, ticketsCommitted, totalTickets } = outcome.availability;
      const ticketsRemaining = totalTickets - ticketsCommitted;
      this.realtime.broadcastAvailability({
        eventId,
        ticketsRemaining,
        isSoldOut: ticketsRemaining <= 0,
      });
    }
  }

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
        hold.status = HoldStatus.Converted;
        await manager.save(hold);
        order.status = OrderStatus.Paid;
        await manager.save(order);
        this.logger.log(`Order ${order.id} paid — hold ${hold.id} converted`);
        return { kind: 'converted' };
      }

      const [rows] = await manager.query<
        [Array<{ tickets_committed: number; total_tickets: number }>, number]
      >(
        `UPDATE events
            SET tickets_committed = tickets_committed + $1
          WHERE id = $2
            AND tickets_committed + $1 <= total_tickets
        RETURNING tickets_committed, total_tickets`,
        [order.quantity, order.eventId],
      );

      if (rows.length > 0) {
        order.status = OrderStatus.Paid;
        await manager.save(order);
        this.logger.warn(
          `Order ${order.id} paid after its hold had already expired — re-committed ` +
            `${order.quantity} ticket(s) on re-check (TR-DEC-011)`,
        );
        return {
          kind: 'recommitted',
          availability: {
            eventId: order.eventId,
            ticketsCommitted: rows[0].tickets_committed,
            totalTickets: rows[0].total_tickets,
          },
        };
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
