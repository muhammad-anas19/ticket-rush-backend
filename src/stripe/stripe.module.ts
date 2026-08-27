import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

import { AppConfig } from '../config/configuration';

export const STRIPE_CLIENT = 'STRIPE_CLIENT';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: STRIPE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) =>
        new Stripe(config.get('stripe.secretKey', { infer: true }), {
          apiVersion: '2026-07-29.dahlia',
        }),
    },
  ],
  exports: [STRIPE_CLIENT],
})
export class StripeModule {}
