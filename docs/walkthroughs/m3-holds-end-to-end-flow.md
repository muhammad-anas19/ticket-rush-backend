# M3 — Holds: End-to-End Flow

**What this document is.** A line-by-line trace of every request the Holds module handles — from the
browser click, through every guard and pipe, into the transaction, down to the exact SQL, and back
out. Companion to
[m3-holds-code-walkthrough.md](m3-holds-code-walkthrough.md), which covers *decisions* and the tuple
bug; this one covers *mechanism* — what actually happens, in order, for each endpoint.

Every code fragment below is the real, current file, not a paraphrase.

---

## 0. The pieces, and where they live

```
backend/src/modules/holds/
├── entities/ticket-hold.entity.ts   the table: id, eventId, userId, quantity, status, expiresAt
├── dto/create-hold.dto.ts           request body: { quantity }
├── dto/hold-response.dto.ts         response body: the projection clients see
├── holds.service.ts                 create · createNaive · release · sweepExpiredHolds
├── holds.controller.ts              POST /events/:eventId/holds · DELETE /holds/:id
└── holds.module.ts                  wiring

frontend/src/
├── entities/hold/{model,api,hooks}/ types, axios calls, TanStack mutations
├── features/hold-ticket/ui/HoldTicket.tsx   the button + countdown + release UI
└── shared/lib/useCountdown.ts       the deadline-based timer
```

Two routes exist. Everything below traces both, plus the sweeper, which isn't a route at all but runs
on its own clock.

---

## 1. `POST /api/events/:eventId/holds` — creating a hold

### 1.1 What the browser actually sends

`HoldTicket.tsx`'s button, when clicked, calls:

```ts
createHold.mutate({ quantity: 1 }, { onSuccess: (hold) => setActiveHold(hold) });
```

which is a TanStack `useMutation` wrapping:

```ts
// entities/hold/api/hold.api.ts
export async function createHold(eventId: string, payload: CreateHoldPayload): Promise<Hold> {
  return api.post<Hold>(`/events/${eventId}/holds`, payload);
}
```

`api.post` is the thin envelope-unwrapping wrapper around the shared `axiosClient`. Before this
request leaves the browser, axios's request interceptor (`shared/api/axiosClient.ts`) has already run
and attached `Authorization: Bearer <accessToken>` — reading the token from module-scope state kept in
sync by `AuthTokenSync`, refreshing first only if the cached token is within 30 seconds of expiry. So
by the time this arrives at NestJS, it looks like:

```
POST /api/events/3859c93b-.../holds
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json

{"quantity": 1}
```

### 1.2 The NestJS request pipeline, in the order it actually runs

```
JwtAuthGuard  →  RolesGuard  →  ValidationPipe (CreateHoldDto)  →  HoldsController.create()
```

**`JwtAuthGuard`** (global, registered via `APP_GUARD` in `app.module.ts`) runs first. It checks for
`@Public()` on the route — `HoldsController.create` has none — so it verifies the Bearer token's
signature and expiry, and on success attaches `{ id, email, role }` to `request.user`. No token, or a
bad one, and the request never reaches the controller at all: **401**, guard fails closed by design.

**`RolesGuard`** runs next. `HoldsController` carries no `@Roles()` decorator anywhere — the class-level
comment says why: *"any authenticated user may [hold], attendee or organiser."* With no required roles
declared, this guard is a no-op pass-through. Being authenticated at all is the entire bar.

**`ValidationPipe`** (global, `whitelist: true, forbidNonWhitelisted: true, transform: true`) then
constructs a `CreateHoldDto` from the body. `{"quantity": 1}` passes `@IsInt() @Min(1) @Max(10)`
cleanly. Send `{"quantity": 11}` instead and the pipe rejects it with 400 *before the controller method
is ever called* — no database round trip is spent on an obviously-invalid request.

**`ParseUUIDPipe`** on the `:eventId` route param runs alongside the body validation. A malformed id
like `not-a-uuid` is rejected with 400 here, rather than reaching Postgres and erroring as a raw driver
exception that would otherwise surface as a 500 — an input mistake, correctly reported as one.

### 1.3 Inside the controller

```ts
async create(
  @Param('eventId', ParseUUIDPipe) eventId: string,
  @Body() dto: CreateHoldDto,
  @CurrentUser() user: CurrentUserPayload,
) {
  const { hold, ticketsCommitted } = await this.holds.create(eventId, user.id, dto.quantity);
  return HoldResponseDto.from(hold, ticketsCommitted);
}
```

`@CurrentUser()` reads `request.user` — the object `JwtAuthGuard` attached. **Not the body.** There is
no `userId` field anywhere in `CreateHoldDto`; a client cannot hold a ticket on someone else's behalf
by supplying a different id, because there is no field to supply. The controller is three lines: pull
the verified identity, call the service, shape the response. Everything that can go wrong happens one
layer down.

