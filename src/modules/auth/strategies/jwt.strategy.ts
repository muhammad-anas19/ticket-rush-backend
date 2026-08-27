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
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),

      ignoreExpiration: false,

      secretOrKey: config.get('auth.accessSecret', { infer: true }),

      algorithms: ['HS256'],
    });
  }

  validate(payload: AccessTokenPayload): CurrentUserPayload {
    if (!payload.sub) {
      throw new UnauthorizedException('Malformed token');
    }

    return { id: payload.sub, email: payload.email, role: payload.role };
  }
}
