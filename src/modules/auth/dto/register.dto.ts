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
  @MaxLength(72, { message: 'password must be at most 72 characters (bcrypt input limit)' })
  password: string;

  @ApiProperty({ enum: UserRole, example: UserRole.Attendee })
  @IsEnum(UserRole, { message: 'role must be organiser or attendee' })
  role: UserRole;
}
