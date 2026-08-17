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
  message: string;
  statusCode: number;
  path: string;
  timestamp: string;
  /** Field-level validation errors, when the failure came from the ValidationPipe. */
  errors?: string[];
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
