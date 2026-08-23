import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

import { AppConfig } from '../config/configuration';

export const STRIPE_CLIENT = 'STRIPE_CLIENT';

/**
 * A single configured Stripe client, injected by token — same shape as `RedisModule`, for the
 * same reason: one place constructs it, everything else asks for it rather than building its own.
 *
 * Not `@Global()`. Unlike Redis (needed everywhere from M4 onward) or Config, Stripe is used by
 * exactly two modules (`OrdersModule`, `PaymentsModule`), so keeping the dependency explicit in
 * their own module files costs nothing and documents who actually touches payments.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: STRIPE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) =>
        new Stripe(config.get('stripe.secretKey', { infer: true }), {
          // Pinned explicitly rather than left to the library's default. Stripe's API can add
          // breaking changes on a version boundary; an unpinned client silently picks up
          // whatever version is current on the ACCOUNT the moment someone upgrades the `stripe`
          // package, which is exactly the kind of change you want to make on purpose, in a
          // diff, not receive automatically.
          apiVersion: '2026-07-29.dahlia',
        }),
    },
  ],
  exports: [STRIPE_CLIENT],
})
export class StripeModule {}
