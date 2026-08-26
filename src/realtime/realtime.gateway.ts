import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

import { AppConfig } from '../config/configuration';
import { AccessTokenPayload } from '../modules/auth/auth.service';
import { SubscribeEventDto } from './dto/subscribe-event.dto';
import { RealtimeService } from './realtime.service';

/** What `JwtService.verifyAsync()` actually hands back — the signed claims plus the standard
 * registered ones `jsonwebtoken` adds itself. `AccessTokenPayload` alone (what `AuthService`
 * signs) doesn't declare `exp`, but it's always present on anything that verified successfully —
 * `verifyAsync` checks it, and would have thrown already if it were missing or in the past. */
type VerifiedAccessToken = AccessTokenPayload & { exp: number };

/**
 * `TR-DEC-013`: the connection is authenticated ONCE, at the handshake, with the same access
 * token every REST call already uses — never re-checked per MESSAGE. That much is unchanged.
 *
 * What changed (`TR-DEC-031`): the connection itself is no longer trusted forever just because
 * the handshake once passed. Two independent mechanisms close the "unbounded exposure" gap a
 * REST endpoint never has, since a REST call re-verifies expiry on every single request and a
 * WebSocket, absent this, never gets a second look:
 *
 *   1. EXPIRY is enforced on a timer, scheduled from the token's own `exp` claim at connect
 *      time — the socket is force-closed at the exact moment the ORIGINAL token would have
 *      stopped being honoured by a REST call, never later.
 *   2. REVOCATION (logout, reuse-detected theft) is propagated immediately: every socket joins
 *      a private `user:{userId}` room at connect time, and `AuthService` tells
 *      `RealtimeService.disconnectUser()` to close that room's sockets the instant a session is
 *      actually killed — not up to 15 minutes later.
 *
 * CORS read directly from `process.env` rather than injected `ConfigService`, because
 * `@WebSocketGateway()`'s options are evaluated as decorator arguments at class-definition time —
 * before Nest's DI container exists to inject anything into. Safe here specifically because
 * `AppModule` imports `DatabaseModule` (which loads `.env` via `database/data-source.ts`'s
 * top-level `dotenv.config()`) before this module in its own import list, so `process.env` is
 * already populated by the time this file's decorator evaluates.
 */
@WebSocketGateway({
  cors: {
    origin: process.env.CORS_ORIGIN,
    credentials: true,
  },
})
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly realtime: RealtimeService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Hands the real `Server` instance to `RealtimeService` — the seam every domain service
   * actually depends on. The `Server` object only exists once Socket.IO has finished attaching
   * to the HTTP server, which is exactly what this lifecycle hook signals.
   */
  afterInit(server: Server): void {
    this.realtime.setServer(server);
    this.logger.log('WebSocket gateway initialised');
  }

  /**
   * The entire authentication story for this gateway: verify once, here, or refuse the
   * connection outright. `client.handshake.auth.token` — not a query string, not a URL param —
   * because a query string is the single most common place a credential ends up copied into
   * server access logs and browser history by accident.
   */
  async handleConnection(client: Socket): Promise<void> {
    const token = client.handshake.auth?.token as string | undefined;

    if (!token) {
      this.logger.warn(`Connection ${client.id} rejected — no token in handshake`);
      client.disconnect(true);
      return;
    }

    try {
      const payload = await this.jwt.verifyAsync<VerifiedAccessToken>(token, {
        secret: this.config.get('auth.accessSecret', { infer: true }),
        algorithms: ['HS256'],
      });
      client.data.userId = payload.sub;

      // Every socket's own private mailbox — the target `RealtimeService.disconnectUser()`
      // reaches. Joined unconditionally, not on request, since a user never opts out of their
      // own session being revocable.
      await client.join(`user:${payload.sub}`);

      this.scheduleExpiryDisconnect(client, payload.exp);
    } catch (error) {
      this.logger.warn(
        `Connection ${client.id} rejected — invalid token: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      client.disconnect(true);
    }
  }

  /**
   * `TR-DEC-031`, mechanism 1: bounds this connection's lifetime to the EXACT instant its
   * verifying token stops being valid — the same instant a REST call presenting that token would
   * start getting 401s. `exp` is Unix seconds; `Date.now()` is milliseconds.
   *
   * The timer is stashed on `client.data` so `handleDisconnect` can cancel it if the socket goes
   * away on its own first (a normal close, a network drop) — without that, a socket that
   * connects and disconnects a thousand times leaves a thousand scheduled timers moving through
   * the event loop's timer queue for however long the longest-lived token had left, each one a
   * no-op by the time it fires (`disconnect()` on an already-gone socket does nothing harmful),
   * but pure waste that a busy server has no reason to carry.
   */
  private scheduleExpiryDisconnect(client: Socket, expUnixSeconds: number): void {
    const msUntilExpiry = expUnixSeconds * 1000 - Date.now();

    client.data.expiryTimer = setTimeout(() => {
      this.logger.debug(`Connection ${client.id} disconnected — its token's own expiry passed`);
      client.emit('session:expired');
      client.disconnect(true);
    }, msUntilExpiry);
  }

  /**
   * Cancels the expiry timer above — the only cleanup a disconnect needs. Socket.IO removes a
   * disconnected socket from every room it was in automatically, so there is no manual
   * room-membership cleanup this project needs to write.
   */
  handleDisconnect(client: Socket): void {
    clearTimeout(client.data.expiryTimer as NodeJS.Timeout | undefined);
    this.logger.debug(`Connection ${client.id} disconnected`);
  }

  /**
   * `concepts/07-…md` §3: a room per event, joined explicitly by whoever is actually looking at
   * that event's page — never a blanket "everyone gets everything" broadcast.
   */
  @SubscribeMessage('subscribe:event')
  handleSubscribe(@ConnectedSocket() client: Socket, @MessageBody() body: SubscribeEventDto): void {
    void client.join(`event:${body.eventId}`);
  }

  @SubscribeMessage('unsubscribe:event')
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: SubscribeEventDto,
  ): void {
    void client.leave(`event:${body.eventId}`);
  }
}
