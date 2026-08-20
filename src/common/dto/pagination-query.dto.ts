import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { PaginatedResponse } from '../types/api-envelope';

/**
 * Shared query params for every list endpoint.
 *
 * OFFSET pagination, chosen deliberately rather than by default — see `buildPaginatedResponse` below
 * for where its ceiling is.
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page: number = 1;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  // A hard ceiling, not politeness. Without it a client can send `limit=1000000` and turn a paginated
  // endpoint into a full table dump — memory pressure on the API, a huge response, and a trivially
  // cheap way to hurt the server. Every paginated endpoint needs this.
  @Max(100)
  @IsOptional()
  limit: number = 25;

  @ApiPropertyOptional({ description: 'Case-insensitive partial match' })
  @IsString()
  @MaxLength(100)
  @IsOptional()
  search?: string;

  /** Zero-based row offset for SQL. Derived, never accepted from the client. */
  get skip(): number {
    return (this.page - 1) * this.limit;
  }
}

/**
 * Assembles the `PaginatedResponse<T>` contract. Every field always present, even when `data` is
 * empty, so a consumer never has to branch on whether pagination metadata exists.
 *
 * ─── Why OFFSET, and exactly where it stops being right ──────────────────────
 *
 * `OFFSET n` makes the database PRODUCE and then DISCARD n rows. The work is proportional to the
 * offset, not the limit: `OFFSET 0 LIMIT 25` is 25 rows of work, `OFFSET 100000 LIMIT 25` is 100,025
 * rows of work for the same 25 returned. So it degrades linearly with page depth — page 1 is instant,
 * page 4,000 times out.
 *
 * Offset is still the right choice here, for reasons worth stating rather than assuming:
 *   - This dataset is tens of events, not millions. The degradation never bites.
 *   - Page NUMBERS are genuinely useful in a UI, and keyset cannot offer them.
 *   - `total` comes for free from the same `findAndCount`, so "showing 1–25 of 83" is possible.
 *
 * Keyset (cursor) pagination becomes correct when a list grows unbounded — `/me/tickets` for a heavy
 * user, or an audit log. It seeks straight to a position via the index, so page 4,000 costs the same as
 * page 1. What it costs:
 *   - No jump-to-page, only next/previous.
 *   - The sort key must be UNIQUE and stable, hence a `, id` tiebreaker. Sorting by a non-unique column
 *     alone silently SKIPS or DUPLICATES rows across page boundaries — a bug the user never sees.
 *   - No cheap total count, so no "of 83".
 */
export function buildPaginatedResponse<T>(
  data: T[],
  total: number,
  query: PaginationQueryDto,
): PaginatedResponse<T> {
  const totalPages = total === 0 ? 0 : Math.ceil(total / query.limit);

  return {
    data,
    total,
    page: query.page,
    limit: query.limit,
    totalPages,
    hasNextPage: query.page < totalPages,
    hasPreviousPage: query.page > 1,
  };
}
