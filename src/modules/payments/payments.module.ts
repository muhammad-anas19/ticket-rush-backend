import { Module } from '@nestjs/common';

import { RealtimeModule } from '../../realtime/realtime.module';
import { StripeModule } from '../../stripe/stripe.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [StripeModule, RealtimeModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
