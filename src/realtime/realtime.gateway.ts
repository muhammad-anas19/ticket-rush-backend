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

type VerifiedAccessToken = AccessTokenPayload & { exp: number };

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

  afterInit(server: Server): void {
    this.realtime.setServer(server);
    this.logger.log('WebSocket gateway initialised');
  }

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

      await client.join(`user:${payload.sub}`);

      this.scheduleExpiryDisconnect(client, payload.exp);
    } catch (error) {
      this.logger.warn(
        `Connection ${client.id} rejected — invalid token: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      client.disconnect(true);
    }
  }

  private scheduleExpiryDisconnect(client: Socket, expUnixSeconds: number): void {
    const msUntilExpiry = expUnixSeconds * 1000 - Date.now();

    client.data.expiryTimer = setTimeout(() => {
      this.logger.debug(`Connection ${client.id} disconnected — its token's own expiry passed`);
      client.emit('session:expired');
      client.disconnect(true);
    }, msUntilExpiry);
  }

  handleDisconnect(client: Socket): void {
    clearTimeout(client.data.expiryTimer as NodeJS.Timeout | undefined);
    this.logger.debug(`Connection ${client.id} disconnected`);
  }

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
