import { Inject, Injectable } from '@nestjs/common';
import { HealthCheckError, HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';
import Redis from 'ioredis';

import { REDIS_CLIENT } from '../../../redis/redis.module';

@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {
    super();
  }

  async pingCheck(key: string, timeoutMs = 1000): Promise<HealthIndicatorResult> {
    try {
      const pong: string = await Promise.race([
        this.client.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);

      if (pong !== 'PONG') {
        throw new Error(`Unexpected reply: ${pong}`);
      }

      return this.getStatus(key, true, { connection: this.client.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new HealthCheckError(
        'Redis check failed',
        this.getStatus(key, false, { message, connection: this.client.status }),
      );
    }
  }
}
