import { Module } from '@nestjs/common';

import { CacheController } from './cache.controller';
import { CacheService } from './cache.service';

/**
 * Not `@Global()`, unlike `RedisModule`. That one is infrastructure — a raw connection every
 * future module will need. This one is a specific pattern (cache-aside + single-flight + version
 * counters) that only the modules actually caching something should depend on, so those
 * dependencies stay explicit in their own module files.
 */
@Module({
  controllers: [CacheController],
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
