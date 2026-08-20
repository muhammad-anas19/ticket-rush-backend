import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Event } from './entities/event.entity';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

@Module({
  imports: [TypeOrmModule.forFeature([Event])],
  controllers: [EventsController],
  providers: [EventsService],
  // Exported because M3 HoldsModule needs to read events, and M5 needs price. Only the SERVICE is
  // exported, never the repository — so the inventory counter stays owned by one module.
  exports: [EventsService],
})
export class EventsModule {}
