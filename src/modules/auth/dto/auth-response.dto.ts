import { ApiProperty } from '@nestjs/swagger';

import { UserRole } from '../../users/entities/user.entity';

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
