import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { ServerOptions } from 'socket.io';

/**
 * `concepts/07-websockets-and-realtime.md` §5, wired up. Without this, each Node process keeps
 * its own in-memory Socket.IO room membership — `server.to('event:123').emit(...)` on one
 * instance only reaches sockets that connected to THAT instance (§4's two-instance problem). This
 * adapter makes every instance additionally publish/subscribe over a shared Redis Pub/Sub
 * channel, so an emit issued on any instance gets re-broadcast, locally, on every other one.
 *
 * TWO dedicated ioredis connections, not the shared `REDIS_CLIENT` from `redis.module.ts` — its
 * own doc comment names this exact exception. A connection Socket.IO's subscriber uses to listen
 * on a Pub/Sub channel enters SUBSCRIBE mode, in which Redis refuses ordinary commands on that
 * same connection — so the cache-aside `GET`/`SET` traffic and this Pub/Sub traffic cannot share
 * one client regardless of how idle either one is.
 */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private pubClient?: Redis;
  private subClient?: Redis;

  constructor(
    app: INestApplicationContext,
    private readonly redisHost: string,
    private readonly redisPort: number,
  ) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const pubClient = new Redis({ host: this.redisHost, port: this.redisPort });
    // `.duplicate()` opens a SECOND real connection sharing the first's config — not a second
    // reference to the same socket. This is the pub/sub pair the adapter needs.
    const subClient = pubClient.duplicate();

    // Waited for explicitly, rather than trusting ioredis's command-queueing to paper over it:
    // the WS server should not start accepting connections before its cross-instance broadcast
    // channel is actually up, or an emit issued in that window would silently only reach the
    // local instance — the exact failure this adapter exists to prevent.
    await Promise.all([this.waitUntilReady(pubClient), this.waitUntilReady(subClient)]);

    this.pubClient = pubClient;
    this.subClient = subClient;
    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  /**
   * These two connections are NOT Nest-managed providers — they're plain `ioredis` instances
   * this class constructs itself, so `app.close()` has no idea they exist and cannot close them
   * (unlike the shared `REDIS_CLIENT`, which `RedisModule`'s own `onApplicationShutdown` closes).
   * In the real running process this is harmless — the whole process exits and the OS reclaims
   * the sockets regardless — but a long-lived test process that creates and tears down several
   * `RedisIoAdapter`s in the same run needs this called explicitly, or each leftover pair of open
   * sockets keeps that Jest worker alive past every test finishing.
   */
  async dispose(): Promise<void> {
    // `app.close()` tearing down the Socket.IO server can already end these connections as a
    // side effect before this runs — `.quit()` on an already-closed ioredis connection throws
    // rather than no-opping, which would otherwise fail cleanup over a race that changes nothing
    // about whether the sockets actually got closed.
    await Promise.all(
      [this.pubClient, this.subClient].map(async (client) => {
        if (client && client.status !== 'end') {
          await client.quit().catch(() => undefined);
        }
      }),
    );
  }

  private waitUntilReady(client: Redis): Promise<void> {
    return new Promise((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
    });
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options);
    server.adapter(this.adapterConstructor);
    return server;
  }
}
