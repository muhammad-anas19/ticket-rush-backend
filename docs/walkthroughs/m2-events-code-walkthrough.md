# M2 — Events, Schema & Query Performance: Code Walkthrough

Companion to [../qa/phase-2-events-understanding-check.md](../qa/phase-2-events-understanding-check.md),
which teaches the concepts this implements.

**Status:** backend and frontend complete, verified live.

---

## 1. What exists

**Backend**

```
src/modules/
├── events/                  the only module with behaviour in M2
│   ├── entities/event.entity.ts
│   ├── dto/{create-event,update-event,find-events-query,event-response}.dto.ts
│   ├── events.service.ts    listing, detail, create, update (+ ownership check)
│   ├── events.controller.ts 5 routes
│   └── events.module.ts
├── holds/entities/ticket-hold.entity.ts       schema only → M3
├── orders/entities/order.entity.ts            schema only → M5
├── tickets/entities/ticket.entity.ts          schema only → M6
└── payments/entities/processed-event.entity.ts schema only → M5

src/common/dto/pagination-query.dto.ts   shared paging + buildPaginatedResponse
src/database/migrations/…CreateEventsAndTicketingTables.ts
```

| Route | Auth | Notes |
|---|---|---|
| `GET /api/events` | public | Offset-paginated, upcoming-only by default, searchable, sortable |
| `GET /api/events/mine` | organiser | Declared **before** `:id` — see §2 |
| `GET /api/events/:id` | public | Includes live availability |
| `POST /api/events` | organiser | **First route to exercise `RolesGuard`'s deny branch** |
| `PATCH /api/events/:id` | organiser **+ owner** | Two independent checks |

**Frontend**

```
src/entities/event/{model,api,hooks,ui}/    types, axios calls, query hooks, EventCard
src/features/create-event/{model,ui}/       Yup schema + RHF form
src/widgets/event-list/EventList.tsx        search, pagination, three UI states
src/widgets/event-detail/EventDetail.tsx
src/shared/lib/money.ts                     the ONE currency conversion boundary
src/app/events/[id]/page.tsx
src/app/organiser/events/new/page.tsx       server-side role gate
```

---

## 2. Decisions visible in the code

### The inventory counter is `tickets_committed`, in Postgres

`TR-DEC-014` resolved. A hold is a **reservation**, not a sale — the counter goes *up* when someone
holds and *down* when a hold expires unpaid. `tickets_sold` would be a name you have to apologise for.

And it lives in **Postgres, not Redis**, because it is not a display value — it is the thing that
*decides* whether a sale happens, so it must mutate in the same transaction as the hold row it
authorises. Redis cannot join a Postgres transaction: decrement it and fail the insert, and a ticket
vanishes with nobody holding it; commit the insert and lose the decrement, and you oversell.

Postgres is the ledger; Redis (M4) is the whiteboard in the lobby. The whiteboard may be seconds stale
and nobody is harmed. The ledger may never be a whiteboard.

### Index column order is derived from real queries

Two indexes on `events`, and the second is not redundant:

```
idx_events_starts_at              (starts_at)
idx_events_organiser_starts_at    (organiser_id, starts_at)
```

By the **leftmost prefix rule** you can only skip index columns from the *right*. So the first index
serves `WHERE starts_at > now()` and is **useless** for `WHERE organiser_id = $1` — the organiser rows
are scattered through it, like looking for everyone named "Ali" in a phone book sorted by surname.
`/events/mine` needs its own index, and that is why it has one.

`ticket_holds` gets the **opposite** policy: written on every hold attempt, read rarely, so only
indexes a real query needs. Every extra index taxes the hot path — and that path is hottest during a
flash sale, when the system is already at maximum stress.

### Sortable columns are an allow-list, because `ORDER BY` cannot be parameterised

```ts
const SORTABLE = ['startsAt', 'priceCents', 'createdAt', 'title'] as const;
```

A `WHERE` value can be a bound parameter. **`ORDER BY` cannot** — it is part of the query structure, so
a user-supplied string has to be interpolated. The allow-list is the only correct defence, not
tidiness. Verified: `?sortBy=title;DROP TABLE events` returns 400.

### Two checks on `PATCH /events/:id`, on independent axes

```
RolesGuard   → "are you an organiser?"        token only, no DB    → guard
service      → "is this event yours?"         needs the row        → service
```

`@Roles(Organiser)` lets in **every** organiser. Passing it is not permission to edit *this* event.
Conflating the two is exactly how IDOR ships.

