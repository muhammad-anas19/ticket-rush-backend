# M5 — Stripe: Code Walkthrough

**How this project implements the ideas taught in
[`concepts/05-stripe-payments-and-webhooks.md`](../concepts/05-stripe-payments-and-webhooks.md).**
That document explains webhooks, signature verification, idempotency, PCI scope, and out-of-order
delivery standalone; this one shows exactly where each piece lives in shipped code — including a
real bug the M5 test suite caught before it ever reached a webhook.

**Status:** backend complete and verified live, including one bug the fulfilment test suite caught
mid-development — see §4.

---

## 1. What exists

```
src/stripe/
└── stripe.module.ts        the shared Stripe client, injected by token — same shape as RedisModule

src/modules/orders/
├── dto/{checkout-session-response,order-response}.dto.ts
├── entities/order.entity.ts        (M2, schema only — this module gives it behaviour)
├── orders.service.ts       createCheckoutSession (idempotent), findOne
├── orders.controller.ts    POST /holds/:holdId/checkout · GET /orders/:id
└── orders.module.ts

src/modules/payments/
├── entities/processed-event.entity.ts   (M2, schema only)
├── payments.service.ts     constructEvent, handleEvent, the fulfilment transaction, refunds
├── payments.controller.ts  POST /webhooks/stripe — the one route with no ValidationPipe DTO
├── payments.module.ts
└── test/payments.fulfilment.spec.ts   real Postgres, no mocked repository
```

| Route | Auth | Notes |
|---|---|---|
| `POST /api/holds/:holdId/checkout` | owner only | 201 with a checkout URL, or 403/404/409 |
| `GET /api/orders/:id` | owner only | poll this after a Checkout redirect |
| `POST /api/webhooks/stripe` | `@Public()` — Stripe, not a user | 200, or 400 on bad signature |

---

## 2. The Stripe client, as a shared provider

```ts
// src/stripe/stripe.module.ts
useFactory: (config) => new Stripe(config.get('stripe.secretKey', { infer: true }), {
  apiVersion: '2026-07-29.dahlia',
}),
```

Same shape as `RedisModule`: one configured client, injected by token (`STRIPE_CLIENT`), so there is
exactly one place constructing it. `apiVersion` is pinned explicitly rather than left to the
library's default — an unpinned client silently follows whatever version is current on the account
the moment the `stripe` package is upgraded, which is exactly the kind of change that should show up
in a diff, not arrive unannounced.

Not `@Global()`, unlike Redis. Only `OrdersModule` and `PaymentsModule` touch Stripe, so the
dependency stays explicit in their own module files rather than silently available everywhere.

---

## 3. Checkout — idempotent by construction, not by convention

```ts
async createCheckoutSession(holdId: string, userId: string) {
  const hold = await this.holds.findOne({ where: { id: holdId } });
  if (!hold || hold.userId !== userId) throw new NotFoundException('Hold not found');
  if (hold.status !== HoldStatus.Active || hold.isExpired) {
    throw new ForbiddenException('This hold is no longer active');
  }

  let order = await this.orders.findOne({ where: { holdId } });
  if (order?.status === OrderStatus.Paid) throw new ConflictException('Already paid for');

  if (order?.stripeSessionId) {
    const existingSession = await this.stripe.checkout.sessions.retrieve(order.stripeSessionId);
    if (existingSession.status === 'open' && existingSession.url) {
      return { checkoutUrl: existingSession.url, orderId: order.id };
    }
    // fall through — mint a fresh session against the SAME row
  }

  // ... create the order row if none exists yet, create the Stripe session, save session.id ...
}
```

The 404/403 split mirrors `HoldsService.release()` exactly: holds are private, so "not yours" and
"doesn't exist" both read 404 (a 403 would confirm the id is real); a hold that IS yours but no
longer usable is a 403, because existence and ownership aren't in question, only the action.

**The idempotency detail (`TR-DEC-028`):** `orders.hold_id` is UNIQUE where present
(`idx_orders_hold_unique`), so the database physically cannot hold two orders for one hold. This
method doesn't lean on hitting that constraint as its control flow, though — it looks up any
existing order FIRST and reuses (or refreshes) that row, so a double-click on "pay" or a
browser-back-then-retry returns the same session's URL instead of a raw constraint violation
surfacing as an unhandled 500.

Both `success_url` and Checkout's `metadata` carry `orderId` — worth being precise about which one
matters for what. `metadata` is what the WEBHOOK reads (server-to-server, the only channel this
project trusts). The `success_url` query param is purely so the frontend's success page knows which
order to *poll* — it is never treated as proof of anything, per `concepts/05-…md` §1.

