import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';

import { AppConfig } from '../../config/configuration';

@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);
  private readonly cost: number;

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

  async hash(plaintext: string): Promise<string> {
    return bcrypt.hash(plaintext, this.cost);
  }

  async verify(plaintext: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plaintext, hash);
  }

  async verifyDummy(plaintext: string): Promise<void> {
    await bcrypt.compare(plaintext, this.dummyHash);
  }
}
