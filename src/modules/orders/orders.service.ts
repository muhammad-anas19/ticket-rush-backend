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
      success_url: `${this.config.get('stripe.successUrl', { infer: true })}?orderId=${order.id}`,
      cancel_url: this.config.get('stripe.cancelUrl', { infer: true }),
      metadata: { holdId: hold.id, orderId: order.id },
    });

    order.stripeSessionId = session.id;
    await this.orders.save(order);

    if (!session.url) {
      throw new ConflictException('Stripe did not return a checkout URL — please try again');
    }

    return { checkoutUrl: session.url, orderId: order.id };
  }

  async findOne(id: string, userId: string): Promise<Order> {
    const order = await this.orders.findOne({ where: { id } });

    if (!order || order.userId !== userId) {
      throw new NotFoundException('Order not found');
    }

    return order;
  }

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
    qb.addOrderBy('order.id', 'ASC');

    qb.skip(query.skip).take(query.limit);

    const [data, total] = await qb.getManyAndCount();

    return buildPaginatedResponse(data, total, query);
  }
}
