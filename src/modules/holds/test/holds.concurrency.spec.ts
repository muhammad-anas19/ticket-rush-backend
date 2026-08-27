import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { buildDataSourceOptions } from '../../../database/data-source';
import { RealtimeService } from '../../../realtime/realtime.service';
import { Event } from '../../events/entities/event.entity';
import { User, UserRole } from '../../users/entities/user.entity';
import { TicketHold } from '../entities/ticket-hold.entity';
import { HoldsService } from '../holds.service';

describe('Holds concurrency — the oversell experiment', () => {
  let dataSource: DataSource;
  let redis: Redis;
  let holds: HoldsService;
  let organiserId: string;

  const TOTAL_TICKETS = 5;
  const CONCURRENT_REQUESTS = 20;
  const TEST_EVENT_TITLE = '__concurrency-test-event__';

  beforeAll(async () => {
    dataSource = new DataSource(buildDataSourceOptions());
    await dataSource.initialize();
    redis = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    });
    holds = new HoldsService(dataSource, redis, new RealtimeService());

    const users = dataSource.getRepository(User);
    let organiser = await users.findOne({
      where: { email: 'concurrency-test-organiser@example.com' },
    });
    if (!organiser) {
      organiser = await users.save(
        users.create({
          email: 'concurrency-test-organiser@example.com',
          passwordHash: 'not-a-real-hash-this-user-never-logs-in',
          role: UserRole.Organiser,
        }),
      );
    }
    organiserId = organiser.id;
  });

  afterAll(async () => {
    await dataSource.destroy();
    await redis.quit();
  });

  async function seedEvent(): Promise<string> {
    const events = dataSource.getRepository(Event);
    await events.delete({ title: TEST_EVENT_TITLE });
    const event = await events.save(
      events.create({
        organiserId,
        title: TEST_EVENT_TITLE,
        venue: 'Concurrency Test Venue',
        startsAt: new Date(Date.now() + 86_400_000),
        priceCents: 1000,
        totalTickets: TOTAL_TICKETS,
        ticketsCommitted: 0,
      }),
    );
    return event.id;
  }

  it('atomic UPDATE: exactly 5 of 20 concurrent holds succeed, never more', async () => {
    const eventId = await seedEvent();

    const attempts = Array.from({ length: CONCURRENT_REQUESTS }, (_, i) =>
      holds.create(eventId, organiserId, 1).then(
        () => ({ ok: true as const, i }),
        (error: Error) => ({ ok: false as const, i, message: error.message }),
      ),
    );
    const results = await Promise.all(attempts);

    const succeeded = results.filter((r) => r.ok);
    const rejected = results.filter((r) => !r.ok);

    expect(succeeded).toHaveLength(TOTAL_TICKETS);
    expect(rejected).toHaveLength(CONCURRENT_REQUESTS - TOTAL_TICKETS);
    rejected.forEach((r) => {
      if (!r.ok) expect(r.message).toMatch(/not enough tickets/i);
    });

    const holdCount = await dataSource.getRepository(TicketHold).count({ where: { eventId } });
    const event = await dataSource.getRepository(Event).findOneOrFail({ where: { id: eventId } });

    expect(holdCount).toBe(TOTAL_TICKETS);
    expect(event.ticketsCommitted).toBe(TOTAL_TICKETS);
  }, 30_000);

  it('DEMONSTRATES OVERSELL: naive read-then-write lets more than 5 of 20 succeed', async () => {
    const eventId = await seedEvent();

    const attempts = Array.from({ length: CONCURRENT_REQUESTS }, () =>
      holds.createNaive(eventId, organiserId, 1).then(
        () => true,
        () => false,
      ),
    );
    const results = await Promise.all(attempts);
    const succeeded = results.filter(Boolean).length;

    const holdCount = await dataSource.getRepository(TicketHold).count({ where: { eventId } });

    console.log(
      `\n  [oversell experiment] naive version: ${succeeded} holds "succeeded" for ` +
        `${TOTAL_TICKETS} real seats (${holdCount} rows actually inserted).\n` +
        `  Postgres's own counter still reads back as if only ${TOTAL_TICKETS} were taken — the\n` +
        `  lost update is invisible in the aggregate and only visible by counting the real rows.\n`,
    );

    expect(succeeded).toBeGreaterThan(TOTAL_TICKETS);
    expect(holdCount).toBeGreaterThan(TOTAL_TICKETS);
  }, 30_000);
});
