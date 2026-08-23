# M3 — Holds & Concurrency: Code Walkthrough

**How this project implements the mechanism taught in
[`qa/phase-2-events-understanding-check.md`](../qa/phase-2-events-understanding-check.md) Q9 and the
gate re-check that preceded this module.**

For a request-by-request trace of exactly what each endpoint does — guards, SQL, transaction boundaries, the response shape, and the frontend on the other end — see the companion
[m3-holds-end-to-end-flow.md](m3-holds-end-to-end-flow.md). This document covers *decisions* and the tuple bug; that one covers *mechanism*.

**Status:** complete and verified live, including one real bug the concurrency experiment caught
before it ever reached a controller.

---

## 1. What exists

```
src/modules/holds/
├── entities/ticket-hold.entity.ts   (M2, schema only — this module gives it behaviour)
├── dto/{create-hold,hold-response}.dto.ts
├── holds.service.ts       create (atomic), createNaive (experiment only), release, sweepExpiredHolds
├── holds.controller.ts    POST /events/:eventId/holds · DELETE /holds/:id
├── holds.module.ts
└── test/holds.concurrency.spec.ts   the experiment — a real integration test, not a mock
```

| Route | Auth | Notes |
|---|---|---|
| `POST /api/events/:eventId/holds` | any authenticated user | 201, or 409 sold out |
| `DELETE /api/holds/:id` | owner only | 204; 404 on mismatch, 403 if no longer active |

Plus `HoldsService.sweepExpiredHolds()`, a `@Cron(EVERY_30_SECONDS)` job — the backstop layer of
`TR-DEC-007`, built now because M6's RabbitMQ TTL+DLX trigger doesn't exist yet and a hold created
today needs *something* reclaiming it.

---

## 2. The mechanism, as shipped

```sql
UPDATE events
   SET tickets_committed = tickets_committed + $1
 WHERE id = $2
   AND tickets_committed + $1 <= total_tickets
RETURNING tickets_committed
```

One statement. The `WHERE` clause **is** the check — not a check before the write, not a check after
it. Postgres takes a row lock to perform the `UPDATE`; a second concurrent `UPDATE` on the same row
doesn't read a stale value and race ahead, it **blocks** until the first transaction commits, then
re-evaluates its own `WHERE` against what was actually committed. There is no read step to go stale
because there is no separate read step. Zero rows affected means sold out.

This directly corrects the M2/M3 gate misconception: the fix is not "update, then check" as two
steps — that ordering has exactly the same race as read-then-write, just reversed. It's one statement,
and the condition and the write are inseparable.

**Every write goes through the transaction's own `manager`**, never the constructor-injected
repository — there isn't one. `HoldsService` takes only a `DataSource`, deliberately, so there is no
repository bound to the default connection sitting around as an invitation to reach for out of habit
and silently escape the transaction. That escape is the exact "senior tell" the M3 plan names.

**The transaction is short and touches nothing external.** One row lookup, one conditional write. A
Stripe call or an email send inside this transaction would pin the row lock — and the pooled
connection — for however long that call takes, and under real flash-sale contention that is how a
payment provider's latency becomes *your* outage.

---

## 3. What surprised me — a real bug, caught by the experiment it was built to run

The concurrency test's first run **failed** — and not the way it should have. All 20 concurrent
requests "succeeded" against 5 real seats, on the *atomic* method, which is supposed to be immune to
exactly this.

### The bug

`EntityManager.query()` on the Postgres driver does not return a consistent shape:

```
SELECT                          → Row[]                    (plain array)
UPDATE ... RETURNING, 1 match   → [[{tickets_committed:10}], 1]   (a TUPLE)
UPDATE ... RETURNING, 0 matches → [[], 0]
UPDATE, no RETURNING            → [[], 1]
```

Confirmed empirically — see the table above, produced by a throwaway script hitting the real
connection. Any non-`SELECT` query, whether or not it has `RETURNING`, comes back as
**`[rows, affectedCount]`**, not `rows` directly.

The original code destructured every case identically:

```ts
const rows: Array<{ tickets_committed: number }> = await manager.query(/* UPDATE ... RETURNING */);
if (rows.length === 0) { throw new ConflictException(...); }
```

`rows` was actually the 2-element tuple. `rows.length` was **always 2**, never 0 — so the single most
important guard in the entire module, the "zero rows affected → sold out" check, **could never fire**.
And `rows[0]` was the *inner* rows array, not a row, so `rows[0].tickets_committed` silently evaluated
to `undefined` — property access on an array is legal JavaScript, so nothing ever threw. The logs
showed `committed now undefined` on every single successful call, which was the first visible sign
something was wrong.

### Why the database wasn't lying, only the application

A direct psql reproduction of the identical `UPDATE` statement, run three times in sequence, correctly
went `0 → 1 → 2 → 3` and would have returned zero rows on a fourth call past capacity. **The SQL and
Postgres's locking were correct the entire time.** The bug was purely in how the Node process read
the result — the database said no, and the code never noticed.

That distinction is worth being able to state precisely in an interview: *"the concurrency primitive
worked; the bug was in result-shape handling around it."* It's also the reason the experiment is
valuable beyond its headline result — it caught a defect a unit test with a mocked repository would
never have seen, because the mock would have been written to return whatever shape the (wrong) code
expected.

### The fix

```ts
type QueryResultTuple<Row> = [Row[], number];
const [rows] = await manager.query<QueryResultTuple<{ tickets_committed: number }>>(/* ... */);
```

