import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { StripeModule } from '../../stripe/stripe.module';
import { Event } from '../events/entities/event.entity';
import { TicketHold } from '../holds/entities/ticket-hold.entity';
import { Order } from './entities/order.entity';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

/**
 * Imports `TicketHold` and `Event` directly rather than depending on `HoldsModule`/`EventsModule`
 * — same reasoning as `HoldsModule` importing `Event`: this needs raw rows (a hold's own
 * ownership/status/expiry, an event's price), not those modules' business logic (pagination,
 * the hold-creation transaction, ownership-checked updates), none of which applies here.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Order, TicketHold, Event]), StripeModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
