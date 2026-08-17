import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Authentication. Registered GLOBALLY in app.module.ts, so every route requires a valid Bearer
 * token unless it carries `@Public()`.
 *
 * Global-plus-opt-out fails CLOSED. Per-route `@UseGuards()` fails OPEN — forget it on one new
 * endpoint and that endpoint is silently unauthenticated, with no test failure and no error to
 * notice. This way, forgetting `@Public()` returns 401 to everyone, which surfaces immediately.
 *
 * Answers "who are you", nothing more. Whether you may perform the action is `RolesGuard`;
 * whether the specific record is yours is the service's job.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    // getAllAndOverride checks the handler first, then the controller — so a class-level
    // @Public() covers every route in it, and a method-level one can still override.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    return super.canActivate(context);
  }
}