The ownership check is in the service rather than a guard because a guard runs before the handler with
nothing loaded — doing it there means querying the event twice, or stashing it on the request and
coupling the two through mutable state.

**403, not 404** — and that is decided per resource. 404 hides *existence*, which is right when
existence is confidential. Events are **public** (there is a public listing and detail endpoint), so the
id is already known and hiding it buys nothing. Orders and holds will return 404 for the opposite
reason.

### Offset pagination, with the ceiling written down

`OFFSET n` makes the database **produce and then discard** n rows, so the work is proportional to the
offset, not the limit: `OFFSET 100000 LIMIT 25` is 100,025 rows of work for 25 returned.

Offset is still right here — tens of events, page numbers are genuinely useful, and `total` comes free
from the same query so "Page 2 of 21 · 41 events" is possible. Keyset would be constant-time at any
depth but can offer none of that, and requires a unique stable sort key or rows silently skip and
duplicate across pages. The switch point is recorded in `pagination-query.dto.ts`.

`limit` is capped at **100**. Without a ceiling, `?limit=1000000` turns a paginated endpoint into a full
table dump — verified 400.

### `EventResponseDto`, not the entity

Two reasons, and the second is a real trap: **TypeScript getters do not survive `JSON.stringify`.**
`ticketsRemaining` and `isSoldOut` are getters on the entity, so returning the entity directly would
silently drop exactly the fields the UI needs most. The DTO calls them explicitly.

### One JOIN, not 26 queries

```ts
qb.leftJoin('event.organiser', 'organiser').addSelect(['organiser.id', 'organiser.email']);
```

`leftJoin` + explicit `addSelect` rather than `leftJoinAndSelect`: we want one column, not a hydrated
`User` per row. Deliberately **not** `eager: true` — eager is invisible at the call site, loads the
relation even when unwanted, and as P1 found, **does not apply to `save()`**, which returned entities
with the relation missing or stale.

### Money crosses representation in exactly one file

`shared/lib/money.ts`. The form takes dollars, storage takes integer cents, and `majorToCents` uses
`Math.round` — not `floor` — because `19.99 * 100` is `1998.9999999999998` in IEEE 754, so flooring
silently charges a cent less. The same float behaviour that made integer cents necessary bites again in
the conversion itself.

---

## 3. The `EXPLAIN ANALYZE` comparison

The M2 deliverable, measured on **50,000 seeded events**.

Query: the real listing query — `WHERE starts_at > now() ORDER BY starts_at, id LIMIT 25`.

**With `idx_events_starts_at`:**

```
Limit  (cost=2.75..6.36 rows=25) (actual time=0.497..0.502 rows=25 loops=1)
  Buffers: shared hit=37
  ->  Incremental Sort  (actual time=0.494..0.497 rows=25)
        Sort Key: starts_at, id
        Presorted Key: starts_at
        ->  Index Scan using idx_events_starts_at  (actual time=0.039..0.216 rows=26 loops=1)
              Index Cond: (starts_at > now())
              Buffers: shared hit=28
```

**Without it** (dropped, then restored):

```
Limit  (cost=2629.87..2629.94 rows=25) (actual time=19.513..19.520 rows=25 loops=1)
  Buffers: shared hit=826
  ->  Sort  (actual time=19.510..19.514 rows=25)
        Sort Method: top-N heapsort  Memory: 26kB
        ->  Seq Scan on events  (actual time=0.056..13.257 rows=37476 loops=1)
              Filter: (starts_at > now())
              Rows Removed by Filter: 12525
              Buffers: shared hit=820
```

| | With index | Without | |
|---|---|---|---|
| Total time | **0.50 ms** | 19.52 ms | **39× slower** |
| Rows read | **26** | 37,476 | 1,441× more |
| Buffers touched | **37** | 826 | 22× more |
| Plan | `Index Scan` | `Seq Scan` + `Sort` | |

### What to actually read in that output

**`rows=25` (estimate) vs `actual rows=…`.** The planner estimated 37,558 rows would pass the filter;
37,476 did. A 0.2% miss — the statistics are good, so the plan choice was well-informed. A *large* gap
is the signal worth hunting: if the planner expects 12 rows and gets 480,000, it chose its whole
strategy on that 12, and the fix is `ANALYZE`, not a new index.

**`Rows Removed by Filter: 12525`** on the seq scan is the waste made explicit — 12,525 rows read,
examined, and thrown away. The index never touches them.

**`Buffers: shared hit=826` vs `37`** is the truest measure of work here. Time varies with cache state
and machine load; buffer counts are deterministic. 22× fewer pages touched is the real win.

