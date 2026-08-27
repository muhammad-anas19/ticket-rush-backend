import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { IsNull, Repository } from 'typeorm';

import { AppConfig } from '../../config/configuration';
import { RealtimeService } from '../../realtime/realtime.service';
import { User, UserRole } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AuthResponseDto } from './dto/auth-response.dto';
import { RefreshToken, RevocationReason } from './entities/refresh-token.entity';
import { PasswordService } from './password.service';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: UserRole;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    private readonly realtime: RealtimeService,
  ) {}

  async register(email: string, password: string, role: UserRole): Promise<User> {
    const passwordHash = await this.passwords.hash(password);
    const user = await this.users.create(email, passwordHash, role);

    this.logger.log(`Registered ${user.id} as ${user.role}`);
    return user;
  }

  async login(email: string, password: string): Promise<AuthResponseDto> {
    const user = await this.users.findByEmail(email);

    if (!user) {
      await this.passwords.verifyDummy(password);
      throw new UnauthorizedException('Invalid email or password');
    }

    const valid = await this.passwords.verify(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.issueTokens(user, randomUUID());
  }

  async refresh(rawToken: string): Promise<AuthResponseDto> {
    const tokenHash = AuthService.hashToken(rawToken);
    const stored = await this.refreshTokens.findOne({ where: { tokenHash } });

    if (!stored) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    if (stored.revokedAt) {
      const graceMs = this.config.get('auth.refreshGraceSeconds', { infer: true }) * 1000;
      const elapsedMs = Date.now() - stored.revokedAt.getTime();

      if (stored.revokedReason !== RevocationReason.Rotated) {
        this.logger.warn(
          `Refresh attempted on a token revoked for cause ` +
            `(${stored.revokedReason}) — user ${stored.userId}, family ${stored.familyId}`,
        );
        throw new UnauthorizedException('Session revoked');
      }

      if (elapsedMs > graceMs) {
        await this.revokeFamily(stored.familyId, stored.userId, RevocationReason.ReuseDetected);
        this.logger.warn(
          `Refresh token reuse detected for user ${stored.userId} ` +
            `(family ${stored.familyId}, ${Math.round(elapsedMs / 1000)}s after rotation). ` +
            `Family revoked.`,
        );
        throw new UnauthorizedException('Session revoked');
      }

      this.logger.warn(
        `Refresh inside grace window for user ${stored.userId} ` +
          `(family ${stored.familyId}, ${elapsedMs}ms after rotation). Issuing a new pair.`,
      );
    }

    const user = await this.users.findById(stored.userId);
    if (!user) {
      await this.revokeFamily(stored.familyId, stored.userId, RevocationReason.Logout);
      throw new UnauthorizedException('Session revoked');
    }

    if (!stored.revokedAt) {
      stored.revokedAt = new Date();
      stored.revokedReason = RevocationReason.Rotated;
      await this.refreshTokens.save(stored);
    }

    return this.issueTokens(user, stored.familyId);
  }

  async logout(rawToken: string): Promise<void> {
    const stored = await this.refreshTokens.findOne({
      where: { tokenHash: AuthService.hashToken(rawToken) },
    });

    if (stored) {
      await this.revokeFamily(stored.familyId, stored.userId, RevocationReason.Logout);
      this.logger.log(`Logged out user ${stored.userId} (family ${stored.familyId})`);
    }
  }

  private async revokeFamily(
    familyId: string,
    userId: string,
    reason: RevocationReason,
  ): Promise<void> {
    await this.refreshTokens.update(
      { familyId, revokedAt: IsNull() },
      { revokedAt: new Date(), revokedReason: reason },
    );
    this.realtime.disconnectUser(userId);
  }

  private async issueTokens(user: User, familyId: string): Promise<AuthResponseDto> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };

    const accessToken = await this.jwt.signAsync(payload);

    const rawRefreshToken = randomBytes(32).toString('base64url');

    const refreshExpiresDays = this.config.get('auth.refreshExpiresDays', { infer: true });
    const expiresAt = new Date(Date.now() + refreshExpiresDays * 24 * 60 * 60 * 1000);

    await this.refreshTokens.save(
      this.refreshTokens.create({
        tokenHash: AuthService.hashToken(rawRefreshToken),
        familyId,
        userId: user.id,
        expiresAt,
        revokedAt: null,
        revokedReason: null,
      }),
    );

    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt,
      },
      accessToken,
      refreshToken: rawRefreshToken,
      accessTokenExpiresAt: this.accessTokenExpiryMs(),
    };
  }

  private accessTokenExpiryMs(): number {
    const raw = this.config.get('auth.accessExpiresIn', { infer: true });
    const match = /^(\d+)([smhd])$/.exec(raw);
    if (!match) {
      throw new Error(`Unparseable JWT_ACCESS_EXPIRES_IN: ${raw}`);
    }
    const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return Date.now() + parseInt(match[1], 10) * multipliers[match[2]];
  }

  private static hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }
}
