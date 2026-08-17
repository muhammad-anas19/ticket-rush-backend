import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { SKIP_ENVELOPE_KEY } from '../decorators/skip-envelope.decorator';
import { ApiEnvelope } from '../types/api-envelope';

/**
 * Wraps every successful response in the ApiEnvelope shape.
 *
 * Where this sits in the request lifecycle matters, and it is worth being able to recite:
 *
 *   Middleware → Guards → Interceptors (pre) → Pipes → Handler
 *              → Interceptors (post) → Exception Filters → Response
 *
 * Interceptors wrap the handler on both sides, which is why one can transform the return
 * value. A Guard cannot — it runs before the handler and only decides whether to proceed.
 *
 * Note what happens on the error path: if the handler throws, this `map` never runs, the
 * exception propagates past the interceptor, and `AllExceptionsFilter` produces the error
 * envelope instead. The two are deliberately complementary — one shape, two producers.
 */
@Injectable()
export class ResponseEnvelopeInterceptor<T> implements NestInterceptor<T, ApiEnvelope<T> | T> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiEnvelope<T> | T> {
    // getAllAndOverride checks the handler first, then the controller, so a class-level
    // decorator applies to every route while a method-level one can still override it.
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_ENVELOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (skip) {
      return next.handle();
    }

    return next.handle().pipe(
      map((data) => ({
        success: true,
        data,
        timestamp: new Date().toISOString(),
      })),
    );
  }
}
