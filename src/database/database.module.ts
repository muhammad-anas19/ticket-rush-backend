import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppConfig } from '../config/configuration';
import { NodeEnv } from '../config/env.validation';
import { buildDataSourceOptions } from './data-source';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        ...buildDataSourceOptions(),

        autoLoadEntities: true,

        extra: {
          max: 10,
          connectionTimeoutMillis: 5000,
          idleTimeoutMillis: 30000,
        },

        retryAttempts: 10,
        retryDelay: 3000,

        verboseRetryLog: config.get('nodeEnv', { infer: true }) === NodeEnv.Development,
      }),
    }),
  ],
})
export class DatabaseModule {}
