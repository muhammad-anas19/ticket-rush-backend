import { Module } from '@nestjs/common';

import { RealtimeModule } from '../../realtime/realtime.module';
import { StripeModule } from '../../stripe/stripe.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * No `TypeOrmModule.forFeature()` here. `PaymentsService` writes to `Order`, `TicketHold`, and
 * `ProcessedEvent` entirely through the injected `DataSource`'s transactional `EntityManager` —
 * the same reasoning `HoldsService` documents for why it takes no repository at all: every write
 * in a webhook handler MUST be inside the one transaction that also does the dedupe check, and a
 * repository bound to the default connection would be a standing invitation to escape it.
 */
@Module({
  imports: [StripeModule, RealtimeModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
