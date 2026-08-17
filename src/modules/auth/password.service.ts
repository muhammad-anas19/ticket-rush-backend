import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';

import { AppConfig } from '../../config/configuration';

/**
 * Password hashing (TR-DEC-016: bcrypt, cost 12, no pepper).
 *
 * Isolated in its own service so the algorithm is swappable in one file, and so it can be
 * mocked in unit tests — hashing at cost 12 across a suite that creates users costs minutes
 * of real CPU.
 */
@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);
  private readonly cost: number;

  /**
   * A real bcrypt hash of a throwaway value, generated once at boot.
   *
   * Used to burn equivalent CPU when an email does not exist — see `verifyDummy()` below.
   */
  private readonly dummyHash: string;

  constructor(config: ConfigService<AppConfig, true>) {
    this.cost = config.get('auth.bcryptCost', { infer: true });
    this.dummyHash = bcrypt.hashSync('a-password-that-is-never-correct', this.cost);

    if (this.cost < 10) {
      this.logger.warn(
        `BCRYPT_COST is ${this.cost}, below the recommended minimum of 10. Acceptable for ` +
          `tests; never for anything reachable by real traffic.`,
      );
    }
  }

  /**
   * bcrypt generates its own random salt per hash and embeds it in the output string, so
   * there is nothing to store separately. The salt defeats rainbow tables and stops two users
   * with the same password producing the same hash — which would otherwise leak that fact to
   * anyone who read the table.
   *
   * No pepper, deliberately. bcrypt silently truncates input at 72 BYTES, so naive
   * concatenation of a pepper onto a long passphrase can push the real password past the
   * boundary and weaken it with no error anywhere. The safe pattern is
   * bcrypt(HMAC-SHA256(password, pepper)) — 64 hex chars, fits — but it is a sharp edge for
   * no meaningful benefit at this scale.
   */
  async hash(plaintext: string): Promise<string> {
    return bcrypt.hash(plaintext, this.cost);
  }

  /**
   * bcrypt.compare re-derives the hash using the salt and cost embedded in `hash`, then
   * compares in constant time. Constant-time matters: a naive `===` on hash strings leaks
   * information through how early it returns.
   */
  async verify(plaintext: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plaintext, hash);
  }

  /**
   * Burns the same CPU as a real verification, for use when the email does not exist.
   *
   * Without this, login is a user-enumeration oracle: a request for an unknown address returns
   * in 2ms while a known one takes 250ms, so an attacker with a wordlist learns exactly which
   * addresses are registered — without ever guessing a password. Generic error messages alone
   * do not close that; the TIMING is the leak.
   *
   * The unavoidable tension, worth knowing because it is a favourite follow-up: this makes the
   * DoS on `POST /auth/login` strictly worse. The endpoint is unauthenticated and now spends
   * 250ms of CPU on *every* request, valid email or not, before it can reject anything. Cheap
   * for the attacker, expensive for us.
   *
   * There is no clean resolution — you accept both and put RATE LIMITING in front, which is
   * the layer that actually addresses it. Rate limiting was cut from scope in TR-DEC-004 and
   * is recorded as an M8 security-review finding, so right now this is a known open exposure
   * rather than a solved problem.
   */
  async verifyDummy(plaintext: string): Promise<void> {
    await bcrypt.compare(plaintext, this.dummyHash);
  }
}
