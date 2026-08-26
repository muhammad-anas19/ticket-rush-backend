import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { AppConfig } from '../config/configuration';
import { jwtModuleOptions } from '../config/jwt-module.options';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';

/**
 * Registers its OWN `JwtModule`, via the shared `jwtModuleOptions` factory, rather than
 * importing `AuthModule` for one — `AuthModule` now imports `RealtimeModule` (to force-disconnect
 * a user's sockets on revocation, `TR-DEC-031`), and the reverse import would make this a cycle.
 * Both modules still agree on exactly what makes a token valid, because both call the same
 * factory function; neither needs to import the other to guarantee that.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => jwtModuleOptions(config),
    }),
  ],
  providers: [RealtimeGateway, RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
