import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';

export interface AvailabilityUpdate {
  eventId: string;
  ticketsRemaining: number;
  isSoldOut: boolean;
}

/**
 * The seam between "domain code that changed inventory" and "Socket.IO, specifically." Every
 * write path that touches `Event.ticketsCommitted` — `HoldsService.create()`/`release()`, the M3
 * sweeper, `PaymentsService`'s re-commit path, `EventsService.update()` — depends on THIS service,
 * never on `RealtimeGateway` directly. That keeps every Socket.IO-specific detail (rooms, the
 * `Server` instance, connection handling) inside the gateway, where it belongs, and keeps this
 * service's public surface to exactly the one thing other modules actually need: "tell whoever's
 * watching this event what the number is now."
 *
 * `server` is set once, by `RealtimeGateway.afterInit()` — not injected, because the Socket.IO
 * `Server` instance is a Gateway lifecycle artifact, not something Nest's DI container constructs.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private server?: Server;

  setServer(server: Server): void {
    this.server = server;
  }

  /**
   * A no-op, loudly, if called before `afterInit()` has run (there is a brief window at boot
   * where domain code COULD theoretically run before the gateway finishes initialising). Never
   * throws — a missed live-update push is a UX gap, not a correctness bug, since every client
   * that reconnects or refetches gets the true number from Postgres regardless (`concepts/04-redis.md`
   * §5's rule again: this is exactly the kind of staleness that's acceptable to risk, unlike the
   * number itself ever being wrong at the source).
   */
  broadcastAvailability(update: AvailabilityUpdate): void {
    if (!this.server) {
      this.logger.warn(
        `Dropped availability broadcast for event ${update.eventId} — gateway not initialised yet`,
      );
      return;
    }

    this.server.to(`event:${update.eventId}`).emit('availability', update);
  }

  /**
   * `TR-DEC-031`, mechanism 2: called by `AuthService` the instant a session is genuinely killed
   * (logout, reuse-detected theft) — never on a normal refresh-token rotation, which is not a
   * revocation at all. Closes every live socket for this user immediately, rather than leaving
   * them open until `RealtimeGateway`'s own expiry timer eventually fires up to ~15 minutes later.
   *
   * `server.in(room)` reaches sockets on EVERY instance, not just this process — the same
   * `@socket.io/redis-adapter` that makes `broadcastAvailability()` cross-instance
   * (`concepts/07-…md` §5) makes this cross-instance too, for the identical reason: the adapter
   * doesn't care whether the operation is "emit" or "disconnect," it forwards either one over the
   * same Redis Pub/Sub channel to every instance, which then acts on its own local sockets.
   *
   * Best-effort, not the security boundary itself — the boundary is the bounded token expiry
   * every connection already enforces on its own. A failure here (or simply the gateway not
   * being initialised yet) means a revoked user's socket survives a few minutes longer than
   * ideal, never longer than its token's own `exp`, and never silently forever.
   *
   * Synchronous (not `Promise<void>`) because `disconnectSockets()` itself doesn't return one in
   * this Socket.IO version — it fires the operation (locally, and across instances via the
   * adapter) without a completion signal to await. Callers still don't need to know that; they
   * just call it and move on, exactly like `broadcastAvailability()` above.
   */
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
