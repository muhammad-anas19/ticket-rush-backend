import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';

import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import configuration from './config/configuration';
import { validate } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { UsersModule } from './modules/users/users.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      // Runs at bootstrap. Throws — and so exits non-zero — before anything else is
      // constructed and long before the HTTP server binds a port.
      validate,
      // In production the platform injects real environment variables; there is no file to
      // read, and looking for one that isn't there is not an error.
      ignoreEnvFile: process.env.NODE_ENV === 'production',
      // Config is read once at boot. Re-reading process.env on every access would make the
      // running app's behaviour depend on something mutable at runtime.
      cache: true,
    }),

    DatabaseModule,
    RedisModule,
    HealthModule,

    UsersModule,
    AuthModule,

    // M2: EventsModule
    // M3: HoldsModule
    // M5: OrdersModule, StripeModule
    // M6: MessagingModule, TicketsModule
    // M7: RealtimeModule
  ],
  providers: [
    /**
     * Guards registered globally, and the ORDER matters.
     *
     * Global guards run in registration order, so authentication resolves `request.user` before
     * authorisation tries to read it. Swap these two lines and RolesGuard sees no user on every
     * request — which it would report as 403 "Authentication required", sending you hunting for
     * a token problem that does not exist.
     *
     * Registering globally rather than per-route is a fail-CLOSED choice. Every endpoint requires
     * a valid token unless it carries `@Public()`. The alternative — `@UseGuards(JwtAuthGuard)`
     * on each protected route — fails OPEN: forget it once and that endpoint is silently
     * unauthenticated, with no failing test and no error to notice. Here, forgetting `@Public()`
     * returns 401 to everybody, which you find in ten seconds.
     *
     * Using APP_GUARD providers rather than `app.useGlobalGuards()` in main.ts, because these
     * guards need dependency injection — both take `Reflector` — and guards registered from
     * main.ts are instantiated outside the DI container.
     */
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
