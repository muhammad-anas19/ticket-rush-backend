import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { IsNull, Repository } from 'typeorm';

import { AppConfig } from '../../config/configuration';
import { User, UserRole } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AuthResponseDto } from './dto/auth-response.dto';
import { RefreshToken } from './entities/refresh-token.entity';
import { PasswordService } from './password.service';

/** Claims carried in the access token. Readable by anyone — signed, not encrypted. */
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
  ) {}

  async register(email: string, password: string, role: UserRole): Promise<AuthResponseDto> {
    const passwordHash = await this.passwords.hash(password);
    // Throws 409 on the unique constraint. Registration necessarily reveals that an address is
    // taken — the user has to be told why it failed. Login is where enumeration is prevented.
    const user = await this.users.create(email, passwordHash, role);

    this.logger.log(`Registered ${user.id} as ${user.role}`);
    return this.issueTokens(user, randomUUID());
  }

  async login(email: string, password: string): Promise<AuthResponseDto> {
    const user = await this.users.findByEmail(email);

    if (!user) {
      // Burn equivalent CPU before failing.
      //
      // Returning immediately here would make login a timing oracle: unknown address responds
      // in ~2ms, known address in ~250ms, so an attacker with a wordlist maps registered users
      // without guessing a single password. A generic error MESSAGE does not close that — the
      // timing is the leak, and it is measurable over a network.
      //
      // Cost: this makes the DoS on this endpoint worse, since every request now pays for a
      // hash. Rate limiting is the layer that resolves it, and TR-DEC-004 cut it. Known,
      // recorded, open.
      await this.passwords.verifyDummy(password);
      throw new UnauthorizedException('Invalid email or password');
    }

    const valid = await this.passwords.verify(password, user.passwordHash);
    if (!valid) {
      // Identical message and identical timing to the unknown-email branch. The caller cannot
      // tell which of the two failed, which is the entire point.
      throw new UnauthorizedException('Invalid email or password');
    }

    // A new family per login: each device/session gets an independent chain, so revoking one
    // compromised session does not log the user out of the others.
    return this.issueTokens(user, randomUUID());
  }

  /**
   * Rotate a refresh token.
   *
   * Three outcomes, and the middle one is TR-DEC-017:
   *
   *   live token          → rotate normally
   *   spent, within grace → rotate anyway, log a warning  (legitimate client, lost response
   *                         or parallel refresh)
   *   spent, past grace   → REUSE DETECTED, revoke the whole family
   */
  async refresh(rawToken: string): Promise<AuthResponseDto> {
    const tokenHash = AuthService.hashToken(rawToken);
    const stored = await this.refreshTokens.findOne({ where: { tokenHash } });

    if (!stored) {
      // Never issued, or issued so long ago it was pruned. Nothing to revoke — there is no
      // family to attribute this to, so this is not evidence of theft, just an invalid token.
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    if (stored.revokedAt) {
      const graceMs = this.config.get('auth.refreshGraceSeconds', { infer: true }) * 1000;
      const elapsedMs = Date.now() - stored.revokedAt.getTime();

      if (elapsedMs > graceMs) {
        // Past the window. Treat as theft.
        //
        // Revoke the whole FAMILY, not just this token: whoever replayed this already has its
        // successor, so killing one link achieves nothing. Ending the chain is the only response
        // that actually terminates a compromised session.
        //
        // This does log out the legitimate user too. That is the correct tradeoff — a session
        // that may be compromised should end, and the cost is one re-login.
        await this.revokeFamily(stored.familyId);
        this.logger.warn(
          `Refresh token reuse detected for user ${stored.userId} ` +
            `(family ${stored.familyId}, ${Math.round(elapsedMs / 1000)}s after rotation). ` +
            `Family revoked.`,
        );
        throw new UnauthorizedException('Session revoked');
      }

      // Inside the window — almost certainly legitimate.
      //
      // Either the response carrying the replacement never arrived (sleeping laptop, dropped
      // connection) or several NextAuth `jwt` callbacks refreshed concurrently and this one
      // lost the race. Both are indistinguishable from theft on the wire, so we choose which
      // error to prefer: a false logout is a certain harm to a real user, a 30-second replay
      // window is a bounded risk.
      //
      // Logged at warn, not silently: a spike here means something is wrong with the client's
      // refresh coordination, and you want to see it.
      this.logger.warn(
        `Refresh inside grace window for user ${stored.userId} ` +
          `(family ${stored.familyId}, ${elapsedMs}ms after rotation). Issuing a new pair.`,
      );
    }

    const user = await this.users.findById(stored.userId);
    if (!user) {
      // The user was deleted while a live session existed.
      await this.revokeFamily(stored.familyId);
      throw new UnauthorizedException('Session revoked');
    }

    // Mark spent BEFORE issuing the replacement, so a crash between the two leaves the old
    // token dead rather than leaving two live tokens.
    //
    // Not yet transactional: `revokedAt` and the new row are two statements. If the process
    // dies between them the family has no live token and the user must log in again — annoying,
    // not incorrect. Wrapping both in one transaction is the right fix and is exactly the
    // discipline M3 makes non-negotiable, where the failure mode is oversold tickets rather
    // than an extra login.
    if (!stored.revokedAt) {
      stored.revokedAt = new Date();
      await this.refreshTokens.save(stored);
    }

    return this.issueTokens(user, stored.familyId);
  }

  /** Revokes every live token in the family — the "log out" path. */
  async logout(rawToken: string): Promise<void> {
    const stored = await this.refreshTokens.findOne({
      where: { tokenHash: AuthService.hashToken(rawToken) },
    });

    // Deliberately does not throw on an unknown token. Logout must be idempotent: a client
    // retrying, or logging out twice, should not see an error for an action whose goal —
    // "this session is gone" — is already satisfied.
    if (stored) {
      await this.revokeFamily(stored.familyId);
      this.logger.log(`Logged out user ${stored.userId} (family ${stored.familyId})`);
    }
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.refreshTokens.update(
      { familyId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  }

  private async issueTokens(user: User, familyId: string): Promise<AuthResponseDto> {
    const payload: AccessTokenPayload = {
      // `sub` is the registered JWT claim for subject. Using the standard name rather than
      // `userId` means any JWT tooling understands it.
      sub: user.id,
      email: user.email,
      // Embedded, so authorisation needs no database read — at the cost of going stale until
      // the token expires. Deliberate: 15 minutes of staleness on a two-value role that changes
      // essentially never. A token_version column would make it immediate for one integer
      // compare, and is the upgrade path if roles ever become mutable.
      role: user.role,
    };

    const accessToken = await this.jwt.signAsync(payload);

    // 32 bytes from a CSPRNG. NOT a JWT — there is nothing to read in a refresh token, so
    // signing it would only add size. Opaque means the server is the sole authority on whether
    // it is valid, which is exactly what makes revocation possible.
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
      // Given to the client so NextAuth's `jwt` callback can refresh proactively instead of
      // waiting for a 401. Decoding the JWT to find `exp` would work too, but handing it over
      // means the client never has to parse a token it should treat as opaque.
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

  /**
   * SHA-256, hex. A FAST hash, and that is correct.
   *
   * The token is 32 bytes of CSPRNG output — there is no guessable structure, so there is
   * nothing for a slow hash to slow down. bcrypt here would spend 250ms of CPU on every refresh
   * and buy precisely nothing. Slow hashes exist for LOW-ENTROPY secrets, where the attack is
   * guessing. Being able to state that distinction is the point.
   *
   * Hashed at all so a database dump does not hand over working sessions.
   */
  private static hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }
}