---

## 4. The webhook route — raw body, no DTO, and the bug the test suite caught

```ts
// src/modules/payments/payments.controller.ts
@Public()
@Post('stripe')
@HttpCode(HttpStatus.OK)
@ApiExcludeEndpoint()
async handleStripeWebhook(
  @Req() request: RawBodyRequest<Request>,
  @Headers('stripe-signature') signature: string,
) {
  if (!request.rawBody) throw new BadRequestException('Raw request body unavailable');

  let event: Stripe.Event;
  try {
    event = this.payments.constructEvent(request.rawBody, signature, webhookSecret);
  } catch (error) {
    throw new BadRequestException(`Webhook signature verification failed: ${error.message}`);
  }

  await this.payments.handleEvent(event);   // anything thrown here → 5xx, Stripe retries
  return { received: true };
}
```

No `@Body()` parameter anywhere — the moment a parameter needs the global `ValidationPipe` to run
against a DTO, this route is back in the normal pipeline, and it can't be: signature verification
needs the exact bytes Stripe sent, not a value that already round-tripped through `JSON.parse`.
`request.rawBody` exists because `main.ts` set `rawBody: true` on `NestFactory.create()` back in M0 —
deliberately early, so this route never needed a bootstrap change made *during* a payments module.

**Verified live**, not just asserted: a POST with a deliberately wrong `stripe-signature` header
returns 400 with the SDK's own diagnostic message; a POST signed with `Stripe.webhooks.
generateTestHeaderString()` against this project's actual configured `STRIPE_WEBHOOK_SECRET` is
accepted — confirming the raw-body pipeline is byte-correct end to end, not merely "doesn't crash."

### `TR-DEC-008`'s mechanism, and the bug in the first version of it

```ts
return this.dataSource.transaction(async (manager) => {
  const insertResult = await manager
    .createQueryBuilder().insert().into(ProcessedEvent)
    .values({ stripeEventId: event.id })
    .orIgnore()          // INSERT ... ON CONFLICT DO NOTHING
    .execute();

  if (insertResult.raw.length === 0) {   // NOT .identifiers.length — see below
    this.logger.log(`Duplicate webhook ${event.id} ignored — already processed`);
    return { kind: 'duplicate' };
  }

  // ... fulfilment, using the SAME `manager` ...
});
```

The first version checked `insertResult.identifiers.length === 0`. That is **always** 1 for this
table, insert or not — confirmed with a throwaway script, not assumed:

```
FIRST  insert (genuine):  identifiers=[{stripeEventId:'evt_x'}]  raw=[{processed_at:'…'}]
SECOND insert (conflict): identifiers=[{stripeEventId:'evt_x'}]  raw=[]
```

`identifiers` is built from the entity's primary-key **values**, and `stripeEventId` isn't
database-generated — it's Stripe's own id, supplied by the caller. With nothing for TypeORM to have
generated, it just echoes back whatever was passed into `.values()`, whether or not a row actually
landed. `raw` is the field that reflects Postgres's real `RETURNING` output — empty exactly when
`ON CONFLICT DO NOTHING` fired.

**How this was caught:** `payments.fulfilment.spec.ts`'s duplicate-delivery test calls
`handleEvent()` twice with the identical `event.id`, then asserts `event.ticketsCommitted` is
UNCHANGED between the two calls. With the `identifiers`-based check, the second call passed the
(broken) dedupe check, fell through to `TR-DEC-011`'s "hold no longer active" branch (the hold had
already been converted by call one), and re-incremented inventory for the same paid order — visible
immediately as a failing assertion, not a passing test with a wrong implementation underneath. Fixed
by switching to `raw.length === 0`; see `TR-DEC-027` for the general rule this generalizes to
(`identifiers` is trustworthy only when the primary key is database-generated).

---

## 5. `TR-DEC-011`, implemented — re-check, re-commit, or refund

```ts
const hold = await manager.findOne(TicketHold, { where: { id: holdId } });

if (hold && hold.status === HoldStatus.Active && !hold.isExpired) {
  // common path — inventory was already committed when the hold was created (M3)
  hold.status = HoldStatus.Converted;
  order.status = OrderStatus.Paid;
  return { kind: 'converted' };
}

