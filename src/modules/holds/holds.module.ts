import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RealtimeModule } from '../../realtime/realtime.module';
import { Event } from '../events/entities/event.entity';
import { TicketHold } from './entities/ticket-hold.entity';
import { HoldsController } from './holds.controller';
import { HoldsService } from './holds.service';

@Module({
  imports: [TypeOrmModule.forFeature([TicketHold, Event]), RealtimeModule],
  controllers: [HoldsController],
  providers: [HoldsService],
})
export class HoldsModule {}
