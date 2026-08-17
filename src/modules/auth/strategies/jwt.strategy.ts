import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { AppConfig } from '../../../config/configuration';
import { CurrentUserPayload } from '../../../common/decorators/current-user.decorator';
import { AccessTokenPayload } from '../auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService<AppConfig, true>) {
    super({
      // From the Authorization header, not a cookie (TR-DEC-001). This is the line that makes
      // the API CSRF-immune: a browser never attaches this header automatically, so a forged
      // cross-origin request arrives with no credentials at all. Cookie extraction would
      // require the whole CSRF apparatus back.
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),

      // Enforce `exp`. Passing `true` here would accept expired tokens — which sounds absurd
      // until you realise it is a real option people set while debugging and forget.
      ignoreExpiration: false,

      secretOrKey: config.get('auth.accessSecret', { infer: true }),

      // Pin the algorithm. Without this, the library may accept whatever the token's own
      // header claims — which is the root of two classic JWT breaks:
      //
      //   `alg: none`         — a token declaring no algorithm, verified by skipping verification.
      //   RS256 → HS256 confusion — an attacker re-signs with HS256 using the PUBLIC key as the
      //                             HMAC secret, and the public key is, by definition, public.
      //
      // Never trust the `alg` in the token you are validating. State what you expect.
      algorithms: ['HS256'],
    });
  }

  /**
   * Runs only after the signature and expiry have already verified. The payload is therefore
   * trustworthy — that is what the signature bought.
   *
   * Deliberately does NOT hit the database. The whole point of a self-contained token is that
   * authorisation needs no round trip; adding a user lookup here would put a query on every
   * authenticated request and give up that property.
   *
   * The cost is staleness: a role change is invisible until the token expires (15 minutes). A
   * `token_version` column embedded as a claim would close that for one integer compare, and is
   * the upgrade path if roles ever become mutable. For two roles that never change, the trade
   * is right.
   */
  validate(payload: AccessTokenPayload): CurrentUserPayload {
    if (!payload.sub) {
      throw new UnauthorizedException('Malformed token');
    }

    return { id: payload.sub, email: payload.email, role: payload.role };
  }
}
