import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { AppConfig } from '../config/configuration';

export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * A single shared Redis connection, injected by token.
 *
 * Redis is single-threaded and processes commands one at a time from a queue, so one
 * connection multiplexing every command is normal and correct — this is not a database
 * where you want a pool. (M7 is the exception: the Socket.IO Redis adapter needs its own
 * dedicated publisher and subscriber connections, because a connection in subscribe mode
 * cannot issue ordinary commands.)
 *
 * Marked @Global so modules from M4 onward can inject it without importing this module
 * everywhere. That is a deliberate exception to the usual "explicit imports" rule, made for
 * the same reason ConfigModule is global: it is infrastructure, not a domain.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const logger = new Logger('Redis');

        const client = new Redis({
          host: config.get('redis.host', { infer: true }),
          port: config.get('redis.port', { infer: true }),

          // Same reasoning as the Postgres retry: a dependency being down at boot is one
          // problem, and a dependency going down at 3am is a different, permanent one.
          retryStrategy: (times) => Math.min(times * 200, 5000),

          // Commands issued while disconnected queue rather than throwing immediately.
          // Fine for a cache; revisit if a code path ever needs to fail fast instead.
          enableOfflineQueue: true,
          maxRetriesPerRequest: 3,

          lazyConnect: false,
        });

        client.on('connect', () => logger.log('Connected'));
        client.on('ready', () => logger.log('Ready'));
        // Without a handler, an ioredis connection error is an unhandled 'error' event,
        // which crashes the Node process outright.
        client.on('error', (error: Error) => logger.error(`Connection error: ${error.message}`));
        client.on('reconnecting', () => logger.warn('Reconnecting'));

        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisModule.name);

  // Injected by token, not by class: the provider above is registered under REDIS_CLIENT,
  // and Nest resolves by token. `private readonly client: Redis` alone would fail at boot.
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  // Without this the process hangs on shutdown: an open Redis socket keeps the event loop
  // alive, so the container never exits and eventually gets SIGKILLed.
  async onApplicationShutdown(): Promise<void> {
    this.logger.log('Closing Redis connection');
    await this.client.quit();
  }
}
