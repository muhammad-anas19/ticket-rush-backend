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
import { Event } from '../events/entities/event.entity';
import { HoldStatus, TicketHold } from './entities/ticket-hold.entity';

/** Ten minutes, per the build spec. A named constant so the sweeper and the creator agree by construction. */
const HOLD_DURATION_MS = 10 * 60 * 1000;

/**
 * The shape `EntityManager.query()` / `DataSource.query()` actually return on the Postgres driver —
 * and a real bug lived here, so it is worth being precise rather than trusting intuition.
 *
 * A plain `SELECT` returns the rows array directly: `Row[]`.
 *
 * Any `INSERT` / `UPDATE` / `DELETE` — WITH or WITHOUT a `RETURNING` clause — returns a TUPLE instead:
 * `[Row[], affectedRowCount]`. Confirmed empirically against this exact TypeORM/pg version:
 *
 *   SELECT                          → [{id:'…'}]
 *   UPDATE ... RETURNING, 1 match   → [[{tickets_committed:10}], 1]
 *   UPDATE ... RETURNING, 0 matches → [[], 0]
 *   UPDATE, no RETURNING            → [[], 1]
 *
 * The first version of this file destructured every one of these identically — `const rows = await
 * manager.query(...)` — as if all four returned a plain row array. For the RETURNING queries, `rows`
 * was actually `[innerRows, count]`: a 2-element array. `rows.length` was therefore **always 2**,
 * never 0, so the "zero rows affected → sold out" check could never fire — the single most important
 * guard in this file was silently dead code. And `rows[0]` was the inner rows array itself, not a row,
 * so `rows[0].tickets_committed` read as `undefined` without ever throwing (property access on an
 * array is legal JS, it just returns `undefined`).
 *
 * The concurrency test caught it immediately: with the destructuring bug in place, all 20 concurrent
 * holds "succeeded" against 5 real seats — not because the database allowed it (a direct psql
 * reproduction of the same UPDATE serialised correctly, 0→1→2→3 across sequential calls), but because
 * the application never noticed when Postgres said no.
 */
type QueryResultTuple<Row> = [Row[], number];

@Injectable()
export class HoldsService {
  private readonly logger = new Logger(HoldsService.name);

