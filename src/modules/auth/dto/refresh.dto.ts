import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RefreshDto {
  /**
   * The refresh token arrives in the BODY, not a cookie and not an Authorization header
   * (TR-DEC-001).
   *
   * Consequence worth being explicit about: only NextAuth's server-side `jwt` callback ever
   * calls this endpoint, because per TR-DEC-018 the refresh token never reaches the browser at
   * all. Browser JavaScript could not call this even if it wanted to — it does not have the
   * value.
   */
  @ApiProperty({ description: 'Opaque refresh token issued by /auth/login or /auth/refresh' })
  @IsString()
  @MinLength(1)
  refreshToken: string;
}
