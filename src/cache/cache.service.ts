import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

import { REDIS_CLIENT } from '../redis/redis.module';

const LOCK_TTL_MS = 5000;
const LOCK_WAIT_STEP_MS = 50;
const LOCK_MAX_WAIT_MS = 1000;

// 0-15% added on top of the caller's requested TTL. Enough to de-synchronise keys that would
// otherwise all expire in the same instant (e.g. every event cached within the same second of
// server startup); small enough that nobody can perceive "60s" having quietly become "69s".
const JITTER_RATIO = 0.15;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generic cache-aside helper over the shared Redis client.
 *
 * `getOrSet` is the entire pattern in one call: check Redis, and only ask the caller's `fetcher`
 * to hit the real data source on a miss. What makes this more than a two-line wrapper is the
 * **single-flight lock**, which exists to prevent a cache stampede.
 *
 * Without it: a popular key expires, and every one of N concurrent requests independently sees
 * a miss and independently calls `fetcher()` — N simultaneous identical database queries at the
 * exact moment the cache was supposed to be protecting the database. With it: exactly one caller
 * wins a short-lived Redis lock and calls `fetcher()`; every other concurrent miss waits briefly
 * for the winner to populate the cache, then reads what it wrote, instead of redoing the same
 * work. This is the same gatekeeping shape as M3's atomic `UPDATE ... WHERE` — one condition only
 * one caller can satisfy, everyone else falls back to reading the result.
 *
 * A waiter that times out (the winner is unusually slow, or died mid-fetch and never released the
 * lock until its TTL expires) falls back to calling `fetcher()` itself rather than waiting
 * forever — degrading to "no caching for this one request" instead of hanging every caller behind
 * a stuck winner.
 */
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

    // Someone else already won the lock and is refilling. Poll briefly for their result instead
    // of duplicating the fetch.
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

  /** Explicit invalidation on write — the primary correctness mechanism; TTL is only the backstop. */
  async invalidate(key: string): Promise<void> {
    await this.redis.del(key);
  }

  /**
   * Namespaced version counter, used to invalidate an unbounded set of list-cache keys (one per
   * distinct combination of page/filter/sort params) without a `SCAN`-and-delete sweep.
   *
   * Every list cache key embeds the namespace's current version. Bumping the version on any write
   * makes every existing key for that namespace unreachable — new reads compute a key with the new
   * version and miss — while the old, now-orphaned keys are left for Redis to reclaim naturally via
   * their own TTL. No enumeration of "which keys exist for this namespace" is ever needed.
   */
  async bumpVersion(namespace: string): Promise<number> {
    return this.redis.incr(`version:${namespace}`);
  }

  async getVersion(namespace: string): Promise<number> {
    const value = await this.redis.get(`version:${namespace}`);
    return value ? parseInt(value, 10) : 0;
  }
}
