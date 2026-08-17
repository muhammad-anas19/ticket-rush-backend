import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppConfig } from '../../config/configuration';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RefreshToken } from './entities/refresh-token.entity';
import { PasswordService } from './password.service';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    UsersModule,
    TypeOrmModule.forFeature([RefreshToken]),
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        secret: config.get('auth.accessSecret', { infer: true }),
        signOptions: {
          expiresIn: config.get('auth.accessExpiresIn', { infer: true }),
          // Stated explicitly rather than relying on the library default, so the signing and
          // verifying sides visibly agree. JwtStrategy pins the same value — the whole point of
          // pinning is that it is not inferred from the token being validated.
          algorithm: 'HS256',
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, JwtStrategy],
  // JwtStrategy is exported so the globally registered JwtAuthGuard can resolve the 'jwt'
  // Passport strategy from anywhere in the app.
  exports: [AuthService, JwtStrategy],
})
export class AuthModule {}
