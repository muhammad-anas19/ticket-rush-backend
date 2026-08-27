import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { REDIS_CLIENT } from '../../redis/redis.module';
import { RealtimeService } from '../../realtime/realtime.service';
import { Event } from '../events/entities/event.entity';
import { HoldStatus, TicketHold } from './entities/ticket-hold.entity';

const HOLD_DURATION_MS = 10 * 60 * 1000;

type QueryResultTuple<Row> = [Row[], number];

@Injectable()
export class HoldsService {
  private readonly logger = new Logger(HoldsService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly realtime: RealtimeService,
  ) {}

  private holdCountdownKey(holdId: string): string {
    return `hold:${holdId}`;
  }

  private broadcast(eventId: string, ticketsCommitted: number, totalTickets: number): void {
    const ticketsRemaining = totalTickets - ticketsCommitted;
    this.realtime.broadcastAvailability({
      eventId,
      ticketsRemaining,
      isSoldOut: ticketsRemaining <= 0,
    });
  }

  async create(eventId: string, userId: string, quantity: number) {
    const result = await this.dataSource.transaction(async (manager) => {
      const [rows] = await manager.query<
        QueryResultTuple<{ tickets_committed: number; total_tickets: number }>
      >(
        `UPDATE events
            SET tickets_committed = tickets_committed + $1
          WHERE id = $2
            AND tickets_committed + $1 <= total_tickets
        RETURNING tickets_committed, total_tickets`,
        [quantity, eventId],
      );

      if (rows.length === 0) {
        throw new ConflictException('Not enough tickets remaining');
      }

      const expiresAt = new Date(Date.now() + HOLD_DURATION_MS);

      const hold = manager.create(TicketHold, {
        eventId,
        userId,
        quantity,
        status: HoldStatus.Active,
        expiresAt,
      });
      await manager.save(hold);

      const { tickets_committed: ticketsCommitted, total_tickets: totalTickets } = rows[0];
      this.logger.log(
        `Hold ${hold.id} created: ${quantity} ticket(s) on event ${eventId} by user ${userId} ` +
          `(committed now ${ticketsCommitted})`,
      );

      return { hold, ticketsCommitted, totalTickets };
    });

    await this.redis.set(
      this.holdCountdownKey(result.hold.id),
      result.hold.expiresAt.toISOString(),
      'PX',
      HOLD_DURATION_MS,
    );

    this.broadcast(eventId, result.ticketsCommitted, result.totalTickets);

    return result;
  }

  async createNaive(eventId: string, userId: string, quantity: number) {
    return this.dataSource.transaction(async (manager) => {
      const event = await manager.findOne(Event, { where: { id: eventId } });
      if (!event) {
        throw new NotFoundException('Event not found');
      }

      if (event.ticketsCommitted + quantity > event.totalTickets) {
        throw new ConflictException('Not enough tickets remaining');
      }

      event.ticketsCommitted += quantity;
      await manager.save(event);

      const hold = manager.create(TicketHold, {
        eventId,
        userId,
        quantity,
        status: HoldStatus.Active,
        expiresAt: new Date(Date.now() + HOLD_DURATION_MS),
      });
      await manager.save(hold);

      return { hold, ticketsCommitted: event.ticketsCommitted };
    });
  }

  async release(holdId: string, userId: string): Promise<void> {
    const eventUpdate = await this.dataSource.transaction(async (manager) => {
      const hold = await manager
        .createQueryBuilder(TicketHold, 'hold')
        .setLock('pessimistic_write')
        .where('hold.id = :holdId', { holdId })
        .getOne();

      if (!hold || hold.userId !== userId) {
        throw new NotFoundException('Hold not found');
      }

      if (hold.status !== HoldStatus.Active) {
        throw new ForbiddenException('This hold is no longer active');
      }

      hold.status = HoldStatus.Expired;
      await manager.save(hold);

      const [rows] = await manager.query<
        QueryResultTuple<{ tickets_committed: number; total_tickets: number }>
      >(
        `UPDATE events SET tickets_committed = tickets_committed - $1
          WHERE id = $2
        RETURNING tickets_committed, total_tickets`,
        [hold.quantity, hold.eventId],
      );

      this.logger.log(`Hold ${holdId} released early by user ${userId}`);

      return { eventId: hold.eventId, ...rows[0] };
    });

    await this.redis.del(this.holdCountdownKey(holdId));
    this.broadcast(eventUpdate.eventId, eventUpdate.tickets_committed, eventUpdate.total_tickets);
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async sweepExpiredHolds(): Promise<void> {
    const candidates: Array<{ id: string }> = await this.dataSource.query(
      `SELECT id FROM ticket_holds WHERE status = 'active' AND expires_at <= now()`,
    );

    if (candidates.length === 0) {
      return;
    }

    let released = 0;

    for (const { id } of candidates) {
      const claimResult = await this.dataSource.transaction<{
        eventId: string;
        ticketsCommitted: number;
        totalTickets: number;
      } | null>(async (manager) => {
        const [claimed] = await manager.query<
          QueryResultTuple<{ event_id: string; quantity: number }>
        >(
          `UPDATE ticket_holds SET status = 'expired'
            WHERE id = $1 AND status = 'active'
          RETURNING event_id, quantity`,
          [id],
        );

        if (claimed.length === 0) {
          return null;
        }

        const [eventRows] = await manager.query<
          QueryResultTuple<{ tickets_committed: number; total_tickets: number }>
        >(
          `UPDATE events SET tickets_committed = tickets_committed - $1
            WHERE id = $2
          RETURNING tickets_committed, total_tickets`,
          [claimed[0].quantity, claimed[0].event_id],
        );

        return {
          eventId: claimed[0].event_id,
          ticketsCommitted: eventRows[0].tickets_committed,
          totalTickets: eventRows[0].total_tickets,
        };
      });

      if (claimResult) {
        released += 1;
        await this.redis.del(this.holdCountdownKey(id));
        this.broadcast(claimResult.eventId, claimResult.ticketsCommitted, claimResult.totalTickets);
      }
    }

    if (released > 0) {
      this.logger.log(`Sweeper released ${released} expired hold(s)`);
    }
  }
}
