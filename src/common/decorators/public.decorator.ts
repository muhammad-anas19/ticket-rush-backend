import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route as reachable without authentication.
 *
 * This exists because `JwtAuthGuard` is registered GLOBALLY — every route requires a valid
 * token unless it opts out. That direction matters: it **fails closed**.
 *
 * The alternative, applying `@UseGuards(JwtAuthGuard)` per protected route, fails OPEN. Forget
 * the decorator on one new endpoint and it is silently public — and nothing tells you. No test
 * fails, no error appears, the endpoint just works for everyone. That is a genuinely common way
 * for authorisation to be missing in production.
 *
 * Fail-closed inverts the failure: forget `@Public()` and the endpoint returns 401 for
 * everybody, which you notice in about ten seconds.
 *
 * Every use of this decorator is therefore a deliberate, greppable declaration that a route is
 * meant to be public. `git grep '@Public'` is an audit.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
