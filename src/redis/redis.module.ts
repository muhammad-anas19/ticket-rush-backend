import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { AppConfig } from '../config/configuration';

export const REDIS_CLIENT = 'REDIS_CLIENT';

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

          retryStrategy: (times) => Math.min(times * 200, 5000),

          enableOfflineQueue: true,
          maxRetriesPerRequest: 3,

          lazyConnect: false,
        });

        client.on('connect', () => logger.log('Connected'));
        client.on('ready', () => logger.log('Ready'));
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

  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    this.logger.log('Closing Redis connection');
    await this.client.quit();
  }
}
