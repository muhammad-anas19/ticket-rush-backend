import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { PaginatedResponse } from '../types/api-envelope';

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
  @Max(100)
  @IsOptional()
  limit: number = 25;

  @ApiPropertyOptional({ description: 'Case-insensitive partial match' })
  @IsString()
  @MaxLength(100)
  @IsOptional()
  search?: string;

  get skip(): number {
    return (this.page - 1) * this.limit;
  }
}

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