### 1.4 Inside `HoldsService.create()` — the transaction

```ts
async create(eventId: string, userId: string, quantity: number) {
  return this.dataSource.transaction(async (manager) => {
    const [rows] = await manager.query<QueryResultTuple<{ tickets_committed: number }>>(
      `UPDATE events
          SET tickets_committed = tickets_committed + $1
        WHERE id = $2
          AND tickets_committed + $1 <= total_tickets
      RETURNING tickets_committed`,
      [quantity, eventId],
    );

    if (rows.length === 0) {
      throw new ConflictException('Not enough tickets remaining');
    }

    const expiresAt = new Date(Date.now() + HOLD_DURATION_MS);
    const hold = manager.create(TicketHold, { eventId, userId, quantity, status: HoldStatus.Active, expiresAt });
    await manager.save(hold);

    const ticketsCommitted = rows[0].tickets_committed;
    return { hold, ticketsCommitted };
  });
}
```

`dataSource.transaction(...)` opens `BEGIN`, hands the callback an `EntityManager` bound to that one
transaction, and issues `COMMIT` when the callback resolves — or `ROLLBACK` if it throws. **Every
statement inside uses that `manager`**, never `this.holds` (there is no such repository — the
constructor only takes `DataSource`, on purpose, so there is nothing to reach for by habit that would
silently write outside the transaction).

**Statement 1 — the atomic conditional `UPDATE`.** This is the whole mechanism:

- Postgres takes a row lock on the matching `events` row for the duration of this statement.
- A second, concurrent `UPDATE` targeting the *same* row does not read a stale value and race ahead —
  it physically **blocks**, waiting for this transaction to finish.
- When it does resolve, that concurrent statement re-evaluates its own `WHERE` clause against whatever
  was **actually committed**, not against anything it read earlier. There is no earlier read to go
  stale, because there is no separate read step at all — the check and the write are one statement.
- **Zero rows returned** means the `WHERE` clause matched nothing: either the event doesn't exist, or
  `tickets_committed + quantity` would exceed `total_tickets`. One query can't distinguish those two
  causes, and this endpoint doesn't try to — both mean "you cannot hold this," and 409 says so without
  confirming or denying which.

Note the destructuring: `const [rows] = await manager.query(...)`. `manager.query()` on any
non-`SELECT` statement returns a **tuple**, `[rows, affectedCount]`, not the rows array directly — a
real bug lived exactly here before the concurrency test caught it (see the companion walkthrough,
§3, for the full story of how `rows.length === 0` was silently dead code for an entire test run).

**If zero rows came back**, a `ConflictException` is thrown *inside* the transaction callback. TypeORM
catches that, issues `ROLLBACK`, and rethrows — so nothing this call did (there was nothing to undo
yet; the failed `UPDATE` matched no row to begin with) persists, and Nest's global
`AllExceptionsFilter` turns the exception into the `409` envelope the client receives.

**Statement 2 — the hold row.** Only reached if the `UPDATE` succeeded. `manager.create()` builds an
unsaved `TicketHold` instance; `manager.save()` issues the `INSERT`, still inside the same transaction.
`expiresAt` is computed as `Date.now() + 10 minutes` — a fixed instant, not a duration; this is the
value the frontend's countdown will treat as gospel.

**Commit.** Both statements succeed, `dataSource.transaction()` issues `COMMIT`, and the inventory
increment and the new hold row become visible to every other transaction **at the same instant** —
never one without the other.

### 1.5 Back out through the layers

The service returns `{ hold, ticketsCommitted }`. The controller wraps it:

```ts
return HoldResponseDto.from(hold, ticketsCommitted);
```

`HoldResponseDto.from` is an explicit projection — it copies exactly the fields a client should see
(`id`, `eventId`, `quantity`, `status`, `expiresAt`, and `eventTicketsRemaining` computed from the
`ticketsCommitted` this very transaction returned) rather than serialising the entity directly. Then:

- Nest's `ClassSerializerInterceptor` runs (nothing to strip here — `TicketHold` has no `@Exclude()`
  fields, unlike `User.passwordHash`).
- `ResponseEnvelopeInterceptor` wraps the whole thing in `{ success: true, data: {...}, timestamp }`.
- `@HttpCode(HttpStatus.CREATED)` sets the status to 201.

What the browser receives:

```json
{
  "success": true,
  "data": {
    "id": "89dad944-...",
    "eventId": "3859c93b-...",
    "quantity": 1,
    "status": "active",
    "expiresAt": "2026-08-23T03:45:17.669Z",
    "eventTicketsRemaining": 1
  },
  "timestamp": "2026-08-23T03:35:17.675Z"
}
```

