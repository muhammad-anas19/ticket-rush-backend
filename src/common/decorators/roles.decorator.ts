import { SetMetadata } from '@nestjs/common';

import { UserRole } from '../../modules/users/entities/user.entity';

export const ROLES_KEY = 'roles';

/**
 * Declares which roles may reach a route. Read by `RolesGuard` via `Reflector`.
 *
 * Roles answer "are you the KIND of user who may do this" — a question answerable from the
 * token alone, with no database access, which is exactly why it belongs in a guard.
 *
 * It does NOT answer "is this specific record yours." `@Roles(UserRole.Organiser)` on
 * `PATCH /events/:id` lets in every organiser, including ones editing someone else's event.
 * Ownership is a separate check, in the service, because it needs the resource loaded — and
 * conflating the two axes is precisely how IDOR bugs ship (TR-DEC-003).
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
