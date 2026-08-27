import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';

export interface AvailabilityUpdate {
  eventId: string;
  ticketsRemaining: number;
  isSoldOut: boolean;
}

@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private server?: Server;

  setServer(server: Server): void {
    this.server = server;
  }

  broadcastAvailability(update: AvailabilityUpdate): void {
    if (!this.server) {
      this.logger.warn(
        `Dropped availability broadcast for event ${update.eventId} — gateway not initialised yet`,
      );
      return;
    }

    this.server.to(`event:${update.eventId}`).emit('availability', update);
  }

  disconnectUser(userId: string): void {
    if (!this.server) {
      this.logger.warn(`Could not force-disconnect user ${userId} — gateway not initialised yet`);
      return;
    }

    try {
      const room = this.server.in(`user:${userId}`);
      room.emit('session:revoked');
      room.disconnectSockets(true);
    } catch (error) {
      this.logger.error(
        `Failed to force-disconnect sockets for user ${userId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
