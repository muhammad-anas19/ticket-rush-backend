import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { io, Socket } from 'socket.io-client';

import { AppModule } from '../../app.module';
import { AppConfig } from '../../config/configuration';
import { RedisIoAdapter } from '../redis-io.adapter';
import { RealtimeService } from '../realtime.service';

/**
 * A real, listening Nest application — not a `TestingModule` unit harness — because the entire
 * point is proving what actually crosses the wire: a genuine WebSocket upgrade handshake, a
 * genuine JWT check, a genuine `Server.to(room).emit()` delivered to a genuine `socket.io-client`
 * connection. `concepts/07-websockets-and-realtime.md` §4/§5's claims are about real Socket.IO/
 * Redis behaviour, and a mocked gateway would prove nothing about either.
 *
 * The cross-PROCESS half of the checkpoint (`docs/phases.md` M7: "run the API on ports 3000 and
 * 3001... two browser tabs... instance B's tab doesn't update... add the redis-adapter... watch
 * it work") is deliberately NOT reproduced here as an automated test — it needs two independent
 * `node` processes to demonstrate the failure mode honestly, and was run and confirmed manually
 * (see the M7 walkthrough for the actual transcript). What IS covered here, permanently and
 * repeatably: the handshake auth decision (`TR-DEC-013`) and that a broadcast issued through
 * `RealtimeService` actually reaches a subscribed client over a real socket.
 */
