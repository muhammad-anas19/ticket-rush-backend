/**
 * The response contract. Every endpoint returns this shape, success or failure.
 *
 * Controllers never build it by hand — `ResponseEnvelopeInterceptor` wraps whatever a
 * handler returns, and `AllExceptionsFilter` wraps whatever it throws. Consistency by
 * construction rather than by everyone remembering.
 */
export interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  message?: string;
  timestamp: string;
}

export interface ApiErrorEnvelope {
  success: false;
  data: null;
  /** Always a human-readable string. Never an object — see `details` for structured payloads. */
  message: string;
  statusCode: number;
  path: string;
  timestamp: string;
  /** Field-level validation errors, when the failure came from the ValidationPipe. */
  errors?: string[];
  /**
   * Structured detail from exceptions whose payload is an object rather than a message —
   * `@nestjs/terminus` health results being the case that forced this.
   *
   * It exists so `message` can stay honestly typed as a string. Before this, a Terminus
   * failure put its whole `{ status, info, error, details }` object into `message`, which
   * satisfied the compiler (the filter built the object loosely) but lied to every consumer
   * reading `message` as text.
   */
  details?: unknown;
}

/**
 * List responses. Note `limit`, not `pageSize` — the query parameter and the response field
 * share a name deliberately, because two names for one concept is how a frontend ends up
 * sending one and reading the other.
 *
 * Every field is always present, even when `data` is empty, so a consumer never has to
 * branch on whether pagination metadata exists.
 */
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}
