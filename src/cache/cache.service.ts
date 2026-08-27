import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

import { REDIS_CLIENT } from '../redis/redis.module';

const LOCK_TTL_MS = 5000;
const LOCK_WAIT_STEP_MS = 50;
const LOCK_MAX_WAIT_MS = 1000;

const JITTER_RATIO = 0.15;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async getOrSet<T>(key: string, ttlSeconds: number, fetcher: () => Promise<T>): Promise<T> {
    const cached = await this.redis.get(key);
    if (cached !== null) {
      return JSON.parse(cached) as T;
    }

    const lockKey = `lock:${key}`;
    const acquiredLock = await this.redis.set(lockKey, '1', 'PX', LOCK_TTL_MS, 'NX');

    if (acquiredLock === 'OK') {
      try {
        const value = await fetcher();
        const jitterSeconds = Math.floor(Math.random() * ttlSeconds * JITTER_RATIO);
        await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds + jitterSeconds);
        return value;
      } finally {
        await this.redis.del(lockKey);
      }
    }

    const deadline = Date.now() + LOCK_MAX_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(LOCK_WAIT_STEP_MS);
      const refilled = await this.redis.get(key);
      if (refilled !== null) {
        return JSON.parse(refilled) as T;
      }
    }

    this.logger.warn(`Cache lock wait timed out for "${key}"; fetching directly`);
    return fetcher();
  }

  async invalidate(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async bumpVersion(namespace: string): Promise<number> {
    return this.redis.incr(`version:${namespace}`);
  }

  async getVersion(namespace: string): Promise<number> {
    const value = await this.redis.get(`version:${namespace}`);
    return value ? parseInt(value, 10) : 0;
  }
}