describe('RealtimeGateway — handshake auth, room delivery, and session revocation (TR-DEC-013, TR-DEC-031)', () => {
  let app: INestApplication;
  let redisIoAdapter: RedisIoAdapter;
  let port: number;
  let validToken: string;
  let jwt: JwtService;
  let jwtSecret: string;

  /**
   * Minted directly with the app's OWN configured secret, rather than a real register/login HTTP
   * round trip — this suite's job is the gateway's handshake/expiry/revocation behaviour, not the
   * auth module's own token-issuing correctness (that's M1's test surface). `expiresIn` defaults
   * to the real configured lifetime; the expiry test below overrides it to something a test can
   * actually wait out.
   */
  function mintToken(sub: string, expiresIn: '15m' | '1s' = '15m'): Promise<string> {
    return jwt.signAsync(
      { sub, email: `${sub}@example.com`, role: 'attendee' },
      { secret: jwtSecret, algorithm: 'HS256', expiresIn },
    );
  }

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api', { exclude: ['health', 'health/{*path}'] });

    const config = app.get(ConfigService<AppConfig, true>);
    redisIoAdapter = new RedisIoAdapter(
      app,
      config.get('redis.host', { infer: true }),
      config.get('redis.port', { infer: true }),
    );
    await redisIoAdapter.connectToRedis();
    app.useWebSocketAdapter(redisIoAdapter);

    await app.listen(0); // ephemeral port — this suite never competes with a real dev server
    port = (app.getHttpServer().address() as { port: number }).port;

    jwt = app.get(JwtService);
    jwtSecret = config.get('auth.accessSecret', { infer: true });
    validToken = await mintToken('test-user-id');
  });

  afterAll(async () => {
    await app.close();
    // See `RedisIoAdapter.dispose()` — its two pub/sub connections aren't Nest-managed, so
    // `app.close()` alone leaves them open and this Jest worker hanging past every test passing.
    await redisIoAdapter.dispose();
  });

  function connect(auth?: Record<string, unknown>): Socket {
    return io(`http://localhost:${port}`, {
      auth,
      transports: ['websocket'],
      reconnection: false,
    });
  }

  /**
   * Every guard timer in this suite is cleared the instant the awaited event actually fires —
   * without that, a passing test still leaves its `setTimeout` pending for the full 3s, and Jest
   * reports a false "open handle" warning (or, in a fast test run, an ACTUALLY-still-pending
   * timer) purely from cleanup hygiene, not from anything wrong with the gateway.
   */
  function waitForEvent<T>(emitter: Socket, event: string, timeoutMs = 3000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`"${event}" never fired`)), timeoutMs);
      emitter.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  it('rejects a connection with no token', async () => {
    const socket = connect();

    // Socket.IO's own 'connect' fires once the TRANSPORT handshake succeeds, BEFORE
    // `RealtimeGateway.handleConnection()` (the application-level auth check) has run — so the
    // meaningful assertion is that the server terminates it immediately after, not that
    // 'connect' never fires at all.
    const disconnectReason = await waitForEvent<string>(socket, 'disconnect');

    expect(disconnectReason).toBe('io server disconnect');
    socket.disconnect();
  });

  it('rejects a connection with a malformed token', async () => {
    const socket = connect({ token: 'not-a-real-jwt' });

    const disconnectReason = await waitForEvent<string>(socket, 'disconnect');

    expect(disconnectReason).toBe('io server disconnect');
    socket.disconnect();
  });

  it('accepts a connection with a valid token and stays connected', async () => {
    const socket = connect({ token: validToken });

    await waitForEvent(socket, 'connect');

    // Give it a beat — a token that FAILS verification disconnects within milliseconds (see the
    // two tests above); staying connected past that window is the actual proof of acceptance.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(socket.connected).toBe(true);

    socket.disconnect();
  });

  it('delivers a broadcast to a client subscribed to the matching room, and nowhere else', async () => {
    const watchingSocket = connect({ token: validToken });
    const uninterestedSocket = connect({ token: validToken });

    await Promise.all([
      waitForEvent(watchingSocket, 'connect'),
      waitForEvent(uninterestedSocket, 'connect'),
    ]);

    // Real, version-4-shaped UUIDs — `SubscribeEventDto`'s `@IsUUID()` validates the version
    // nibble too, so a hand-typed placeholder like `aaaaaaaa-aaaa-…` is NOT a valid UUID and
    // gets silently rejected by the gateway's `ValidationPipe`, which is exactly the bug this
    // test caught the first time it ran: the socket never actually joined the room, and the
    // "delivered" assertion below timed out for a reason that had nothing to do with the
    // gateway or the adapter.
    const eventIdBeingWatched = randomUUID();
    const otherEventId = randomUUID();

    watchingSocket.emit('subscribe:event', { eventId: eventIdBeingWatched });
    uninterestedSocket.emit('subscribe:event', { eventId: otherEventId });
    await new Promise((resolve) => setTimeout(resolve, 200));

    let uninterestedGotSomething = false;
    uninterestedSocket.on('availability', () => {
      uninterestedGotSomething = true;
    });

    const received = waitForEvent<{
      eventId: string;
      ticketsRemaining: number;
      isSoldOut: boolean;
    }>(watchingSocket, 'availability');

    // The exact call every domain write path (`HoldsService`, `PaymentsService`, `EventsService`)
    // makes after committing — this suite exercises the seam directly rather than going through
    // a full hold-creation HTTP round trip, which would just be re-testing M3.
    app.get(RealtimeService).broadcastAvailability({
      eventId: eventIdBeingWatched,
      ticketsRemaining: 3,
      isSoldOut: false,
    });

    const payload = await received;

    expect(payload).toEqual({
      eventId: eventIdBeingWatched,
      ticketsRemaining: 3,
      isSoldOut: false,
    });

    // A beat for a wrongly-addressed message to have arrived, if the room targeting were broken.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(uninterestedGotSomething).toBe(false);

    watchingSocket.disconnect();
    uninterestedSocket.disconnect();
  });

  /**
   * `TR-DEC-031`, mechanism 1. Without this, a WebSocket connection's exposure is UNBOUNDED —
   * a REST call re-checks a token's `exp` on every single request, but a socket that's never
   * asked again would stay open indefinitely past the moment its own token stopped being valid.
   * Uses a deliberately short `expiresIn` so the test can actually observe the boundary rather
   * than asserting on a mechanism that would take 15 real minutes to prove.
   */
  it("disconnects a connection the instant its own token's expiry passes", async () => {
    const shortLivedToken = await mintToken('expiry-test-user', '1s');
    const socket = connect({ token: shortLivedToken });

    await waitForEvent(socket, 'connect');
    expect(socket.connected).toBe(true);

    const expiredEvent = waitForEvent(socket, 'session:expired', 3000);
    const disconnectReason = await waitForEvent<string>(socket, 'disconnect', 3000);

    await expiredEvent; // confirms the specific event fired, not just any disconnect
    expect(disconnectReason).toBe('io server disconnect');
  }, 8000);

  /**
   * `TR-DEC-031`, mechanism 2 — the actual scenario the interview question describes: an admin
   * (here, `AuthService.logout()`/reuse-detection in real usage) revokes a session while its
   * WebSocket is still open. Exercises `RealtimeService.disconnectUser()` directly, the exact
   * seam `AuthService` calls — going through a real `/auth/logout` HTTP round trip would just be
   * re-testing M1's own request/response contract, not this mechanism.
   */
  it("force-disconnects a user's live socket when RealtimeService.disconnectUser() is called", async () => {
    const userId = `revoke-test-user-${randomUUID()}`;
    const token = await mintToken(userId);
    const socket = connect({ token });

    await waitForEvent(socket, 'connect');
    expect(socket.connected).toBe(true);

    const revokedEvent = waitForEvent(socket, 'session:revoked');
    const disconnectReason = waitForEvent<string>(socket, 'disconnect');

    app.get(RealtimeService).disconnectUser(userId);

    await revokedEvent;
    expect(await disconnectReason).toBe('io server disconnect');
  });
});
