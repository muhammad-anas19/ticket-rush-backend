import { Inject, Injectable } from '@nestjs/common';
import { HealthCheckError, HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';
import Redis from 'ioredis';

import { REDIS_CLIENT } from '../../../redis/redis.module';

/**
 * Terminus ships indicators for HTTP, TypeORM, memory and disk, but not Redis — so this is
 * a small custom one.
 *
 * `PING` is the right check: it is O(1), touches no data, and proves the round trip works
 * rather than merely that a socket object exists. A check that only inspected
 * `client.status` would report healthy against a connection that is open but wedged.
 */
@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {
    super();
  }

  async pingCheck(key: string, timeoutMs = 1000): Promise<HealthIndicatorResult> {
    try {
      // A health check that can hang forever is worse than no health check — the probe times
      // out at the orchestrator instead, with a much less useful error.
      // Widened to `string` deliberately. ioredis types ping() as returning the literal
      // 'PONG', which makes TypeScript narrow the guard below to `never` and treat it as
      // dead code. The type is a promise about a remote server's reply, not a proof — keep
      // the runtime check.
      const pong: string = await Promise.race([
        this.client.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);

      if (pong !== 'PONG') {
        throw new Error(`Unexpected reply: ${pong}`);
      }

      // NOTE the key name: `connection`, not `status`.
      //
      // getStatus() builds `{ [key]: { status: isHealthy ? 'up' : 'down', ...data } }`, so a
      // `status` property in `data` OVERWRITES the up/down verdict. Passing
      // `{ status: this.client.status }` produced `{ redis: { status: 'ready' } }` — and
      // since Terminus buckets results by `status === 'up'` or `'down'`, 'ready' matched
      // neither and Redis was dropped from the response entirely. Readiness returned 200
      // with only Postgres listed, silently not checking Redis at all.
      //
      // A health check that quietly stops checking is worse than no health check: it reports
      // confidence it hasn't earned. Found by reading the response, not by it failing.
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
