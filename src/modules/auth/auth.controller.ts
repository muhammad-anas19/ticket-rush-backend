import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser, CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { AuthResponseDto, UserResponseDto } from './dto/auth-response.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { UsersService } from '../users/users.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Register',
    description:
      'Creates an account and returns tokens immediately. The role is self-selected — safe ' +
      'here because organiser is a different capability, not a higher privilege (TR-DEC-003).',
  })
  @ApiResponse({ status: 201, type: AuthResponseDto })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  async register(@Body() dto: RegisterDto): Promise<AuthResponseDto> {
    return this.auth.register(dto.email, dto.password, dto.role);
  }

  @Public()
  @Post('login')
  // 200, not 201. Login does not create a resource — it creates a session, which is not a thing
  // you can GET at a URL. 201 would imply a Location header pointing at something.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Log in',
    description:
      'Returns tokens in the response BODY, not as cookies (TR-DEC-001). Only NextAuth\'s ' +
      'server side consumes this; the refresh token never reaches the browser (TR-DEC-018).',
  })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({
    status: 401,
    description:
      'Invalid email or password. Deliberately identical for both causes, and matched in ' +
      'timing too — an unknown email still costs a full bcrypt comparison, so response time ' +
      'cannot be used to enumerate registered addresses.',
  })
  async login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.auth.login(dto.email, dto.password);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate the refresh token',
    description:
      'Public because the access token is expected to be EXPIRED when this is called — ' +
      'requiring a valid one would make the endpoint useless. The refresh token in the body ' +
      'is the credential. Rotates on every use; an already-rotated token is accepted within ' +
      'REFRESH_GRACE_SECONDS (TR-DEC-017) and treated as theft after that, revoking the family.',
  })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid, expired, or revoked token' })
  async refresh(@Body() dto: RefreshDto): Promise<AuthResponseDto> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Log out',
    description:
      'Revokes every live token in the family. Idempotent — an unknown token still returns ' +
      '200, because a client retrying a logout should not see an error for a state it has ' +
      'already reached.',
  })
  async logout(@Body() dto: RefreshDto): Promise<{ loggedOut: true }> {
    await this.auth.logout(dto.refreshToken);
    return { loggedOut: true };
  }

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Current user',
    description:
      'Reads from the database rather than echoing the token, so a client sees current data ' +
      'rather than a 15-minute-old snapshot of it.',
  })
  @ApiResponse({ status: 200, type: UserResponseDto })
  @ApiResponse({ status: 401, description: 'Missing, malformed, or expired token' })
  async me(@CurrentUser() current: CurrentUserPayload): Promise<UserResponseDto> {
    // Note: NOT built from the token's claims. The token carries email and role for cheap
    // authorisation, but /me is the one place a client legitimately asks "what is true now" —
    // and answering from a token issued up to 15 minutes ago would report stale data as fact.
    const user = await this.users.findByIdOrFail(current.id);
    return { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt };
  }
}