  /**
   * `DataSource` injected directly, with no repository alongside it — and that absence is
   * deliberate. Every read and write in this file needs to be either inside the SAME transaction as
   * the inventory update, or explicitly a one-off outside any transaction (the sweeper's candidate
   * scan). A repository bound to the default connection would be a standing invitation to reach for
   * it out of habit and silently escape the transaction — the exact "senior tell" the M3 plan calls
   * out by name.
   */
  constructor(
    private readonly dataSource: DataSource,
    // Redis holds the countdown for fast reads and the UI, and is authoritative for nothing
    // (TR-DEC-007) — every write here happens AFTER the Postgres transaction that actually
    // decides the outcome has already committed. Injected by token, same reasoning as
    // `RedisModule` itself: there is exactly one shared connection, not a pool.
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** `hold:<id>` — mirrors `expires_at`, nothing reads it as truth. See TR-DEC-024. */
  private holdCountdownKey(holdId: string): string {
    return `hold:${holdId}`;
  }

  /**
   * Creates a hold, committing inventory with a single atomic conditional UPDATE.
   *
   * ─── The mechanism, precisely ─────────────────────────────────────────────
   *
   * This is not "update, then check" — that ordering is the bug, not the fix, and it fails exactly
   * like read-then-write does: a gap between two separate statements is a gap regardless of which
   * one comes first. It is ONE statement, and the WHERE clause IS the check:
   *
   *   UPDATE events SET tickets_committed = tickets_committed + $qty
   *    WHERE id = $id AND tickets_committed + $qty <= total_tickets
   *   RETURNING tickets_committed
   *
   * Postgres takes a row lock to perform this UPDATE. A second concurrent UPDATE on the same row
   * does not read a stale value and race ahead — it BLOCKS until the first transaction commits or
   * rolls back, then re-evaluates its own WHERE clause against whatever was actually committed, not
   * against what it read at the start. There is no read step to go stale, because there is no read
   * step. Zero rows affected means the WHERE clause failed for every row it examined — sold out.
   *
   * ─── Why the transactional manager, and not the injected repository ──────────
   *
   * `this.holds` (constructor-injected) is bound to the DEFAULT connection pool, which is NOT part of
   * this transaction. Using it here would let the insert silently escape the transaction: the
   * inventory UPDATE and the hold INSERT would no longer commit or roll back together, and a crash
   * between them could commit one without the other. Every write below goes through `manager`, the
   * EntityManager `dataSource.transaction()` hands us — a database transaction is a boundary you opt
   * every statement INTO, not something that reaches out and catches whatever you happen to run.
   *
   * ─── Why this is short, and touches nothing external ─────────────────────────
   *
   * The transaction holds a row lock on `events` for its entire duration, blocking every other hold
   * attempt on the SAME event. Doing anything slow inside it — a Stripe call, an email send, a second
   * network hop — pins that lock (and the pooled connection) for however long that call takes. Under
   * real flash-sale contention that is exactly how a payment provider's latency becomes YOUR outage.
   * Everything here is one row lookup and one conditional write; nothing here should ever change to
   * include an external call.
   */
  async create(eventId: string, userId: string, quantity: number) {
    const result = await this.dataSource.transaction(async (manager) => {
      // Destructured as a tuple — see QueryResultTuple above for why that is load-bearing rather than
      // stylistic. `manager.query()` on an UPDATE ... RETURNING returns [rows, affectedCount]; treating
      // it as a plain rows array is exactly the bug the concurrency test exists to catch, and did.
      const [rows] = await manager.query<QueryResultTuple<{ tickets_committed: number }>>(
        `UPDATE events
            SET tickets_committed = tickets_committed + $1
          WHERE id = $2
            AND tickets_committed + $1 <= total_tickets
        RETURNING tickets_committed`,
        [quantity, eventId],
      );

      if (rows.length === 0) {
        // Zero rows could mean "sold out" OR "no such event" — one query can't distinguish them, and
        // for this endpoint it doesn't need to: both are "you cannot hold this," and 409 says so
        // without confirming or denying which. A dedicated existence check would cost a second query
        // on every successful path just to phrase the rare failure more precisely.
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

      const ticketsCommitted = rows[0].tickets_committed;
      this.logger.log(
        `Hold ${hold.id} created: ${quantity} ticket(s) on event ${eventId} by user ${userId} ` +
          `(committed now ${ticketsCommitted})`,
      );

      return { hold, ticketsCommitted };
    });

    // AFTER commit, not inside the transaction: Redis can't participate in a Postgres rollback
    // anyway (TR-DEC-007), so writing here means a Redis failure never blocks a successful hold,
    // and there is nothing to undo if it fails — this key is a mirror, never the record of truth.
    await this.redis.set(
      this.holdCountdownKey(result.hold.id),
      result.hold.expiresAt.toISOString(),
      'PX',
      HOLD_DURATION_MS,
    );

    return result;
  }

  /**
   * The naive version. NEVER called from the controller — exists solely so
   * `holds.concurrency.spec.ts` can prove the failure mode it replaces.
   *
   * This is the shape everyone reaches for first: read the count, decide in application code,
   * write the decision. It looks correct in isolation and in every test that doesn't run it
   * concurrently, which is precisely what makes it dangerous — it passes review and ships.
   *
   * Wrapping it in a transaction does NOT fix it. Under READ COMMITTED (Postgres's default), a plain
   * SELECT takes no lock, so a second transaction's SELECT freely reads the same pre-write value
   * while the first transaction is still deciding. The transaction boundary controls what the *caller*
   * sees committed or rolled back as a unit; it does not stop two transactions from reading the same
   * stale snapshot and both proceeding on it. That is the lost-update anomaly, and it is not one of
   * the three READ COMMITTED prevents (dirty read, and the ones repeatable-read/serializable add on
   * top).
   */
  async createNaive(eventId: string, userId: string, quantity: number) {
    return this.dataSource.transaction(async (manager) => {
      const event = await manager.findOne(Event, { where: { id: eventId } });
      if (!event) {
        throw new NotFoundException('Event not found');
      }

      // THE RACE WINDOW. Two concurrent transactions can both execute this SELECT and both observe
      // the same `ticketsCommitted`, before either has written anything back.
      if (event.ticketsCommitted + quantity > event.totalTickets) {
        throw new ConflictException('Not enough tickets remaining');
      }

      // Both transactions now compute the same target value from the same stale base and write it —
      // the second write does not add to the first, it OVERWRITES with an identical-looking number.
      // The final count reads as correct while two holds exist for the capacity of one.
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

  /**
   * Early release, by the holder.
   *
   * 404, not 403, on a mismatch — deliberately the opposite choice from `EventsService.update()`.
   * Events are public, so hiding a PATCH target's existence buys nothing. Holds are private: telling
   * a caller "403, this hold exists and isn't yours" confirms that hold id is real and lets someone
   * enumerate valid ids. 404 reveals nothing either way. Same axis (ownership), opposite resource
   * (private vs public), opposite correct answer — which is the point of deciding this per resource
   * rather than adopting one rule project-wide.
   */
  async release(holdId: string, userId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      // Row lock taken here and held for the transaction, so a concurrent sweeper tick or a second
      // release call on the same hold blocks rather than racing to decrement the counter twice.
      const hold = await manager
        .createQueryBuilder(TicketHold, 'hold')
        .setLock('pessimistic_write')
        .where('hold.id = :holdId', { holdId })
        .getOne();

      if (!hold || hold.userId !== userId) {
        throw new NotFoundException('Hold not found');
      }

      if (hold.status !== HoldStatus.Active) {
        // Already converted (paid) or already expired/released. Releasing a converted hold would
        // hand back inventory for a seat that was actually sold — a correctness bug, not a courtesy.
        throw new ForbiddenException('This hold is no longer active');
      }

      hold.status = HoldStatus.Expired;
      await manager.save(hold);

      await manager.query(
        `UPDATE events SET tickets_committed = tickets_committed - $1 WHERE id = $2`,
        [hold.quantity, hold.eventId],
      );

      this.logger.log(`Hold ${holdId} released early by user ${userId}`);
    });

    await this.redis.del(this.holdCountdownKey(holdId));
  }

  /**
   * The backstop layer of `TR-DEC-007`'s three: Postgres's `expires_at` is authoritative, RabbitMQ
   * TTL+DLX (M6) is the timely trigger, and this periodic sweep is what catches whatever the broker
   * loses. Built now, before M6 exists, because a hold with no queue behind it yet would otherwise
   * never be released at all — every hold created between now and M6 needs SOMETHING reclaiming it.
   *
   * Runs every 30 seconds. Not on a schedule tied to the 10-minute hold duration — a hold that expired
   * even one tick late is still correctly excluded from availability, because `EventsService` never
   * trusted `status='active'` alone; TR-DEC-007 makes `expires_at` the authority precisely so a slow
   * sweeper is a latency problem, never a correctness one.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async sweepExpiredHolds(): Promise<void> {
    // Candidate ids read OUTSIDE a lock — cheap, and safe to be slightly stale, because each one is
    // re-verified with `AND status = 'active'` at claim time in its own transaction below. A hold
    // that another process already claimed between this read and that claim simply matches zero rows
    // there and is skipped, not double-released.
    const candidates: Array<{ id: string }> = await this.dataSource.query(
      `SELECT id FROM ticket_holds WHERE status = 'active' AND expires_at <= now()`,
    );

    if (candidates.length === 0) {
      return;
    }

    let released = 0;

    for (const { id } of candidates) {
      // One transaction PER hold, deliberately, rather than one transaction for the whole batch. A
      // single long transaction would hold row locks across every event touched for the entire sweep
      // — including events with live, contended hold traffic — turning a maintenance task into a
      // stall on the hot path. Per-hold transactions are held for microseconds each.
      const wasReleased = await this.dataSource.transaction(async (manager) => {
        // The claim IS the concurrency control: `WHERE status = 'active'` inside the same statement
        // that changes it means exactly one process can ever win this row, by the same atomic-UPDATE
        // mechanism `create()` uses for inventory. Two sweeper ticks overlapping, or a user releasing
        // the hold themselves at the same instant, both resolve safely to "the loser affects nothing."
        //
        // Tuple-destructured — see QueryResultTuple. Left as a plain array here originally, the
        // "already claimed by someone else" case (0 rows) would never have been detected, and the
        // decrement below would have run with `undefined` for both the amount and the event id —
        // silently corrupting an unrelated row's counter to NULL via `WHERE id = NULL`, matching
        // nothing, rather than throwing anywhere.
        const [claimed] = await manager.query<
          QueryResultTuple<{ event_id: string; quantity: number }>
        >(
          `UPDATE ticket_holds SET status = 'expired'
            WHERE id = $1 AND status = 'active'
          RETURNING event_id, quantity`,
          [id],
        );

        if (claimed.length === 0) {
          return false;
        }

        await manager.query(
          `UPDATE events SET tickets_committed = tickets_committed - $1 WHERE id = $2`,
          [claimed[0].quantity, claimed[0].event_id],
        );

        return true;
      });

      if (wasReleased) {
        released += 1;
        // Usually a no-op: this key's own TTL was set to expire at roughly the same wall-clock
        // moment. Explicit anyway, because a hold's `expires_at` CAN be moved independently of
        // the Redis key (the manual-backdate trick used to test the sweeper without waiting 10
        // real minutes is exactly that), and a dangling key that outlives the hold it describes
        // is a small but pointless lie for whatever eventually reads it.
        await this.redis.del(this.holdCountdownKey(id));
      }
    }

    if (released > 0) {
      this.logger.log(`Sweeper released ${released} expired hold(s)`);
    }
  }
}