Applied at both call sites that read a `RETURNING` result: `create()`'s inventory update, and the
sweeper's claim-and-expire step, which had the **identical** bug — its `claimed.length === 0` check
was equally dead, and passing `claimed[0].quantity`/`claimed[0].event_id` (both `undefined`) into the
next `UPDATE` would have silently matched zero rows via `WHERE id = NULL`, meaning a hold could be
marked `expired` while its inventory was **never actually returned** — a quiet, permanent leak of
available seats. Found and fixed before it ever ran against real data, because the same review that
fixed `create()` asked "where else does this pattern appear."

---

## 4. Verified live

### The experiment itself

```
atomic UPDATE: exactly 5 of 20 concurrent holds succeed, never more     ✅ PASS
  → 20 concurrent requests, event.ticketsCommitted goes 1→2→3→4→5 in the logs,
    exactly 5 hold rows exist afterward, exactly 15 rejected with "Not enough tickets remaining"

DEMONSTRATES OVERSELL: naive read-then-write lets more than 5 succeed   ✅ PASS (asserts the failure)
  → 20 of 20 "succeeded", 20 hold rows actually inserted for 5 real seats,
    Postgres's own counter read back as 1 or 2 — the lost update is invisible in the
    aggregate and visible only by counting the real rows, exactly as predicted in the gate re-check
```

Both kept in the repository permanently, per the build spec — the naive method is never called from
the controller, and exists solely so this test can keep demonstrating the failure it replaces.

### Full HTTP flow

| Check | Result |
|---|---|
| Organiser creates a 2-seat event | ✅ 201 |
| Attendee holds 1 | ✅ 201, `eventTicketsRemaining` correct |
| Second attendee asks for 2, only 1 left | ✅ 409 |
| Second attendee asks for exactly 1 | ✅ 201 |
| Now truly sold out, third attempt | ✅ 409 |
| `GET /events/:id` confirms `isSoldOut: true` | ✅ |
| Wrong user releases someone else's hold | ✅ **404**, not 403 — holds are private |
| Real owner releases | ✅ 204, inventory returned to `committed: 0` |
| Releasing the same hold again | ✅ **403** — exists, is theirs, just no longer active |
| Releasing a nonexistent id | ✅ 404 |
| `quantity: 11` (cap is 10) | ✅ 400 |
| No `Authorization` header at all | ✅ 401 — global guard fails closed |

### The sweeper

Backdated a real hold's `expires_at` into the past directly in Postgres, then waited for the next
cron tick with no manual intervention:

```
before:  status=active    committed=1
[35s later, unattended]
after:   status=expired   committed=0
```

Log line: `Sweeper released 1 expired hold(s)`.

---

## 5. Decisions visible in the code

**404 for hold ownership mismatches, 403 for role mismatches — the M2 pattern, applied consistently.**
`EventsService.update()` uses 403 because events are public and hiding existence buys nothing.
`HoldsService.release()` uses 404 for "not yours" because holds are private, and a 403 there would
confirm the id is real. But release *also* uses 403 for "yours, but already converted or expired" —
existence and ownership aren't in question there, only whether the action is still valid. Same
resource, two different failure reasons, two different correct status codes.

**Sold out and "no such event" share one 409.** The `UPDATE`'s zero-rows result can't distinguish
them, and for this endpoint it doesn't need to — both mean "you cannot hold this," and a dedicated
existence check would cost a second query on every *successful* path just to phrase a rare failure
more precisely.

**The sweeper claims one hold per transaction, not the whole batch in one.** A single long
transaction would hold row locks across every event touched by the sweep for its entire duration —
including events with live, contended hold traffic — turning routine maintenance into a stall on the
hot path. Per-hold transactions are held for microseconds each, and the claim itself
(`WHERE status = 'active'` inside the same statement that changes it) is the same atomic-conditional
pattern `create()` uses, so two overlapping sweeper ticks — or a user releasing a hold themselves at
the exact same instant — resolve safely to "the loser affects nothing," never a double-release.

**Quantity is capped at 10 in the DTO, not by rate limiting.** `TR-DEC-004` deferred rate limiting
(repeated abuse over time) to the M8 security review. This is narrower and free: a single request
asking for `quantity: 100000` against a 250-seat event is a shape problem the DTO can reject outright,
not a substitute for the rate limiting that's still an open gap.

---

## 6. Known gaps, named as decisions

- **Rate limiting on hold creation** remains deferred (`TR-DEC-004`). A script could still create many
  *separate* one-quantity holds in rapid succession — the quantity cap doesn't stop that pattern.
- **`release()`'s row lock** (`pessimistic_write`) is held for the transaction's duration rather than
  using the same lock-free atomic-`UPDATE` style as `create()`. Defensible here — release only ever
  touches one row it already knows the id of, so there's no analogous "check across many concurrent
  callers" race to close with a single statement — but worth being able to justify if asked why the
  two methods use different concurrency techniques.
- **No formal test framework wiring beyond this one spec file.** M8 is still where the full suite,
  CI, and the webhook/consumer tests arrive. This file runs today because M3's own checkpoint
  requires the concurrency proof to exist now, not because M8 started early.
- **The sweeper has no metrics or alerting on how many holds it releases per tick.** Fine at this
  scale; worth revisiting if hold volume ever makes "how backed up is the sweeper" a real question.

---

## 7. Running it

```bash
cd backend
docker compose up -d && npm run start:dev   # :3001

# the experiment itself — a real DB, not a mock
npx jest src/modules/holds/test/holds.concurrency.spec.ts --verbose
```

To watch the sweeper without waiting a real 10 minutes, create a hold via the API and then:

```sql
UPDATE ticket_holds SET expires_at = now() - interval '1 minute' WHERE id = '<hold-id>';
```

Wait up to 30 seconds; `status` flips to `expired` and the event's `tickets_committed` decrements,
unattended.
