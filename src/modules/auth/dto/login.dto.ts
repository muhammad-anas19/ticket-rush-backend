import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Deliberately a separate class from RegisterDto rather than a Pick/Omit of it.
 *
 * Reusing one loose DTO for both is the shortcut that lets an invalid partial payload through
 * whichever endpoint has weaker requirements. Note also what is absent: no `role`. A client
 * cannot influence their role at login, and `forbidNonWhitelisted` rejects the attempt outright
 * rather than ignoring it.
 */
export class LoginDto {
  @ApiProperty({ example: 'organiser@example.com' })
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(255)
  email: string;

  @ApiProperty({ example: 'correct-horse-battery-staple' })
  @IsString()
  @MinLength(1)
  @MaxLength(72)
  password: string;
}