// the hold expired before payment completed — re-run the IDENTICAL atomic UPDATE M3 uses
const [rows] = await manager.query(
  `UPDATE events SET tickets_committed = tickets_committed + $1
    WHERE id = $2 AND tickets_committed + $1 <= total_tickets
  RETURNING tickets_committed`,
  [order.quantity, order.eventId],
);

if (rows.length > 0) {
  order.status = OrderStatus.Paid;          // seat was still free — re-committed
  return { kind: 'recommitted' };
}

order.status = OrderStatus.Refunded;         // genuinely sold out — nothing left to sell
return { kind: 'refund-needed', order };
```

The refund itself (`stripe.refunds.create()`) happens **after** this transaction commits, never
inside it — `TR-DEC-029` states why: a network call inside a transaction holding row locks is the
exact anti-pattern `HoldsService.create()`'s own comment warns against, and Stripe/Postgres can't
share one commit anyway, the same reasoning `TR-DEC-012` already applies to the RabbitMQ publish. If
the refund call itself fails, it's logged loudly as needing manual follow-up rather than silently
swallowed — a known, named gap, not an oversight.

---

## 6. Verified live

### The fulfilment suite (`payments.fulfilment.spec.ts`) — real Postgres, no mocked repository

```
converts the hold and marks the order paid when the hold is still active            ✅ PASS
TR-DEC-011: re-commits inventory when the hold expired but a seat is still free      ✅ PASS
TR-DEC-011: refunds when the hold expired AND the event sold out                     ✅ PASS
TR-DEC-008: a redelivered event is a no-op — tickets_committed unchanged             ✅ PASS
```

Only the Stripe CLIENT is fake in this suite (`refunds.create` as a `jest.fn()`), and only because a
refund is a real network call this suite has no business making. Everything else — the transaction,
the dedupe insert, the atomic re-commit UPDATE — runs against the real database, for the same reason
the M3 concurrency suite does: a mocked repository would prove nothing about the actual constraint
this module leans on.

### Signature verification, against the live dev server

```
POST /api/webhooks/stripe, tampered stripe-signature header
  → 400, SDK's own "No signatures found matching the expected signature" message      ✅

POST /api/webhooks/stripe, Stripe.webhooks.generateTestHeaderString() against the
  project's real configured STRIPE_WEBHOOK_SECRET, exact matching raw body bytes
  → 200 {"received":true}                                                             ✅
```

### Not verified by this session, because they need a real Stripe account

`stripe listen`, a real test-mode Checkout payment, `stripe events resend` — the three experiments
`docs/phases.md` names for M5's checkpoint all require actual Stripe test-mode credentials, which
only the project owner can create. See [guides/stripe-test-setup.md](../guides/stripe-test-setup.md).

---

## 7. Decisions visible in the code

`TR-DEC-011` (re-check/re-commit/refund, replacing the earlier OPEN status), `TR-DEC-027` (`ON
CONFLICT DO NOTHING` over a caught exception, and the `identifiers`-vs-`raw` bug), `TR-DEC-028`
(idempotent checkout-session reuse), `TR-DEC-029` (refund call outside the transaction).

**Env validation rejects a live key at boot, not by convention.** `STRIPE_SECRET_KEY` must match
`/^sk_test_/` — a live key literally cannot pass validation and reach this codebase, which is a
stronger guarantee than a comment saying "don't."

---

## 8. Known gaps, named as decisions

- **A failed refund call is logged, not retried.** Same shape as `TR-DEC-012`'s dual-write gap for
  the M6 publish — a proper fix is a queued retry, deferred to M6 rather than solved twice.
- **No ticket is actually issued yet.** `Order.status = Paid` is the end of M5's scope; generating
  and emailing a ticket is M6's RabbitMQ consumer, deliberately kept out of this synchronous webhook
  handler so a slow ticket-generation step can never make Stripe's webhook time out.
- **`GET /api/orders/:id` has no frontend consumer yet.** Built now because the endpoint's existence
  is part of M5's backend contract (`concepts/05-…md` §1's entire argument is that something has to
  poll for the real outcome); the frontend slice that calls it is next.

---

## 9. Running it

```bash
cd backend
docker compose up -d && npm run start:dev   # :3001

# the fulfilment proof — real Postgres, real transaction, real dedupe
npx jest src/modules/payments/test/payments.fulfilment.spec.ts --verbose
```

To exercise the real end-to-end flow (checkout → pay with a test card → webhook → order paid),
follow [guides/stripe-test-setup.md](../guides/stripe-test-setup.md) — it needs your own Stripe
test-mode account and the Stripe CLI, neither of which this session can create on your behalf.
