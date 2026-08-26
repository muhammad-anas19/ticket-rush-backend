import { JwtModuleOptions } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

import { AppConfig } from './configuration';

/**
 * The ONE place `JwtModule`'s secret/algorithm/expiry are configured — used by both `AuthModule`
 * (signs and verifies REST access tokens) and `RealtimeModule` (verifies the same tokens at the
 * WebSocket handshake, `TR-DEC-013`).
 *
 * Extracted specifically to avoid a circular module dependency: `AuthModule` needs
 * `RealtimeService` (to force-disconnect a user's live sockets on logout/revocation —
 * `TR-DEC-031`), and `RealtimeModule` needs a `JwtService` configured identically to the REST
 * API's. Having `RealtimeModule` import `AuthModule` for that (the original design) would create
 * `AuthModule → RealtimeModule → AuthModule`. Both modules instead register their OWN
 * `JwtModule.registerAsync()` using this SAME factory, so there is still exactly one place that
 * defines what makes a token valid — just not one that either module needs to import from the
 * other to share.
 */
export function jwtModuleOptions(config: ConfigService<AppConfig, true>): JwtModuleOptions {
  return {
    secret: config.get('auth.accessSecret', { infer: true }),
    signOptions: {
      expiresIn: config.get('auth.accessExpiresIn', { infer: true }),
      // Stated explicitly rather than relying on the library default, so the signing and
      // verifying sides visibly agree — pinned identically wherever a token is checked.
      algorithm: 'HS256',
    },
  };
}
