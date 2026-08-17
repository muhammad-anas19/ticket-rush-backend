import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { UserRole } from '../../modules/users/entities/user.entity';

/** What `JwtStrategy.validate()` attaches to the request. Not the full User entity. */
export interface CurrentUserPayload {
  id: string;
  email: string;
  role: UserRole;
}

/**
 * Injects the authenticated user into a handler parameter.
 *
 * The point is not convenience — it is that a controller never touches `Request` directly, so
 * the identity a handler acts on always comes from a VERIFIED token rather than from anything
 * the client could set. Reaching into `req.body.userId` or a header instead is the shape of
 * every "act as any user" vulnerability.
 *
 * Undefined on a `@Public()` route, since no guard ran to populate it.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentUserPayload | undefined => {
    return ctx.switchToHttp().getRequest().user as CurrentUserPayload | undefined;
  },
);
