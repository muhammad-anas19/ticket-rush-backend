import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { ApiEnvelope } from '../types/api-envelope';

/**
 * Wraps every successful response in the ApiEnvelope shape. No exceptions, no opt-out.
 *
 * An earlier version supported a `@SkipEnvelope()` decorator so the health endpoints could return
 * `@nestjs/terminus`'s own structure verbatim. That was removed: the escape hatch needed a second
 * mechanism to cover the error path (an interceptor only wraps successes — see below), and it left
 * one endpoint shaped differently from every other. One contract is worth more than byte-level
 * compatibility with tooling that mostly reads status codes anyway.
 *
 * If a future route genuinely cannot be wrapped — a file download, an SSE stream — reintroduce the
 * decorator *and* the matching filter deliberately, rather than assuming one covers both paths.
 *
 * Where this sits in the request lifecycle matters, and is worth being able to recite:
 *
 *   Middleware → Guards → Interceptors (pre) → Pipes → Handler
 *              → Interceptors (post) → Exception Filters → Response
 *
 * Interceptors wrap the handler on both sides, which is why one can transform the return value. A
 * Guard cannot — it runs before the handler and only decides whether to proceed.
 *
 * Note what happens on the ERROR path: if the handler throws, this `map` never runs, the exception
 * propagates straight past the interceptor, and `AllExceptionsFilter` produces the error envelope
 * instead. The two are deliberately complementary — one shape, two producers — and that split is
 * exactly why the old opt-out needed two pieces to work.
 */
@Injectable()
export class ResponseEnvelopeInterceptor<T> implements NestInterceptor<T, ApiEnvelope<T>> {
  intercept(_context: ExecutionContext, next: CallHandler<T>): Observable<ApiEnvelope<T>> {
    return next.handle().pipe(
      map((data) => ({
        success: true,
        data,
        timestamp: new Date().toISOString(),
      })),
    );
  }
}
