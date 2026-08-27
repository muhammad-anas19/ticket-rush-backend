import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { CacheService } from '../../../cache/cache.service';
import { buildDataSourceOptions } from '../../../database/data-source';
import { RealtimeService } from '../../../realtime/realtime.service';
import { User, UserRole } from '../../users/entities/user.entity';
import { Event } from '../entities/event.entity';
import { EventsService } from '../events.service';

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
    if (seededEventIds.length > 0) {
      await dataSource.query(`DELETE FROM events WHERE id = ANY($1)`, [seededEventIds]);
    }
    await dataSource.destroy();
    await redis.quit();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

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

    await dataSource.query(`UPDATE events SET tickets_committed = $1 WHERE id = $2`, [4, event.id]);

    const second = await events.findOne(event.id);
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
});
