import { DataSource } from 'typeorm';

import { buildDataSourceOptions } from '../../../database/data-source';
import { Event } from '../../events/entities/event.entity';
import { HoldStatus, TicketHold } from '../../holds/entities/ticket-hold.entity';
import { Order, OrderStatus } from '../../orders/entities/order.entity';
import { User, UserRole } from '../../users/entities/user.entity';
import { ProcessedEvent } from '../entities/processed-event.entity';
import { PaymentsService } from '../payments.service';

/**
 * Real Postgres, same as the M3 concurrency suite and the M4 cache suite — this is money logic,
 * and the whole point of `TR-DEC-008`'s dedupe mechanism is a guarantee about what a REAL unique
 * constraint does under a REAL transaction. A mocked repository would not exercise the one thing
 * this file exists to prove.
 *
 * Only the Stripe CLIENT is fake, and only its `refunds.create` method — this suite never makes a
 * real network call to Stripe, and never needs to: `constructEvent` (signature verification) is
 * pure local HMAC and is exercised separately; everything here calls `handleEvent()` directly with
 * a synthetic `Stripe.Event`-shaped object, which is exactly what `constructEvent` would have
 * handed back after a real signature check passed.
 */
describe('PaymentsService — webhook fulfilment (TR-DEC-008, TR-DEC-011)', () => {
  let dataSource: DataSource;
  let organiserId: string;
  let userId: string;
  const seededEventIds: string[] = [];

  function fakeStripe(refundsCreate: jest.Mock = jest.fn()) {
    return { refunds: { create: refundsCreate } } as unknown as ConstructorParameters<
      typeof PaymentsService
    >[0];
  }

  beforeAll(async () => {
    dataSource = new DataSource(buildDataSourceOptions());
    await dataSource.initialize();

    const users = dataSource.getRepository(User);

    let organiser = await users.findOne({
      where: { email: 'payments-test-organiser@example.com' },
    });
    organiser ??= await users.save(
      users.create({
        email: 'payments-test-organiser@example.com',
        passwordHash: 'not-a-real-hash',
        role: UserRole.Organiser,
      }),
    );
    organiserId = organiser.id;

    let attendee = await users.findOne({ where: { email: 'payments-test-attendee@example.com' } });
    attendee ??= await users.save(
      users.create({
        email: 'payments-test-attendee@example.com',
        passwordHash: 'not-a-real-hash',
        role: UserRole.Attendee,
      }),
    );
    userId = attendee.id;
  });

  afterAll(async () => {
    // FK order matters: orders/holds RESTRICT their event, so they must go first.
    if (seededEventIds.length > 0) {
      await dataSource.query(`DELETE FROM orders WHERE event_id = ANY($1)`, [seededEventIds]);
      await dataSource.query(`DELETE FROM ticket_holds WHERE event_id = ANY($1)`, [seededEventIds]);
      await dataSource.query(`DELETE FROM events WHERE id = ANY($1)`, [seededEventIds]);
    }
    await dataSource.destroy();
  });

  /** Every fixture returns { event, hold, order, stripeEventId } — a fresh, isolated scenario. */
  async function seedScenario(options: {
    totalTickets: number;
    ticketsCommitted: number;
    holdStatus: HoldStatus;
    holdExpired: boolean;
  }) {
    const events = dataSource.getRepository(Event);
    const holds = dataSource.getRepository(TicketHold);
    const orders = dataSource.getRepository(Order);

    const event = await events.save(
      events.create({
        organiserId,
        title: '__payments-fulfilment-test__',
        venue: 'Test Venue',
        startsAt: new Date(Date.now() + 86_400_000),
        priceCents: 1000,
        totalTickets: options.totalTickets,
        ticketsCommitted: options.ticketsCommitted,
      }),
    );
    seededEventIds.push(event.id);

    const hold = await holds.save(
      holds.create({
        eventId: event.id,
        userId,
        quantity: 1,
        status: options.holdStatus,
        expiresAt: new Date(Date.now() + (options.holdExpired ? -60_000 : 600_000)),
      }),
    );

    const order = await orders.save(
      orders.create({
        eventId: event.id,
        userId,
        holdId: hold.id,
        quantity: 1,
        amountCents: event.priceCents,
        status: OrderStatus.Pending,
        stripeSessionId: `cs_test_${hold.id}`,
      }),
    );

    return { event, hold, order };
  }

  function checkoutCompletedEvent(
    stripeEventId: string,
    holdId: string,
    orderId: string,
    paymentIntentId = 'pi_test_123',
  ) {
    return {
      id: stripeEventId,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_test_${holdId}`,
          metadata: { holdId, orderId },
          payment_intent: paymentIntentId,
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it('converts the hold and marks the order paid when the hold is still active', async () => {
    const { hold, order } = await seedScenario({
      totalTickets: 10,
      ticketsCommitted: 1,
      holdStatus: HoldStatus.Active,
      holdExpired: false,
    });
    const payments = new PaymentsService(fakeStripe(), dataSource);

    await payments.handleEvent(
      checkoutCompletedEvent(`evt_converted_${hold.id}`, hold.id, order.id),
    );

    const holds = dataSource.getRepository(TicketHold);
    const orders = dataSource.getRepository(Order);
    expect((await holds.findOneOrFail({ where: { id: hold.id } })).status).toBe(
      HoldStatus.Converted,
    );
    expect((await orders.findOneOrFail({ where: { id: order.id } })).status).toBe(OrderStatus.Paid);
  });

  it('TR-DEC-011: re-commits inventory and marks the order paid when the hold expired but a seat is still free', async () => {
    const { event, hold, order } = await seedScenario({
      totalTickets: 10,
      ticketsCommitted: 3, // 3 committed by OTHER holds — 7 genuinely free
      holdStatus: HoldStatus.Expired, // the sweeper already released THIS hold's own seat
      holdExpired: true,
    });
    const payments = new PaymentsService(fakeStripe(), dataSource);

    await payments.handleEvent(
      checkoutCompletedEvent(`evt_recommit_${hold.id}`, hold.id, order.id),
    );

    const orders = dataSource.getRepository(Order);
    const events = dataSource.getRepository(Event);
    expect((await orders.findOneOrFail({ where: { id: order.id } })).status).toBe(OrderStatus.Paid);
    // Re-committed: one MORE ticket than the pre-existing 3, since this order's seat had already
    // been released and had to be re-taken via the same atomic conditional UPDATE as M3.
    expect((await events.findOneOrFail({ where: { id: event.id } })).ticketsCommitted).toBe(4);
  });

  it('TR-DEC-011: refunds when the hold expired AND the seat was taken by someone else', async () => {
    const { hold, order } = await seedScenario({
      totalTickets: 5,
      ticketsCommitted: 5, // genuinely sold out — no seat left to re-commit
      holdStatus: HoldStatus.Expired,
      holdExpired: true,
    });
    const refundsCreate = jest.fn().mockResolvedValue({ id: 're_test' });
    const payments = new PaymentsService(fakeStripe(refundsCreate), dataSource);

    await payments.handleEvent(
      checkoutCompletedEvent(`evt_refund_${hold.id}`, hold.id, order.id, 'pi_test_refund'),
    );

    const orders = dataSource.getRepository(Order);
    expect((await orders.findOneOrFail({ where: { id: order.id } })).status).toBe(
      OrderStatus.Refunded,
    );
    expect(refundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_test_refund' });
  });

  it('TR-DEC-008: a redelivered (duplicate) event is a no-op, not a second fulfilment', async () => {
    const { event, hold, order } = await seedScenario({
      totalTickets: 10,
      ticketsCommitted: 1,
      holdStatus: HoldStatus.Active,
      holdExpired: false,
    });
    const payments = new PaymentsService(fakeStripe(), dataSource);
    const stripeEventId = `evt_dupe_${hold.id}`;

    await payments.handleEvent(checkoutCompletedEvent(stripeEventId, hold.id, order.id));
    // Redelivered — same event.id, exactly as Stripe's own retry behaviour produces.
    await payments.handleEvent(checkoutCompletedEvent(stripeEventId, hold.id, order.id));

    const processed = await dataSource
      .getRepository(ProcessedEvent)
      .find({ where: { stripeEventId } });
    expect(processed).toHaveLength(1);

    const holds = dataSource.getRepository(TicketHold);
    expect((await holds.findOneOrFail({ where: { id: hold.id } })).status).toBe(
      HoldStatus.Converted,
    );

    // The regression this test caught for real during development: a broken dedupe check let
    // the SECOND call fall through past the (already non-Active) hold and into the TR-DEC-011
    // "re-commit" branch, incrementing tickets_committed a second time for one paid order. If
    // dedup is working, this stays exactly where the first call left it.
    const events = dataSource.getRepository(Event);
    expect((await events.findOneOrFail({ where: { id: event.id } })).ticketsCommitted).toBe(1);
  });
});
