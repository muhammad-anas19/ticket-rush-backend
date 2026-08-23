import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Event } from '../events/entities/event.entity';
import { TicketHold } from './entities/ticket-hold.entity';
import { HoldsController } from './holds.controller';
import { HoldsService } from './holds.service';

/**
 * Imports the `Event` entity directly rather than depending on `EventsModule`.
 *
 * `HoldsService` needs raw, transactional access to the `events` row for the atomic conditional
 * UPDATE — that is database access, not a call to `EventsService`'s business logic (pagination,
 * ownership checks, DTO mapping), none of which applies here and none of which should run inside
 * the hold's transaction. Depending on `EventsModule` for this would couple two modules over a
 * capability neither actually needs from the other.
 */
@Module({
  imports: [TypeOrmModule.forFeature([TicketHold, Event])],
  controllers: [HoldsController],
  providers: [HoldsService],
})
export class HoldsModule {}
