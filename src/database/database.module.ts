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

        // Pool sizing. See qa/phase-0 Q7 for the arithmetic that matters.
        //
        // The number to compute is not `instances × max` at steady state — it is at PEAK,
        // which means mid-deploy when the old and new instances are both alive, plus any
        // worker process with its own pool (the M6 RabbitMQ consumer), plus the psql or
        // pgAdmin session you left open, plus the 3 connections Postgres reserves for
        // superusers. Ten per instance against a default max_connections of 100 leaves
        // room; ten instances would not.
        //
        // Also note: a bigger pool is usually the wrong fix for exhaustion. Postgres runs
        // one OS process per connection, so past a point more connections means more
        // context switching and LESS throughput. Shorter transactions first, then indexes,
        // then PgBouncer.
        extra: {
          max: 10,
          // How long a query waits for a free connection before the driver gives up. Without
          // it, an exhausted pool queues forever and every endpoint slowly hangs while the
          // database itself looks completely healthy — the signature symptom, and the reason
          // it gets misdiagnosed as "the database is slow".
          connectionTimeoutMillis: 5000,
          idleTimeoutMillis: 30000,
        },

        // `depends_on: service_healthy` in Compose solves the boot race exactly once. This
        // solves the problem that never goes away: Postgres restarts, a managed instance
        // fails over, a network partition drops connections for ninety seconds. None of that
        // restarts the container, so no startup ordering is re-evaluated — the process simply
        // loses its connections mid-life and has to recover on its own.
        retryAttempts: 10,
        retryDelay: 3000,

        verboseRetryLog: config.get('nodeEnv', { infer: true }) === NodeEnv.Development,
      }),
    }),
  ],
})
export class DatabaseModule {}
