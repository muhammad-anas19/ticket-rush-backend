import { Module } from '@nestjs/common';

import { CacheService } from './cache.service';

/**
 * Not `@Global()`, unlike `RedisModule`. That one is infrastructure — a raw connection every
 * future module will need. This one is a specific pattern (cache-aside + single-flight + version
 * counters) that only the modules actually caching something should depend on, so those
 * dependencies stay explicit in their own module files.
 */
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
