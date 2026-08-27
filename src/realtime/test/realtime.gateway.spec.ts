import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { io, Socket } from 'socket.io-client';

import { AppModule } from '../../app.module';
import { AppConfig } from '../../config/configuration';
import { RealtimeService } from '../realtime.service';

describe('RealtimeGateway — handshake auth, room delivery, and session revocation (TR-DEC-013, TR-DEC-031)', () => {
  let app: INestApplication;
  let port: number;
  let validToken: string;
  let jwt: JwtService;
  let jwtSecret: string;

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

    await app.listen(0);
    port = (app.getHttpServer().address() as { port: number }).port;

    jwt = app.get(JwtService);
    jwtSecret = config.get('auth.accessSecret', { infer: true });
    validToken = await mintToken('test-user-id');
  });

  afterAll(async () => {
    await app.close();
  });

  function connect(auth?: Record<string, unknown>): Socket {
    return io(`http://localhost:${port}`, {
      auth,
      transports: ['websocket'],
      reconnection: false,
    });
  }

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

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(uninterestedGotSomething).toBe(false);

    watchingSocket.disconnect();
    uninterestedSocket.disconnect();
  });

  it("disconnects a connection the instant its own token's expiry passes", async () => {
    const shortLivedToken = await mintToken('expiry-test-user', '1s');
    const socket = connect({ token: shortLivedToken });

    await waitForEvent(socket, 'connect');
    expect(socket.connected).toBe(true);

    const expiredEvent = waitForEvent(socket, 'session:expired', 3000);
    const disconnectReason = await waitForEvent<string>(socket, 'disconnect', 3000);

    await expiredEvent;
    expect(disconnectReason).toBe('io server disconnect');
  }, 8000);

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
