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

  /**
   * Must be an ISO 8601 string, and the client should include an explicit offset or `Z`.
   *
   * Sending a bare `2026-09-01 20:00` makes Postgres guess the zone using the SERVER's setting — so the
   * app works on a laptop in Karachi and is five hours wrong in production on a UTC host. JavaScript
   * makes the right thing easy: `new Date().toISOString()` always produces a `Z`-suffixed UTC string.
   */
  @ApiProperty({ example: '2026-09-01T20:00:00.000Z', description: 'ISO 8601, with offset or Z' })
  @IsDateString({ strict: true })
  startsAt: string;

  /**
   * Integer MINOR UNITS — cents, not currency. `1999` means $19.99.
   *
   * Never a float: binary floating point cannot represent 0.1, so `0.1 + 0.2` is 0.30000000000000004,
   * errors accumulate across thousands of rows, and `WHERE amount = 19.99` matches nothing because the
   * stored value is 19.989999999999998.
   *
   * The frontend converts currency to cents in exactly one place, with a test. A bug in that conversion
   * shows up as a 100× price error — which is at least loud.
   */
  @ApiProperty({ example: 1999, description: 'Price in cents (integer minor units)' })
  @Type(() => Number)
  @IsInt({ message: 'priceCents must be an integer number of cents, never a decimal' })
  @Min(0)
  // ~$21m per ticket. A sanity ceiling: a fat-fingered extra zero is caught here rather than at Stripe.
  @Max(2_147_483_647)
  priceCents: number;

  @ApiProperty({ example: 250, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  totalTickets: number;

  /**
   * Note what is ABSENT from this DTO, and that the absence is enforced rather than trusted:
   *
   *   organiserId       — comes from the verified token, never the body. Accepting it would let anyone
   *                       create events owned by someone else.
   *   ticketsCommitted  — server-owned. Accepting it would let a client fabricate availability.
   *   id, createdAt     — server-owned.
   *
   * The global `ValidationPipe` runs with `forbidNonWhitelisted: true`, so a client sending
   * `organiserId` gets a 400 telling them the property should not exist — rejected, not silently
   * dropped. Silently dropping is worse: the client believes it worked.
   */
}
