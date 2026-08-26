import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import Stripe from 'stripe';
import { Repository } from 'typeorm';

import { buildPaginatedResponse, PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { PaginatedResponse } from '../../common/types/api-envelope';
import { AppConfig } from '../../config/configuration';
import { STRIPE_CLIENT } from '../../stripe/stripe.module';
import { Event } from '../events/entities/event.entity';
import { HoldStatus, TicketHold } from '../holds/entities/ticket-hold.entity';
import { Order, OrderStatus } from './entities/order.entity';

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(TicketHold) private readonly holds: Repository<TicketHold>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Creates (or resumes) a Stripe Checkout Session for a hold the caller owns.
   *
   * ─── Why this checks the hold, not just "does an event exist" ────────────────
   *
   * A hold is the caller's PROOF of a reserved seat — `TicketHold.expiresAt`/`status` are the
   * same authority M3 built for the hold endpoints themselves. Nothing here re-derives
   * availability from `Event.ticketsCommitted`: that number already includes this hold's
   * quantity the moment the hold was created, so a second check here would just be asking the
   * same question the hold's own creation already answered atomically.
   *
   * ─── Why 404 for ownership, 403 for state — same split as `HoldsService.release()` ──
   *
   * Holds are private, so "not yours" and "doesn't exist" both read 404 — a 403 would confirm
   * the id is real. A hold that IS yours but no longer active is a 403: existence and
   * ownership are settled, only the ACTION is invalid.
   *
   * ─── Idempotent by construction, not by convention ────────────────────────────
   *
   * `orders.hold_id` is UNIQUE where present (`idx_orders_hold_unique`) — the database cannot
   * hold two orders for one hold regardless of what this method does. So this method never
   * INSERTs a second row for a hold that already has one; it reuses (and, if the old Stripe
   * session is no longer open, refreshes) the existing row instead. A double-click or a
   * browser-back-then-retry lands here, not on a raw constraint violation.
   */
  async createCheckoutSession(
    holdId: string,
    userId: string,
  ): Promise<{ checkoutUrl: string; orderId: string }> {
    const hold = await this.holds.findOne({ where: { id: holdId } });

    if (!hold || hold.userId !== userId) {
      throw new NotFoundException('Hold not found');
    }

    if (hold.status !== HoldStatus.Active || hold.isExpired) {
      throw new ForbiddenException('This hold is no longer active');
    }

    let order = await this.orders.findOne({ where: { holdId } });

    if (order?.status === OrderStatus.Paid) {
      throw new ConflictException('This hold has already been paid for');
    }

    if (order?.stripeSessionId) {
      const existingSession = await this.stripe.checkout.sessions.retrieve(order.stripeSessionId);
      if (existingSession.status === 'open' && existingSession.url) {
        return { checkoutUrl: existingSession.url, orderId: order.id };
      }
      // The earlier session expired or was abandoned without a webhook ever completing it.
      // Fall through and mint a fresh one against the SAME row — never a second INSERT for
      // this hold, since the unique index would reject it regardless.
    }

    const event = await this.events.findOne({ where: { id: hold.eventId } });
    if (!event) {
      throw new NotFoundException('Event not found');
    }

    order ??= await this.orders.save(
      this.orders.create({
        eventId: hold.eventId,
        userId,
        holdId: hold.id,
        quantity: hold.quantity,
        amountCents: hold.quantity * event.priceCents,
        status: OrderStatus.Pending,
      }),
    );

    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: event.title },
            unit_amount: event.priceCents,
          },
          quantity: hold.quantity,
        },
      ],
      // Both metadata AND the success URL carry orderId — the webhook (server-to-server, the
      // only thing that can actually mark this order paid) reads it from metadata; the success
      // URL's copy is purely so the frontend's success page knows which order to POLL. Neither
      // one is trusted as proof of anything by itself.
      success_url: `${this.config.get('stripe.successUrl', { infer: true })}?orderId=${order.id}`,
      cancel_url: this.config.get('stripe.cancelUrl', { infer: true }),
      metadata: { holdId: hold.id, orderId: order.id },
    });

    order.stripeSessionId = session.id;
    await this.orders.save(order);

    if (!session.url) {
      // Stripe's own types allow a null url; in practice this only happens for session types
      // this app never creates (e.g. an already-expired one returned from a stale retrieve
      // above, which is handled before reaching here). Documented rather than silently cast
      // away, since `!` here would hide a real Stripe-side anomaly if it ever occurred.
      throw new ConflictException('Stripe did not return a checkout URL — please try again');
    }

    return { checkoutUrl: session.url, orderId: order.id };
  }

  /** Owner-only read, for the frontend to poll after a Checkout redirect. */
  async findOne(id: string, userId: string): Promise<Order> {
    const order = await this.orders.findOne({ where: { id } });

    if (!order || order.userId !== userId) {
      // Same reasoning as holds: orders are private, so a mismatch and a missing row both read
      // 404 rather than confirming the id exists via a 403.
      throw new NotFoundException('Order not found');
    }

    return order;
  }

  /**
   * The caller's own order history, across every event, newest first — `/me/tickets`'s data
   * source. A JOIN for the event summary (title/venue/starts), not a query per row: the exact
   * N+1 `EventsService.findAll()` already avoids for its own organiser column, applied here to
   * the same class of problem.
   */
  async findMine(userId: string, query: PaginationQueryDto): Promise<PaginatedResponse<Order>> {
    const qb = this.orders.createQueryBuilder('order');

    qb.leftJoin('order.event', 'event').addSelect([
      'event.id',
      'event.title',
      'event.venue',
      'event.startsAt',
    ]);

    qb.where('order.userId = :userId', { userId });

    qb.orderBy('order.createdAt', 'DESC');
    // Stable tiebreaker — same reasoning as every other paginated list in this project: without
    // it, rows sharing a `createdAt` value (two orders placed in the same millisecond) can shift
    // between pages across requests.
    qb.addOrderBy('order.id', 'ASC');

    qb.skip(query.skip).take(query.limit);

    const [data, total] = await qb.getManyAndCount();

    return buildPaginatedResponse(data, total, query);
  }
}
