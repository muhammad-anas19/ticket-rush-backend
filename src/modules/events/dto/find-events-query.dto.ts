import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

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

  @ApiPropertyOptional({ default: true })
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  @IsOptional()
  upcomingOnly: boolean = true;
}
