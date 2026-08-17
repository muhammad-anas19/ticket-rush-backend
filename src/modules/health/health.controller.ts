import { Controller, Get, UseFilters } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';

import { Public } from '../../common/decorators/public.decorator';
import { SkipEnvelope } from '../../common/decorators/skip-envelope.decorator';
import { HealthExceptionFilter } from './health-exception.filter';
import { RedisHealthIndicator } from './indicators/redis.health';

/**
 * Two probes, two different questions, two different remedies. Getting this wrong is how a
 * partial outage becomes a total one — see qa/phase-0 Q6.
 *
 * These routes are excluded from the global `/api` prefix (see main.ts) because ops tooling
 * expects health checks at conventional unprefixed paths, and skip the response envelope
 * because Terminus's own output shape is what probes are written to parse.
 */
@ApiTags('health')
@Controller('health')
// SkipEnvelope covers the success path (the interceptor); the filter covers the failure path.
// Both are needed — see health-exception.filter.ts for why that isn't obvious.
@SkipEnvelope()
@UseFilters(HealthExceptionFilter)
// Required from M1, because JwtAuthGuard is now global and fails closed. A liveness probe that
// needed a Bearer token would be useless — an orchestrator has no credentials, so every instance
// would look dead and be restarted forever. Health checks are the canonical @Public() route.
@Public()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  /**
   * Liveness — "is this process irrecoverably broken; should you restart me?"
   *
   * Deliberately checks NOTHING external. This looks uselessly trivial and is correct
   * precisely because it is.
   *
   * If liveness checked dependencies, then the moment RabbitMQ or Postgres went down every
   * instance would fail liveness at once, the orchestrator would kill and restart all of
   * them, restarting would fix nothing because the dependency is still down, and they would
   * fail again — a restart storm. The whole API is then down because of a single dependency
   * outage, the restarts hammer that dependency while it tries to recover, and the health
   * check itself has caused a worse incident than the fault did.
   *
   * Liveness answers one thing: is the event loop alive enough to reply.
   */
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

  /**
   * Readiness — "can this instance serve traffic right now?"
   *
   * Failing this deregisters the instance from the load balancer but leaves it running, and
   * re-registers it on recovery. So the question is not "is everything up," it is
   * **"can this instance serve the traffic it will actually receive?"**
   *
   *   Postgres — CHECKED. Every endpoint reads or writes it. Without it this instance
   *              genuinely cannot serve, and taking it out of rotation is correct.
   *
   *   Redis    — CHECKED, but this is a judgement call rather than an obvious one. It is a
   *              cache and TR-DEC-007 makes it authoritative for nothing, so losing it means
   *              slower responses, not wrong ones. Included because from M4 the hold
   *              countdown lives here and a cold Redis under real load would stampede
   *              Postgres. Revisit if a Redis blip ever deregisters the whole fleet — that
   *              would be this line's fault, and the fix is to drop it.
   *
   *   RabbitMQ — DELIBERATELY NOT CHECKED. Browsing events, viewing an event and reading
   *              availability never touch the broker. Failing readiness on RabbitMQ would
   *              pull every instance from the load balancer and stop users from even looking
   *              at events, because checkout fulfilment is degraded. The correct response to
   *              a broker outage is: keep serving, let the endpoints that need it fail
   *              loudly, and page a human. Health probes drive automation; monitoring drives
   *              people.
   *
   * That asymmetry looks like an oversight and is a decision, which is why it is written
   * down here rather than only in a doc.
   */
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
