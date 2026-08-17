import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { UserRole } from '../../modules/users/entities/user.entity';
import { CurrentUserPayload } from '../decorators/current-user.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * Authorisation by role. Runs AFTER `JwtAuthGuard`, and the order is not incidental — this guard
 * reads `request.user`, which only exists because authentication already populated it.
 *
 * Guards execute in the order they are registered, global guards before route-scoped ones. That
 * is why authentication is registered first in app.module.ts.
 *
 * Scope of this guard, precisely: "is the caller the KIND of user permitted here." It needs only
 * the token, which is why it can be a guard at all — a guard runs before the handler and has no
 * resource loaded.
 *
 * It cannot answer "is this record yours." That needs the row, so it lives in the service.
 * Putting it here would mean querying the event inside the guard and again inside the service:
 * two round trips for one operation, or stashing the entity on the request and coupling the two
 * through a mutable object.
 *
 *   Role checks → guards (token is enough)
 *   Ownership   → service (needs the resource)
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @Roles() means no role restriction — any authenticated user passes. Authentication has
    // already been enforced globally, so this is not an open door.
    if (!required || required.length === 0) {
      return true;
    }

    const user = context.switchToHttp().getRequest().user as CurrentUserPayload | undefined;

    // Defensive, and it should be unreachable: a route with @Roles() but no authentication would
    // land here with no user. Throwing rather than returning false makes a misconfiguration loud
    // instead of quietly denying everyone.
    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    if (!required.includes(user.role)) {
      // 403, not 404. The caller is authenticated and we are telling them their role is
      // insufficient — hiding that would be pointless here, since the route itself is
      // documented in Swagger.
      //
      // The calculation differs for a specific RESOURCE: a 403 on `GET /orders/:id` confirms
      // that order exists, which lets someone probe for valid IDs. Return 404 when existence
      // itself is confidential; 403 when it is already public. Events are public, orders are not.
      throw new ForbiddenException('Insufficient permissions for this action');
    }

    return true;
  }
}
