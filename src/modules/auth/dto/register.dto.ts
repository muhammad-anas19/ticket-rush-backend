import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsString, MaxLength, MinLength } from 'class-validator';

import { UserRole } from '../../users/entities/user.entity';

export class RegisterDto {
  @ApiProperty({ example: 'organiser@example.com' })
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(255)
  email: string;

  @ApiProperty({ example: 'correct-horse-battery-staple', minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters' })
  // 72 is not an arbitrary limit — it is bcrypt's input boundary. Anything past 72 BYTES is
  // silently ignored, so a 100-character passphrase is no stronger than its first 72 and the
  // user is never told. Rejecting explicitly is far better than accepting and truncating:
  // the user knows, and nobody later believes a longer password bought them something.
  @MaxLength(72, { message: 'password must be at most 72 characters (bcrypt input limit)' })
  password: string;

  /**
   * Self-selected, and safe here only for the specific reason in TR-DEC-003: organiser is a
   * different capability, not a higher privilege. An organiser can create their own events and
   * gains no access to anyone else's data.
   *
   * This is the ONE place in the project where a client-supplied field decides an authorisation
   * attribute, and it is a deliberate exception. In most systems accepting a role from the
   * request body is textbook privilege escalation — and note the global ValidationPipe's
   * `forbidNonWhitelisted` is what stops a client sneaking `role` into endpoints that do NOT
   * declare it.
   */
  @ApiProperty({ enum: UserRole, example: UserRole.Attendee })
  @IsEnum(UserRole, { message: 'role must be organiser or attendee' })
  role: UserRole;
}
