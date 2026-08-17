import { ArgumentsHost, Catch, ExceptionFilter, ServiceUnavailableException } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

/**
 * Preserves Terminus's own response shape when a health check FAILS.
 *
 * This exists because of a real inconsistency found by running the failure case rather than
 * only the happy path:
 *
 *   `@SkipEnvelope()` opts a route out of ResponseEnvelopeInterceptor — but an interceptor
 *   only wraps the SUCCESS path. When a handler throws, the interceptor's `map` never runs,
 *   the exception propagates straight past it, and AllExceptionsFilter produces the error
 *   envelope. So `/health/ready` was returning Terminus's raw shape on 200 and our envelope
 *   on 503 — two different shapes from one endpoint.
 *
 *   Interceptors and filters are complementary, not two views of the same thing. Opting out
 *   of one says nothing about the other. That distinction is the whole point of knowing the
 *   request lifecycle order:
 *
 *     Guards → Interceptors (pre) → Pipes → Handler → Interceptors (post) → Filters
 *
 * In practice orchestrators read the status code and ignore the body, so this was harmless.
 * It is fixed anyway because the reason `@SkipEnvelope()` is on this controller at all is
 * "external tooling parses Terminus's documented structure" — and that reasoning applies
 * exactly as much when the check fails, which is when someone is actually reading it.
 *
 * Scoped to this controller with @UseFilters rather than added to AllExceptionsFilter:
 * `common/` must not learn about a specific module's response format.
 */
@Catch(ServiceUnavailableException)
export class HealthExceptionFilter implements ExceptionFilter {
  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: ServiceUnavailableException, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();

    // Terminus packs the complete HealthCheckResult — status, info, error, details — into
    // the exception's response object. Replying with it verbatim is the whole job.
    httpAdapter.reply(ctx.getResponse(), exception.getResponse(), exception.getStatus());
  }
}
