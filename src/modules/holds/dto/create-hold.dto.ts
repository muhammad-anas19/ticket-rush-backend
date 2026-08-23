import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class CreateHoldDto {
  /**
   * Capped at 10, not because the domain needs it, but because an uncapped quantity turns this
   * endpoint into a single-request inventory drain: one call with `quantity: 100000` against a
   * 250-seat event either 400s cleanly here or, without this cap, legitimately holds the entire
   * house in one shot. `TR-DEC-004` deferred *rate limiting* (repeated abuse over time) — this is a
   * narrower, free check on a single request's shape, not a substitute for it.
   */
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 10 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  @IsOptional()
  quantity: number = 1;
}
