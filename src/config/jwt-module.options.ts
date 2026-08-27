import { JwtModuleOptions } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

import { AppConfig } from './configuration';

export function jwtModuleOptions(config: ConfigService<AppConfig, true>): JwtModuleOptions {
  return {
    secret: config.get('auth.accessSecret', { infer: true }),
    signOptions: {
      expiresIn: config.get('auth.accessExpiresIn', { infer: true }),
      algorithm: 'HS256',
    },
  };
}
