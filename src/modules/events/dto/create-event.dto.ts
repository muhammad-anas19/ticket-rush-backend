import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateEventDto {
  @ApiProperty({ example: 'Karachi Jazz Night', maxLength: 200 })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title: string;

  @ApiProperty({ required: false, example: 'An evening of live jazz.' })
  @IsString()
  @MaxLength(5000)
  @IsOptional()
  description?: string;

  @ApiProperty({ example: 'Arts Council Auditorium' })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  venue: string;

  @ApiProperty({ example: '2026-09-01T20:00:00.000Z', description: 'ISO 8601, with offset or Z' })
  @IsDateString({ strict: true })
  startsAt: string;

  @ApiProperty({ example: 1999, description: 'Price in cents (integer minor units)' })
  @Type(() => Number)
  @IsInt({ message: 'priceCents must be an integer number of cents, never a decimal' })
  @Min(0)
  @Max(2_147_483_647)
  priceCents: number;

  @ApiProperty({ example: 250, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  totalTickets: number;
}
