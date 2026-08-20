import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

/**
 * Sortable columns, as an explicit ALLOW-LIST.
 *
 * This is not tidiness — it is the difference between a safe endpoint and SQL injection. Interpolating
 * a user-supplied string into `ORDER BY` lets an attacker append arbitrary SQL, and unlike a WHERE
 * value, ORDER BY cannot be parameterised. The allow-list is the only correct defence.
 */
const SORTABLE = ['startsAt', 'priceCents', 'createdAt', 'title'] as const;
type SortableField = (typeof SORTABLE)[number];

export class FindEventsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: SORTABLE, default: 'startsAt' })
  @IsIn(SORTABLE)
  @IsOptional()
  sortBy: SortableField = 'startsAt';

  @ApiPropertyOptional({ enum: ['ASC', 'DESC'], default: 'ASC' })
  @IsIn(['ASC', 'DESC'])
  @IsOptional()
  sortOrder: 'ASC' | 'DESC' = 'ASC';

  /**
   * Hide events that have already started. Defaults ON, because a listing of concerts that already
   * happened is not a useful default for the people this page exists for.
   *
   * The @Transform is necessary: query params are always strings, so `?upcomingOnly=false` arrives as
   * the STRING "false", which is truthy. Without this, passing false would silently mean true — one of
   * those bugs that looks like the filter is broken rather than the parsing.
   */
  @ApiPropertyOptional({ default: true })
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  @IsOptional()
  upcomingOnly: boolean = true;
}
