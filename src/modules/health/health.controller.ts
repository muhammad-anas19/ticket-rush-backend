import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';

import { Public } from '../../common/decorators/public.decorator';
import { RedisHealthIndicator } from './indicators/redis.health';

@ApiTags('health')
@Controller('health')
@Public()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  @Get('live')
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Returns 200 if the process can respond at all. Checks no dependencies, by design — ' +
      'failing liveness triggers a container restart, which cannot fix a dependency outage.',
  })
  live() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Returns 200 if this instance can serve traffic. Checks Postgres and Redis. Does NOT ' +
      'check RabbitMQ — most endpoints do not need it, and failing readiness on it would ' +
      'turn a checkout outage into a total one.',
  })
  ready() {
    return this.health.check([
      () => this.db.pingCheck('postgres', { timeout: 1500 }),
      () => this.redis.pingCheck('redis'),
    ]);
  }
}