`api.post<Hold>(...)` unwraps the envelope, so `createHold()` resolves with just the `data` object.
TanStack's `onSuccess` fires with that `Hold`, and two things happen at once:

```ts
onSuccess: (hold) => setActiveHold(hold)          // component-local: HoldTicket now renders the countdown
```
```ts
// inside useCreateHold's OWN onSuccess, which ran first
void queryClient.invalidateQueries({ queryKey: eventKeys.details() });
void queryClient.invalidateQueries({ queryKey: eventKeys.lists() });
```

The cache invalidation is deliberately **not** a `setQueryData` patch using `eventTicketsRemaining`
from this response. That number describes the state immediately after *this* write; by the time it
renders, other concurrent holds may have already changed it again. Invalidating asks the server for
the current truth on next read instead of asserting a snapshot that may already be stale — the same
principle the whole module is built around, applied to the cache layer too.

### 1.6 The countdown, once `activeHold` is set

```ts
const countdown = useCountdown(activeHold?.expiresAt ?? new Date().toISOString());
```

`useCountdown` does **not** start a "10:00" timer and decrement it. Every tick recomputes
`expiresAt - Date.now()` from the fixed deadline the server issued. A backgrounded tab that gets
throttled to one tick a minute, or suspended entirely, shows the correct remaining time — or correctly
"expired" — the instant it wakes, rather than a counter that silently paused and needs to catch up.

### 1.7 The failure path — losing the race

If the `UPDATE` in §1.4 matched zero rows, the chain above never reaches step 1.5's success case.
Instead:

```
409 → { success: false, message: "Not enough tickets remaining", statusCode: 409, ... }
```

`useCreateHold`'s `onError` fires:

```ts
onError: (error) => toast.error(getErrorMessage(error)),
```

`getErrorMessage` reads the backend's message **verbatim** — no substitution, no "Sorry, something
went wrong." Losing the race for the last seat is the exact scenario this module exists to make
correct, so the user sees precisely what happened: someone else got there first. `activeHold` was
never set, so the button simply returns to its normal, clickable state — retryable, not stuck.

---

## 2. `DELETE /api/holds/:id` — releasing a hold early

### 2.1 The trigger

`HoldTicket.tsx`, while a hold is active:

```tsx
<Button onClick={() => { releaseHold.mutate(activeHold.id); setActiveHold(null); }}>
  Release
</Button>
```

`setActiveHold(null)` here is optimistic **locally only** — it stops this widget's own countdown. It
does not assert to anything else that the release succeeded; the event's real availability comes back
through the invalidated query, exactly as in the create path.

### 2.2 Guards and pipes

Same `JwtAuthGuard` → `RolesGuard` (no-op, no `@Roles()`) → `ParseUUIDPipe` on `:id` sequence as
creation. No request body to validate — `DELETE` carries none here.

### 2.3 Inside `HoldsService.release()`

```ts
async release(holdId: string, userId: string): Promise<void> {
  return this.dataSource.transaction(async (manager) => {
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

    await manager.query(
      `UPDATE events SET tickets_committed = tickets_committed - $1 WHERE id = $2`,
      [hold.quantity, hold.eventId],
    );
  });
}
```

**`setLock('pessimistic_write')`** — unlike `create()`'s lock-free atomic `UPDATE`, this takes an
explicit row lock (`SELECT ... FOR UPDATE`) on the hold itself, held for the whole transaction. That's
the right tool here for a reason worth being precise about: there's no analogous "many callers racing
to decide the same thing" scenario to close with a single conditional statement — this method already
knows exactly which row it means (`holdId`), so the lock exists purely to serialise against a
*second* release attempt or a sweeper tick landing on the same row at the same instant, not to make a
decision atomic the way the inventory `UPDATE` does.

**Two branches, two different status codes, on purpose:**

```
hold doesn't exist, OR belongs to someone else   → 404  "Hold not found"
hold is theirs, but already converted/expired    → 403  "This hold is no longer active"
```

The first case is deliberately ambiguous — a caller cannot tell "no such hold" from "that hold exists
but isn't yours" from the response alone, because holds are **private**. Confirming existence via a
403 would let someone enumerate valid hold ids by probing. Contrast `EventsService.update()`, which
uses 403 for an ownership mismatch — because events are *public*, so hiding existence there buys
nothing. Same axis (ownership), opposite resource privacy, opposite correct status code.

The second case is different in kind: the caller unambiguously owns this hold, so there's nothing to
hide — the problem is purely that the action no longer makes sense. Releasing an already-`converted`
hold would hand back inventory for a seat that was genuinely sold, which is a correctness bug, not a
courtesy.

