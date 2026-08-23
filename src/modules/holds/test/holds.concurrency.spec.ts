import { DataSource } from 'typeorm';

import { buildDataSourceOptions } from '../../../database/data-source';
import { Event } from '../../events/entities/event.entity';
import { User, UserRole } from '../../users/entities/user.entity';
import { TicketHold } from '../entities/ticket-hold.entity';
import { HoldsService } from '../holds.service';

/**
 * THE experiment M3 exists to run. Not a unit test with mocks — a real integration test against the
 * live development database, because the entire point is proving a property of Postgres's actual
 * concurrency behaviour. A mocked repository would prove nothing; the race lives in the database, not
 * in this file.
 *
 * Both halves are kept side by side, deliberately, per the build spec: "screenshot it, put both
 * versions in your README." The failing test is not a mistake left in the repo — it is the artifact
 * that turns "I understand lost updates" into "I have watched one happen and fixed it."
 */
describe('Holds concurrency — the oversell experiment', () => {
  let dataSource: DataSource;
  let holds: HoldsService;
  let organiserId: string;

  const TOTAL_TICKETS = 5;
  const CONCURRENT_REQUESTS = 20;
  const TEST_EVENT_TITLE = '__concurrency-test-event__';

  beforeAll(async () => {
    dataSource = new DataSource(buildDataSourceOptions());
    await dataSource.initialize();
    holds = new HoldsService(dataSource);

    // Deterministic organiser, reused across runs rather than created fresh each time — a unique
    // constraint violation on re-running the suite would be a false failure unrelated to concurrency.
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
  });

  /** Fresh event before EACH test, so the naive test's oversell can never contaminate the atomic one. */
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

  /**
   * The atomic conditional UPDATE, under real contention.
   *
   * 20 requests, 5 seats, fired via Promise.allSettled so a rejection from 15 of them does not abort
   * the other 5 — `Promise.all` would reject the whole batch on the first failure and never let us
   * observe the winners.
   */
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

    // The row-count check and the counter check are two INDEPENDENT ways of confirming no oversell —
    // the whole danger of the naive version is that the counter can look right while the row count
    // lies, so asserting only one of these would be exactly the blind spot that ships the bug.
    const holdCount = await dataSource.getRepository(TicketHold).count({ where: { eventId } });
    const event = await dataSource.getRepository(Event).findOneOrFail({ where: { id: eventId } });

    expect(holdCount).toBe(TOTAL_TICKETS);
    expect(event.ticketsCommitted).toBe(TOTAL_TICKETS);
  }, 30_000);

  /**
   * The naive version, under IDENTICAL contention. Expected to FAIL — that is the entire point.
   *
   * If this test ever starts passing, something is wrong with the test, not something newly right
   * about the naive method: a read-then-write race does not become safe on its own, and a green run
   * here would mean the concurrency was accidentally serialised (e.g. by a connection-pool limit far
   * below 20), not that the bug was fixed.
   */
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

    // Asserting the FAILURE, on purpose. A naive version that happened to serialise perfectly under
    // this run's exact timing would make this assertion fail — which is itself informative: it means
    // the race window didn't get hit this run, not that the code is safe. Flakiness in THIS
    // direction is expected; see the walkthrough for why 20-way contention makes it reliable in
    // practice.
    expect(succeeded).toBeGreaterThan(TOTAL_TICKETS);
    expect(holdCount).toBeGreaterThan(TOTAL_TICKETS);
  }, 30_000);
});
