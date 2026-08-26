import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { CacheService } from '../../../cache/cache.service';
import { buildDataSourceOptions } from '../../../database/data-source';
import { RealtimeService } from '../../../realtime/realtime.service';
import { User, UserRole } from '../../users/entities/user.entity';
import { Event } from '../entities/event.entity';
import { EventsService } from '../events.service';

/**
 * M4's checkpoint, per `docs/phases.md`: "a measured hit ratio you can quote, and a demonstrated
 * stampede on a cold key." Real Postgres and real Redis, like the M3 concurrency suite — a mocked
 * cache would prove nothing about the actual race this exists to close.
 */
describe('Events cache — cache-aside, stampede, and the availability exclusion', () => {
  let dataSource: DataSource;
  let redis: Redis;
  let cache: CacheService;
  let events: EventsService;
  let organiserId: string;
  const seededEventIds: string[] = [];

  beforeAll(async () => {
    dataSource = new DataSource(buildDataSourceOptions());
    await dataSource.initialize();
    redis = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    });
    cache = new CacheService(redis);
    // No `.setServer()` — this suite proves cache-aside behaviour, not the M7 broadcast, so
    // `broadcastAvailability()` (only reachable via `update()`, which none of these tests call
    // with a `totalTickets` change) simply no-ops here.
    events = new EventsService(dataSource.getRepository(Event), cache, new RealtimeService());

    const users = dataSource.getRepository(User);
    let organiser = await users.findOne({ where: { email: 'cache-test-organiser@example.com' } });
    if (!organiser) {
      organiser = await users.save(
        users.create({
          email: 'cache-test-organiser@example.com',
          passwordHash: 'not-a-real-hash-this-user-never-logs-in',
          role: UserRole.Organiser,
        }),
      );
    }
    organiserId = organiser.id;
  });

  afterAll(async () => {
    // Every seeded row is created with an id in this set, regardless of what `update()` later
    // renamed its title to — tracking ids rather than re-matching on title is what keeps this
    // cleanup correct even for the rename test.
    if (seededEventIds.length > 0) {
      await dataSource.query(`DELETE FROM events WHERE id = ANY($1)`, [seededEventIds]);
    }
    await dataSource.destroy();
    await redis.quit();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** A fresh row (and therefore a fresh id, therefore a guaranteed-cold cache key) per test. */
  async function seedEvent(overrides: Partial<Event> = {}): Promise<Event> {
    const repo = dataSource.getRepository(Event);
    const event = await repo.save(
      repo.create({
        organiserId,
        title: '__cache-test-event__',
        venue: 'Cache Test Venue',
        startsAt: new Date(Date.now() + 86_400_000),
        priceCents: 1000,
        totalTickets: 10,
        ticketsCommitted: 0,
        ...overrides,
      }),
    );
    seededEventIds.push(event.id);
    return event;
  }

  it('never serves a stale availability count, even while the rest of the row is cached', async () => {
    const event = await seedEvent();

    const first = await events.findOne(event.id);
    expect(first.ticketsRemaining).toBe(10);

    // Bypasses the service entirely — simulates a hold committing inventory (M3's job) while this
    // event's STATIC shape is sitting warm in Redis from the read above.
    await dataSource.query(`UPDATE events SET tickets_committed = $1 WHERE id = $2`, [4, event.id]);

    const second = await events.findOne(event.id);
    // Title etc. came from the (still valid) cache; availability did not, and reflects the write
    // that just happened outside the cache's knowledge entirely.
    expect(second.title).toBe(first.title);
    expect(second.ticketsCommitted).toBe(4);
    expect(second.ticketsRemaining).toBe(6);
  });

  it('invalidates the detail cache on update, rather than writing the new value into it', async () => {
    const event = await seedEvent({ title: 'Original Title' });

    const before = await events.findOne(event.id);
    expect(before.title).toBe('Original Title');

    await events.update(event.id, { title: 'Renamed Title' }, organiserId);

    const after = await events.findOne(event.id);
    expect(after.title).toBe('Renamed Title');
  });

  it('a cold key under concurrent load triggers exactly ONE database fetch — the stampede is caught', async () => {
    const event = await seedEvent();
    const CONCURRENT_READERS = 25;

    // Spies on the private fetch method rather than the query builder: `getLiveCommittedCounts`
    // legitimately runs once per call (by design, availability is never cached), so counting ALL
    // database access would hide the one number this test exists to prove.
    const dbFetchSpy = jest.spyOn(
      events as unknown as { fetchEventStaticFromDb: unknown },
      'fetchEventStaticFromDb' as never,
    );

    const results = await Promise.all(
      Array.from({ length: CONCURRENT_READERS }, () => events.findOne(event.id)),
    );

    expect(dbFetchSpy).toHaveBeenCalledTimes(1);
    results.forEach((result) => {
      expect(result.id).toBe(event.id);
      expect(result.ticketsRemaining).toBe(10);
    });
  }, 15_000);

  it('hit/miss counters move the way a real cold-then-warm read pattern predicts', async () => {
    const event = await seedEvent();

    const before = await cache.getStats();
    await events.findOne(event.id); // cold — one miss
    await events.findOne(event.id); // warm — one hit
    await events.findOne(event.id); // warm — one hit
    const after = await cache.getStats();

    expect(after.misses - before.misses).toBe(1);
    expect(after.hits - before.hits).toBe(2);
  });
});
