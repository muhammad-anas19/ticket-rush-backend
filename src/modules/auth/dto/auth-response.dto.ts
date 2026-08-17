import { ApiProperty } from '@nestjs/swagger';

import { UserRole } from '../../users/entities/user.entity';

/** The user shape returned to clients. Note the absence of `passwordHash`. */
export class UserResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ enum: UserRole })
  role: UserRole;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;
}

/**
 * Tokens are returned in the RESPONSE BODY rather than set as httpOnly cookies (TR-DEC-001).
 *
 * The trade, in one line each:
 *   - Gives up XSS protection for the access token — client JS can read it, so it can be stolen
 *     and used from anywhere for its 15-minute lifetime. The TTL is the blast radius.
 *   - Gains CSRF immunity structurally. An Authorization header is never attached automatically
 *     by the browser, so a forged cross-origin request carries no credentials at all. P1 needed
 *     a csrf_token cookie, a CsrfGuard, an axios interceptor and two bug fixes to get the same
 *     safety with cookies.
 *
 * Only NextAuth's server side consumes this. `refreshToken` is persisted into NextAuth's
 * encrypted session cookie by the `jwt` callback and never copied into `session` (TR-DEC-018),
 * so it does not reach the browser.
 */
export class AuthResponseDto {
  @ApiProperty({ type: UserResponseDto })
  user: UserResponseDto;

  @ApiProperty({ description: 'Signed JWT. Short-lived — see JWT_ACCESS_EXPIRES_IN.' })
  accessToken: string;

  @ApiProperty({ description: 'Opaque random value. Rotates on every use.' })
  refreshToken: string;

  @ApiProperty({ description: 'Access token expiry as a Unix timestamp in milliseconds.' })
  accessTokenExpiresAt: number;
}