**On success:** the hold flips to `Expired` (the same status value the sweeper uses — "released early
by the user" and "expired on the clock" are the same terminal state, just reached differently), and
the second `UPDATE` decrements `tickets_committed` by exactly the quantity this hold reserved, in the
same transaction, so a crash between the two statements is impossible to observe as a half-applied
state — either both happen or neither does.

### 2.4 Response

`@HttpCode(HttpStatus.NO_CONTENT)` — **204**, empty body. The controller method returns nothing:

```ts
async release(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: CurrentUserPayload) {
  await this.holds.release(id, user.id);
}
```

`ResponseEnvelopeInterceptor` wraps even an empty return, but 204 responses conventionally carry no
body regardless — the frontend's `releaseHold()` types its return as `Promise<void>` and never reads
one.

`useReleaseHold`'s `onSuccess` invalidates the same two query key groups as creation and toasts
`"Hold released"` — a genuine success, not a relayed backend message, since there's no backend text to
relay for a 204.

---

## 3. The sweeper — not a route, but the third path through this code

`HoldsService.sweepExpiredHolds()` carries `@Cron(CronExpression.EVERY_30_SECONDS)`. No browser ever
calls this; `ScheduleModule.forRoot()` (registered once, globally, in `app.module.ts`) invokes it on a
timer for as long as the Nest process is alive.

```ts
@Cron(CronExpression.EVERY_30_SECONDS)
async sweepExpiredHolds(): Promise<void> {
  const candidates: Array<{ id: string }> = await this.dataSource.query(
    `SELECT id FROM ticket_holds WHERE status = 'active' AND expires_at <= now()`,
  );
  if (candidates.length === 0) return;

  let released = 0;
  for (const { id } of candidates) {
    const wasReleased = await this.dataSource.transaction(async (manager) => {
      const [claimed] = await manager.query<QueryResultTuple<{ event_id: string; quantity: number }>>(
        `UPDATE ticket_holds SET status = 'expired'
          WHERE id = $1 AND status = 'active'
        RETURNING event_id, quantity`,
        [id],
      );
      if (claimed.length === 0) return false;

      await manager.query(
        `UPDATE events SET tickets_committed = tickets_committed - $1 WHERE id = $2`,
        [claimed[0].quantity, claimed[0].event_id],
      );
      return true;
    });
    if (wasReleased) released += 1;
  }
  if (released > 0) this.logger.log(`Sweeper released ${released} expired hold(s)`);
}
```

**Step 1 — find candidates.** A plain `SELECT`, outside any transaction, no lock. Reading a slightly
stale list is fine here — the next step re-verifies every candidate individually before acting.

**Step 2 — one transaction per candidate, not one transaction for the whole batch.** A single long
transaction spanning every expired hold across every event would hold row locks on all of them for the
sweep's entire duration — including events with live, contended hold traffic right now — turning
routine maintenance into a stall on the hot path. Per-hold transactions are held for microseconds each.

**Step 3 — the claim, which IS the concurrency control.** `WHERE id = $1 AND status = 'active'` inside
the *same statement* that flips the status is the identical pattern §1.4 uses for inventory: the
condition and the change happen together, so exactly one process can ever win a given hold. If a user
releases the hold themselves (§2) at the same instant a sweeper tick reaches it, whichever one commits
first wins the row; the other's claim matches zero rows and does nothing — never a double-decrement.

**Step 4 — the decrement**, only if the claim actually matched something, using the values `RETURNING`
gave back **from the row that was just claimed**, not from the original candidate list (which could
theoretically have gone stale between steps 1 and 3, though re-verification at claim time makes that
moot).

Nothing about this path touches an HTTP request, a guard, or a DTO — it's the same database mechanism
as the two routes above, invoked by a clock instead of a click.

---

## 4. One diagram, all three paths

```
                              ┌─────────────────────────┐
                              │   events.tickets_committed│  ← the one number every path touches
                              └─────────────────────────┘
                                    ▲        ▲        ▲
                    +qty, if room   │        │        │  -qty
              ┌─────────────────────┘        │        └─────────────────────┐
              │                              │                              │
    POST /events/:id/holds          DELETE /holds/:id              @Cron EVERY_30_SECONDS
    (browser click)                 (browser click)                 (no request at all)
              │                              │                              │
   atomic conditional UPDATE      pessimistic_write lock         claim via conditional UPDATE
   WHERE committed+qty<=total     on the ticket_holds row        WHERE status='active'
   → 201 hold, or 409 sold out    → 204, or 404/403              → decrement, or skip (already gone)
```

Every arrow into the counter is a single SQL statement whose `WHERE` clause is also its concurrency
control. That repetition is not accidental — it's the one idea M3 exists to teach, applied three times.
