import { SetMetadata } from '@nestjs/common';

export const SKIP_ENVELOPE_KEY = 'skipEnvelope';

/**
 * Opts a route out of the global response envelope.
 *
 * Two legitimate uses, and both are cases where an *external* consumer has already fixed the
 * response shape and we don't get a vote:
 *
 *  - **Health endpoints.** `@nestjs/terminus` returns its own documented structure, and
 *    orchestrators and uptime probes parse it. Wrapping it in `{ success, data }` would mean
 *    a Kubernetes readiness probe can no longer read the result it expects.
 *
 *  - **`POST /api/webhooks/stripe` (M5).** Stripe only reads the HTTP status code, so the
 *    body is irrelevant to it — but the route is unusual enough that being explicit beats
 *    being accidentally correct. Its *real* problem is on the request side: signature
 *    verification needs the raw unparsed bytes, which breaks at body parsing long before
 *    any interceptor runs.
 *
 * Reach for this when an external contract dictates the shape. Not to make a response
 * "cleaner" — an inconsistent API contract costs the frontend far more than a wrapper does.
 */
export const SkipEnvelope = () => SetMetadata(SKIP_ENVELOPE_KEY, true);
