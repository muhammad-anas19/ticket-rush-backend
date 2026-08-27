import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { ServerOptions } from 'socket.io';

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
    const subClient = pubClient.duplicate();

    await Promise.all([this.waitUntilReady(pubClient), this.waitUntilReady(subClient)]);

    this.pubClient = pubClient;
    this.subClient = subClient;
    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  async dispose(): Promise<void> {
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
