import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppConfig } from '../../config/configuration';
import { jwtModuleOptions } from '../../config/jwt-module.options';
import { RealtimeModule } from '../../realtime/realtime.module';
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
      useFactory: (config: ConfigService<AppConfig, true>) => jwtModuleOptions(config),
    }),
    // For `AuthService` to force-disconnect a user's live WebSocket(s) the instant their session
    // is genuinely revoked (logout, reuse-detected theft) — TR-DEC-031. One-directional:
    // `RealtimeModule` does NOT import `AuthModule` back (it configures its own identical
    // `JwtModule` via the same `jwtModuleOptions` factory), so this stays a plain DAG.
    RealtimeModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, JwtStrategy],
  // JwtStrategy is exported so the globally registered JwtAuthGuard can resolve the 'jwt'
  // Passport strategy from anywhere in the app.
  exports: [AuthService, JwtStrategy],
})
export class AuthModule {}