**`Incremental Sort` with `Presorted Key: starts_at`** is a nice detail: the index already delivers rows
in `starts_at` order, so Postgres only sorts *within* groups of equal timestamps to apply the `id`
tiebreaker. Without the index it must sort everything (`top-N heapsort`).

**And the honest counterpoint:** a `Seq Scan` is not automatically a bug. On a small table, or when a
query returns most of the rows, sequential reading beats random heap fetches and the planner is right to
choose it. An index earns its keep when you want a *small slice of a big table* — which is exactly what
`LIMIT 25` over 50,000 rows is.

---

## 4. Verified live

| Check | Result |
|---|---|
| Migration: 5 tables, 2 enums, 9 FKs, partial unique indexes | ✅ applied |
| Organiser creates event | ✅ 201, `ticketsRemaining` computed |
| **Attendee creates event** | ✅ **403 "Insufficient permissions"** — `RolesGuard` deny branch, first use |
| **Other organiser edits it** | ✅ **403 "You can only modify your own events"** — ownership ≠ role |
| Owner edits it | ✅ 200 |
| Public listing, no token | ✅ 200 with pagination metadata |
| `?limit=500` | ✅ 400 — cap enforced |
| `?sortBy=title;DROP TABLE events` | ✅ 400 — allow-list holds |
| `priceCents: 19.99` | ✅ 400 "must be an integer number of cents, never a decimal" |
| Malformed UUID | ✅ 400, not 500 |
| Nonexistent id | ✅ 404 |
| Search filter | ✅ `?search=Qawwali` → 5 of 41 |
| Pagination | ✅ page 2 of 21, `hasPrev`/`hasNext` correct |
| `upcomingOnly` default | ✅ past events excluded |
| **`EXPLAIN ANALYZE` with/without index** | ✅ 0.50 ms vs 19.52 ms on 50k rows |
| Frontend build | ✅ 7 routes, middleware 86.5 kB |
| CORS `:3000 → :3001` | ✅ 200 + correct allow-origin |
| Lint + typecheck, both sides | ✅ clean |

One result worth reading twice: `total=1` on the first listing test looked wrong and **was correct** —
`upcomingOnly` defaults true, and the seeded rows kept at that point were the earliest, all in the past.
Reseeded with future dates.

---

## 5. Known gaps, named as decisions

- **`ILIKE '%term%'` cannot use a B-tree index.** A leading wildcard means no fixed prefix, so there is
  nothing for a sorted structure to seek. A real search needs `pg_trgm` + GIN, or full-text search. For
  tens of events a seq scan is genuinely the right plan and an index would be ignored — documented in
  the service rather than "fixed" prematurely.
- **A partial index on `ticket_holds` is deferred to M3.** `WHERE status = 'active'` would be tighter,
  since converted and expired rows are dead weight in the index forever. Deferred because the sweeper's
  real query shape is not known yet, and indexing before you have the query is guessing.
- **`totalTickets` is editable, with only a floor check.** Lowering it below `ticketsCommitted` is
  rejected, but the full interaction belongs with M3's atomic inventory logic rather than bodged in here.
- **Holds, orders, tickets and `processed_events` are schema only.** Tables and indexes exist; no
  behaviour. M3, M5, M6.
- **No tests.** M8. Everything above was verified by hand over real HTTP, which is not the same thing.

---

## 6. Running it

```bash
cd backend  && docker compose up -d && npm run migration:run && npm run start:dev   # :3001
cd frontend && npm run dev                                                          # :3000
```

Register as an **organiser**, and "Create an event" appears in the session panel. Register as an
**attendee** and it does not — and `POST /api/events` returns 403 if you call it anyway, which is the
part that actually matters.

To reproduce the query-plan comparison, seed volume and drop the index:

```sql
INSERT INTO events (organiser_id, title, venue, starts_at, price_cents, total_tickets, tickets_committed)
SELECT (SELECT id FROM users WHERE role='organiser' LIMIT 1),
       'Event ' || g, 'Venue ' || (g % 500),
       now() + ((g % 2000) - 500) * interval '1 day',
       500 + (g % 9500), 100 + (g % 900), 0
FROM generate_series(1, 50000) g;
ANALYZE events;

EXPLAIN ANALYZE SELECT id, title FROM events
 WHERE starts_at > now() ORDER BY starts_at, id LIMIT 25;

DROP INDEX idx_events_starts_at;   -- run the EXPLAIN again
CREATE INDEX idx_events_starts_at ON events (starts_at);
```
