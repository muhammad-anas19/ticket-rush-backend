import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../common/decorators/public.decorator';
import { CacheService } from './cache.service';

/**
 * The M4 checkpoint asks for "a measured hit ratio you can quote" — this is where it's read from,
 * not a product feature. Public because there is nothing sensitive in a hit/miss count, and gating
 * it behind auth would make it useless for the one thing it exists for: checking the number during
 * a live demo.
 */
@ApiTags('cache')
@Controller('cache')
@Public()
export class CacheController {
  constructor(private readonly cache: CacheService) {}

  @Get('stats')
  @ApiOperation({
    summary: 'Cache hit/miss counters',
    description:
      'Cumulative since the process started. Not reset per request — restart the API to zero it.',
  })
  async stats() {
    return this.cache.getStats();
  }
}
