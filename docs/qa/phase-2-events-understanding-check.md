# M2 — Understanding Check: Events, Schema & Query Performance

**Date:** 2026-08-19 · **Gate for:** Module 2 (schema, migrations, indexes, pagination, events CRUD)

Answers reproduced verbatim, then graded, then taught properly with analogies — as requested.

---

## Score summary

| # | Topic | Grade |
|---|---|---|
| 1 | What an index costs | **Partially correct** — right instinct, wrong mechanism |
| 2 | Leftmost prefix rule | Don't know |
| 3 | Reading `EXPLAIN ANALYZE` | Don't know |
| 4 | Money storage | **Partially correct** — right conclusion, no mechanism |
| 5 | `TIMESTAMPTZ` | Don't know |
| 6 | Pagination at depth | **Mostly correct** — best answer of the round |
| 7 | The inventory counter | **Partially correct, with a significant misconception** |
| 8 | N+1 in TypeORM | Don't know |
| 9 | The concurrency question (M3 gate) | Don't know |

---

## Q1 — What an index costs

> **Your answer:** i think index makes read fast because we categorize data in indexes and writes slow
> because when we insert anything db has to traverse to last row in order to insert it due to which it
> has to do backward and forward searches when index is implemented

**Grade: partially correct.** "We categorise data" is the right instinct for reads. And your traversal
intuition is real — it just happens in the **wrong place**, which is the correction worth making.

### Reads: the book-index analogy

You want the page about photosynthesis in a 900-page textbook.

- **No index:** start at page 1, read every page. 900 page-turns.
- **With the index:** flip to the back. The index is *sorted*, so you find "photosynthesis" in a few
  seconds, and it says page 214. Two lookups instead of 900.

A B-tree is that idea, one level deeper. It's a tree of sorted pages:

```
                    [ Ka | Ra ]              ← root: 1 page
                   /     |     \
          [Ab|Fa]   [Ma|Pa]   [Sa|Za]        ← internal pages
          /  |  \    ...        ...
      leaves: the actual sorted keys → row locations
```

Each step eliminates most of the remaining data. For **a million rows a B-tree is only 3–4 levels
deep** — so finding one row costs about 4 page reads instead of scanning a million. That is the whole
trick, and it's why the speed-up gets *more* dramatic as the table grows.

### Writes: here is the correction

> "db has to traverse to last row in order to insert it"

**That is not what happens.** A Postgres table (the "heap") is **unordered**. There is no "last row" to
find. When you insert, Postgres consults the **Free Space Map** — a small structure that tracks which
pages have room — and writes the row into any page with space. That's roughly constant work regardless
of table size.

So where does the write cost come from? **Every index has to be updated too.**

Your traversal instinct applies *here*. For each index on the table, Postgres must:

1. **Walk the B-tree** to find the leaf page where this new key belongs (your "backward and forward
   searches" — this part you got right, it's just in the index, not the table).
2. **Insert the entry in sorted position** on that leaf page.
3. **If the leaf page is full — split it.** Allocate a new page, move half the entries across, and
   update the parent to point at both. If the parent is now full, split *that* too, possibly cascading
   to the root.
4. **Write all of it to the WAL** (write-ahead log) first, for durability.

Back to the book analogy: adding one sentence to the book is cheap — write it on a blank page at the
back. But if the book must keep **five** accurate indexes, you now also insert five entries in five
sorted lists, and when a list's page fills up you re-paginate part of it.

> **One row inserted, five indexes = six writes, not one.** That's the cost.

### The asymmetry — the part you didn't answer

This is the practical payoff, and it directly shapes M2 and M3.

| Table | Access pattern | Indexing policy |
|---|---|---|
| `events` | Read constantly (every visitor), written rarely (an organiser creates one) | **Index generously.** The write cost is paid once by one person; the read benefit is paid to everyone, constantly. |
| `ticket_holds` | Written on **every hold attempt**, read less | **Index sparingly.** Every extra index taxes the hot path. |

And `ticket_holds` is not just write-heavy — it's write-heavy **exactly when it matters most**. During a
flash sale, hundreds of people hit `POST /events/:id/holds` at once. Every unnecessary index on that
table is a tax on the moment your system is under maximum stress.

So the rule isn't "indexes are good" or "indexes are expensive". It's: **an index is a trade you make
per table, based on its read/write ratio.**

Two things that follow:

- **An unused index is pure cost** — all of the write penalty, none of the read benefit. You can find
  them: `SELECT * FROM pg_stat_user_indexes WHERE idx_scan = 0;`
- **Every `UNIQUE` constraint is an index**, so it carries the same write cost. That's not a reason to
  avoid them — correctness beats speed — but it's worth knowing you're paying for it.

---

## Q2 — The leftmost prefix rule

> **Your answer:** don't know

This is the highest-signal index question at your level (Q73 in the bank), and the analogy makes it
obvious.

### The phone book

A printed phone book is sorted by **(last name, first name)**. One index, two columns, in that order.

- **"Find Khan"** → Easy. Every Khan is in one contiguous block. ✅
- **"Find everyone whose first name is Ali"** → **Useless.** The Alis are scattered all over the book —
  Ali Ahmed on page 3, Ali Khan on page 210, Ali Zaman on page 490. The sort order gives you nothing.
  You'd have to read the entire book. ❌
- **"Find Khan, Ali"** → Easy. Jump to the Khans, then within that block the first names are sorted, so
  jump straight to Ali. ✅

**The rule:** an index on `(A, B)` can be used for `A`, and for `A AND B`. It **cannot** be used to seek
on `B` alone. You can only skip columns from the *right*, never the left.

### Applied to your question

Index on `ticket_holds (event_id, status)`:

| Query | Uses it? | Why |
|---|---|---|
| `WHERE event_id = $1` | ✅ **Yes** | Leftmost column — like "find Khan" |
| `WHERE status = 'active'` | ❌ **No efficient seek** | Skips the leftmost — like "find all Alis" |
| `WHERE event_id = $1 AND status = 'active'` | ✅ **Yes, both columns** | Like "find Khan, Ali" |
| `WHERE status = 'active' AND event_id = $1` | ✅ **Yes — identical to the row above** | |

### The two that are the same — and why

Rows 3 and 4 are the **same query**. This is the part that catches people.

**SQL is declarative, and `AND` is commutative.** You describe *what* you want; the planner decides
*how*. It normalises your `WHERE` clause before choosing a plan, so writing `status` first changes
nothing at all.

> **Only the column order inside the index matters. The order you type conditions in `WHERE` is
> irrelevant.**

People routinely believe the opposite and reorder their `WHERE` clauses hoping for a speed-up. It does
nothing.

### One honest nuance

For `WHERE status = 'active'`, Postgres *might* still touch the index — if the index is much smaller
than the table, scanning the whole index can beat scanning the whole table. That's a **full index scan**,
not an efficient seek: the work is still proportional to the whole dataset. The interview answer is
"no, leftmost prefix rule" — but knowing the planner has this option is a bonus point.

### What it means for our schema

If we need both "all holds for this event" and "all active holds across every event", one index on
`(event_id, status)` serves the first and not the second. The second needs its own index starting with
`status`. **Column order is a design decision driven by your actual queries** — not alphabetical, not
arbitrary.

---

## Q3 — Reading `EXPLAIN ANALYZE`

> **Your answer:** don't know

### The analogy

- **`EXPLAIN`** = the recipe the chef *plans* to follow. No cooking happens.
- **`EXPLAIN ANALYZE`** = they actually cook it, with a stopwatch, and tell you what really happened.

The difference matters: `EXPLAIN ANALYZE` **runs the query**. Never run it casually on an `UPDATE` or
`DELETE` — it will really modify your data. (Wrap it in a transaction and roll back if you must.)

### Decoding the line, piece by piece

```
Seq Scan on events  (cost=0.00..1834.00 rows=50000 width=64)
                    (actual time=0.011..12.4 rows=48213 loops=1)
```

| Piece | Meaning |
|---|---|
`Seq Scan on events` | **How** it's reading: every row, in physical order. (vs `Index Scan`, `Bitmap Heap Scan`.)
`cost=0.00..1834.00` | Planner's guess in **arbitrary units — not milliseconds.** `0.00` = startup cost before the first row; `1834.00` = total. Only meaningful for *comparing* plans.
`rows=50000` | The planner's **estimate** of how many rows come out, based on statistics.
`width=64` | Average bytes per row.
`actual time=0.011..12.4` | **Real milliseconds.** Time to the first row .. time to the last row.
`rows=48213` | How many rows **actually** came out.
`loops=1` | How many times this step ran. **Multiply `actual time × loops`** for the real total — a node with `loops=5000` is doing 5000× the work shown.

### Estimate vs actual — the most useful thing on the page

Here: estimated 50,000, actual 48,213. A 4% miss. **Excellent** — the planner knew what it was doing.

Now imagine this instead:

```
rows=12   (actual rows=480000)
```

The planner expected **12** rows and got **480,000**. That's the signal you're hunting for, because the
planner *chose its whole strategy* based on that 12. Expecting a dozen rows, a nested loop is perfect.
Getting half a million, it's a catastrophe — the query that should take 8ms takes 40 seconds.

**The bad plan is a symptom. Bad statistics are the disease.** Causes and fixes:

- **Stale statistics** → `ANALYZE events;` to refresh them. (Autovacuum usually does this, but a table
  that just received a bulk load may not have been analysed yet.)
- **Not enough detail** → raise `default_statistics_target` (or per-column) so Postgres samples more.
- **Correlated columns** → the planner assumes columns are *independent*. If your data has `city =
  'Karachi'` implying `country = 'Pakistan'`, it multiplies the two selectivities and badly
  underestimates. Fix: `CREATE STATISTICS` on the column group.

### When a Seq Scan is the *right* plan

This is the part most people get wrong — they see `Seq Scan` and assume "missing index".

**A sequential scan is often correct:**

1. **Small tables.** For 200 rows, reading them all in physical order is faster than an index lookup
   plus a random jump into the heap for each hit. The index adds overhead and buys nothing.
2. **When you're returning most of the table.** This is the important one. An index gives you row
   *locations*, and then Postgres must fetch each row from the heap — **random** I/O, jumping around
   the disk. Sequential reading is dramatically faster per row. So if a query returns 60% of the table,
   scanning sequentially beats 60% of a table's worth of random jumps.

Rule of thumb: past roughly **5–10% selectivity**, a seq scan often wins.

> **An index helps when you want a small slice of a big table.** An index on a `status` column where
> 90% of rows are `'active'` does nothing for `WHERE status = 'active'` — you're asking for almost
> everything, so the planner correctly reads everything.

### What we do in M2

Capture `EXPLAIN ANALYZE` on `GET /events` **before and after** adding indexes, and keep both. The point
isn't the index — it's being able to say "here is the plan node that changed, and here is why."

---

## Q4 — Money

> **Your answer:** we should use decimal because in float it becomes hard to calculate exact amount

**Grade: partially correct.** Right conclusion, and "hard to calculate exact amount" is pointing at the
real problem. But "hard" understates it — it's **impossible**, for a specific and knowable reason. In an
interview, the mechanism is the answer.

### Why floats are wrong — the analogy

Try writing **1/3** as a decimal: `0.3333333...` forever. You have to stop somewhere, and the moment you
stop, you've stored something that is *not* one third.

Binary floating point has the same problem — just with **different numbers**. In binary, `0.1` is:

```
0.0001100110011001100110011...  (repeating forever)
```

A `double` gets 53 bits and then must stop. So the value stored is not 0.1. It's *approximately* 0.1.

**The number that breaks it**, and you can run this in any browser console right now:

```js
0.1 + 0.2
// → 0.30000000000000004
```

That is not a JavaScript bug. That is IEEE 754, the floating-point standard used by essentially every
language and by Postgres's `REAL`/`DOUBLE PRECISION`.

### What that does to real money

**Accumulating error.** Sum 10,000 items of $0.10:

```
expected: 1000.00
actual:   1000.0000000000232
```

Now your books don't balance, and the discrepancy grows with volume.

**Failed equality.** This is the nastier one:

```sql
SELECT * FROM orders WHERE amount = 19.99;   -- returns NOTHING
```

Because what's stored is `19.989999999999998`, and that isn't equal to `19.99`. Your row is right there
and the query can't find it.

**Refunds that don't match.** You charged "$19.99" and refund "$19.99" and end up with a fraction of a
cent adrift, forever, on every transaction.

### Integer cents vs `NUMERIC(10,2)` — both are correct

| | Integer cents (`1999`) | `NUMERIC(10,2)` (`19.99`) |
|---|---|---|
| **Exactness** | Exact — it's just an integer | Exact — decimal arithmetic, no binary conversion |
| **Speed** | **Fast** — native CPU integer maths | Slower — software-implemented arithmetic |
| **Storage** | 4 bytes | Variable, larger |
| **Readable in SQL** | `1999` — you must divide mentally | `19.99` — obvious |
| **DB enforces 2 dp** | No — nothing stops you storing `1999.5`… except it's an int | **Yes** |
| **In Node** | A plain `number` | The `pg` driver returns a **string** |

That last row deserves a note. `pg` returns `NUMERIC` as a **string on purpose** — because converting it
to a JavaScript `number` would put it back into a float and reintroduce the exact bug the column type
exists to prevent. So with `NUMERIC` you need a decimal library (`decimal.js`, `big.js`) for arithmetic.
Fighting that by casting to `number` is a mistake P1's notes call out explicitly.

**This project uses integer cents** — `price_cents`, `amount_cents` — matching the build spec and
matching **Stripe**, whose entire API is denominated in minor units. Given we're integrating Stripe,
using the same representation removes a conversion boundary where bugs would live.

### Fractional cents — what breaks

Integer cents cannot express **$0.001**. Cases where that bites:

- Per-unit pricing (¢0.5 per API call)
- Currency conversion (rates have many decimals)
- Interest, tax, or percentage splits
- Ad impressions billed per thousand

Two fixes, and you pick deliberately:

1. **Store more precision.** Integer *tenths* of a cent, or `NUMERIC(12,4)`. Then define **exactly
   where** rounding happens — and it must be at the point money changes hands, once, not scattered
   through the calculation.
2. **Decide the rounding rule explicitly.** Half-up, half-even ("banker's rounding"), or floor. They
   give different totals across many transactions, and finance will care which one you chose.

**And one thing worth knowing for a Stripe integration:** "cents" isn't universal. **JPY has no minor
unit** — ¥500 is `500`, not `50000`. So the divisor isn't always 100, and any display helper that
hardcodes `/100` is wrong the day you add a second currency. Stripe documents these as "zero-decimal
currencies". We're single-currency, so we hardcode it — but knowingly.

---

## Q5 — `TIMESTAMPTZ`

> **Your answer:** don't know

**The name is actively misleading**, which is most of why this confuses people.

### The analogy

- **`TIMESTAMP`** is a **photograph of a wall clock**. You can see it reads 8:00. You have no idea which
  city's wall it was hanging on. The information is simply not in the photo.
- **`TIMESTAMPTZ`** is **a moment in the history of the universe**. It doesn't matter where you were
  standing — it's the same moment for everyone, and each observer renders it in their own local time.

### The mechanism — and the lie in the name

> **`TIMESTAMPTZ` does NOT store a timezone.** Both types are 8 bytes. There is no room for one.

What it actually does:

```
INPUT:   client sends a value → Postgres converts it TO UTC → stores the UTC instant
                                (using the offset in the value, or the session's TimeZone)
OUTPUT:  stored UTC instant → Postgres converts it FROM UTC → renders in the session's TimeZone
```

The timezone is used **at the boundary, for conversion, and then discarded.** It's a lens, not stored data.

**`TIMESTAMP`** does none of this. It stores the digits you gave it, verbatim, and hands them back
verbatim. No conversion, ever.

### Concrete demonstration

```sql
-- With TIMESTAMPTZ
SET TIME ZONE 'Asia/Karachi';
INSERT INTO events (starts_at) VALUES ('2026-09-01 20:00');   -- stored as 15:00 UTC

SET TIME ZONE 'Europe/London';
SELECT starts_at FROM events;                                  -- reads back 16:00
```

**16:00 is correct.** It is the *same instant*, rendered for London. Karachi's 20:00 and London's 16:00
are one moment.

Now the same thing with plain `TIMESTAMP`:

```sql
-- Karachi client inserts '2026-09-01 20:00'  → stores literally "2026-09-01 20:00"
-- London client reads it                      → gets "2026-09-01 20:00"
```

The London user shows up **four hours late**. Both users see "20:00", both believe they're right, and
nothing in the database is available to tell them apart.

### For "starts at 8pm" to mean one instant

Two things must be true:

1. **The column is `TIMESTAMPTZ`.** Non-negotiable.
2. **The client sends an unambiguous value** — ISO 8601 with an explicit offset:
   `2026-09-01T20:00:00+05:00`, or UTC: `2026-09-01T15:00:00Z`.

That second one is where it breaks silently. If the client sends a bare `2026-09-01 20:00` with no
offset, Postgres has to guess — and it guesses using the **server's** timezone setting. Your app works
perfectly on your laptop and is wrong in production, because the server is on UTC and you are not.

JavaScript makes this easy to get right: `new Date().toISOString()` always produces a `Z`-suffixed UTC
string.

### The nuance worth knowing

For a **future** event in a specific city, storing only the UTC instant has a real flaw: **governments
change DST rules.** If you store "8pm Karachi time" as `15:00Z`, and Pakistan later adopts DST, your
stored instant is now 7pm or 9pm local — not what the organiser meant.

Systems that care store **local wall time + the timezone name** (`Asia/Karachi`) separately, and compute
the instant at read time using current rules.

For TicketRush — one-off events, no recurrence, short booking horizon — `TIMESTAMPTZ` is the right
answer. But that's the honest limitation, and "TIMESTAMPTZ always, except for future local wall-clock
times" is a strong answer.

---

## Q6 — Pagination at depth

> **Your answer:** offset becomes slow because in order to reach page 12475 with limit 25 we have to
> traverse all the top rows due to which query becomes slow. but in cursor pagination we directly pass
> the id of last row we read and immediately jump to next 25. but we lose jump pagination like routing
> for page 1 limit 25 to page 10 limit 25. not sure about 2nd

**Grade: mostly correct — best answer of the round.** You got the mechanism, the fix, and one of the
losses. Let me sharpen one word and give you the missing pieces.

### The analogy

- **`OFFSET`** is counting from the front of a queue every single time. To serve person 12,476, you
  count past 12,475 people first. Then you do it again for the next page.
- **Keyset** is: "the last person I served was #12,475 — **next!**" You never recount.

### Sharpening the mechanism

You said "traverse all the top rows". Precisely: the database must **produce and then throw away** those
rows. It applies the `WHERE`, walks the index or sorts, materialises 12,475 rows it has no intention of
returning, discards them, and *then* collects 25.

> **The work is proportional to `OFFSET`, not to `LIMIT`.**

```
OFFSET 0     LIMIT 25  →     25 rows of work
OFFSET 100   LIMIT 25  →    125 rows of work
OFFSET 100000 LIMIT 25 → 100,025 rows of work   ← same 25 rows returned
```

That's why it degrades **linearly** with page depth. Page 1 is instant; page 4,000 times out.

### Keyset, concretely

```sql
-- Page 1
SELECT * FROM events ORDER BY starts_at, id LIMIT 25;

-- Next page: send back the LAST ROW's sort values as the cursor
SELECT * FROM events
 WHERE (starts_at, id) > ($lastStartsAt, $lastId)   -- row-value comparison
 ORDER BY starts_at, id
 LIMIT 25;
```

The index **seeks straight to that position** and reads 25 entries. **Constant time at any depth** —
page 4,000 is exactly as fast as page 1.

### The second thing you lose — and it's the dangerous one

**The sort key must be unique and stable.** Notice the `, id` in every clause above. That's not
decoration.

Sort by `starts_at` alone, and suppose three events share the same timestamp:

```
page 1 ends at:  starts_at = '2026-09-01 20:00'  (event B)
page 2 asks for: WHERE starts_at > '2026-09-01 20:00'
                 → SKIPS event C, which also starts at 20:00
```

**Rows silently vanish between pages.** Or, with `>=`, they appear twice. Either way the user never
knows.

The fix is the tiebreaker: append a unique column (`id`) to both the `ORDER BY` and the cursor, and use
a row-value comparison. That has a real consequence: **you cannot let users sort by an arbitrary column
unless your cursor includes a unique tiebreaker for it.** Arbitrary user-chosen sorting gets noticeably
harder with keyset.

### And two more, while we're here

- **No cheap total count.** No "Showing 1–25 of 4,832", no page-number row. Getting a total means a
  separate `COUNT(*)` — which is itself a full scan on a large table.
- **Going backwards needs a reversed query.** "Previous page" means flipping the comparison and the
  sort, then re-reversing the results. Doable, fiddly.

### The decision for TicketRush

**Offset pagination in M2**, and that's the right call — `GET /events` will have tens of events, not
millions, and offset is simpler, supports page numbers, and gives a total count for free.

But we write down *where the ceiling is*, so nobody is surprised later. Keyset becomes the right answer
for `/me/tickets` if a user accumulates thousands, or for any admin log. The honest interview answer is
exactly this: **"offset, because the dataset is small and page numbers are worth having — and here is
the specific point at which I'd switch."**

---

## Q7 — The inventory counter

> **Your answer:** c is good we can use redis for it. whenever someone buys a ticket we will reduce
> counter and store count in redis or we can also make it real time which I think is more good

**Grade: partially correct, with a significant misconception.** The shape — option (c) — is right. But
**putting the counter in Redis is precisely the mistake this whole project is designed to teach you not
to make**, so let me correct it directly.

### The analogy that fixes it

Picture a cinema.

- **The whiteboard in the lobby** says "127 seats left". Handy. Everyone can glance at it. If it's a few
  seconds out of date, **nobody is harmed** — someone walks to the counter and finds out for real.
- **The ledger in the box office** is what decides whether you get a seat. It's written in ink, one
  entry at a time, and the person holding the pen only lets one transaction through at once.

**Redis is the whiteboard. Postgres is the ledger.**

You can absolutely let the whiteboard be stale. What you can **never** do is make the whiteboard the
ledger — because a whiteboard has no transactions, and someone can wipe it.

### Why Redis cannot hold the authoritative counter

Three reasons, each sufficient on its own:

**1. Redis cannot participate in a Postgres transaction.** The hold has two effects: insert a
`ticket_holds` row, and commit one unit of inventory. Those must be **all-or-nothing**. With the counter
in Redis:

```
DECR redis counter    ✅ succeeded
INSERT hold row       ❌ failed (constraint, connection drop, crash)
→ a ticket has vanished. Nobody holds it. Nobody can ever buy it.
```

Or the reverse: the DB insert commits, the Redis `DECR` is lost, and now **you oversell** — the
whiteboard says seats remain that don't.

There is no way to make two separate systems commit atomically without a distributed-transaction
protocol, which is far more machinery than this problem deserves.

**2. Redis is not durable in the way money requires.** It's in-memory with periodic snapshots. A crash
can lose the last window of writes. Losing a cache entry costs you a slow page; losing an inventory
decrement means you sold a seat twice.

**3. It contradicts a decision already made.** `TR-DEC-007` states: **Redis is authoritative for
nothing.** Everything in it must be rebuildable from Postgres. That property is exactly what makes
wiping Redis harmless — and it's why the M0 answer about `docker compose down -v` differed between the
two services.

The build spec is blunt about this: *"Where does inventory live? **Postgres, authoritatively.** Redis
caches the display count and handles hold expiry, but the decision 'is there a ticket left' is made in
Postgres inside a transaction. Be able to defend this — interviewers reward it."*

### Your "real time" comment — two separate questions

> "or we can also make it real time which I think is more good"

Real-time delivery is great, and we're building it in M7. But you're merging two questions that must
stay apart:

| Question | Answer | Type of question |
|---|---|---|
| **Where does the truth live?** | Postgres, always | **Correctness** |
| **How does the browser learn it changed?** | WebSockets pushing updates | **Delivery** |

Real-time delivery of a value whose authority is Redis would be **fast and wrong**. Getting the truth
right comes first; making it arrive quickly is a separate, later layer.

### The three options and their real failure modes

**(a) Counter column on `events`, nothing else**
- ✅ Atomic and durable — it lives in the same transaction as the hold.
- ✅ O(1) to read.
- ❌ **It can drift** if any code path changes holds without updating it. One method must own the
  counter, always.

**(b) `COUNT(*)` the holds and orders every time**
- ✅ Cannot drift — it's derived from the rows themselves.
- ❌ Gets slower as holds accumulate, on the hottest read path.
- ❌ **And here is the one that actually disqualifies it:** counting doesn't help you *decide*. Two
  transactions can both count "1 left" at the same moment and both proceed. Counting tells you what
  *was* true; it can't stop someone else acting on the same answer. That's Q9.

**(c) Both — and here's the precise arrangement we build**

```
Postgres counter column  → THE AUTHORITY. Decides every sale, inside a transaction.
COUNT(*) query           → reconciliation. Run it to detect drift; never to decide a sale.
Redis                    → display cache only. Authoritative for nothing. May be stale.
WebSockets (M7)          → delivers changes to browsers quickly.
```

So (c) was the right instinct — the correction is **which layer holds which job.**

### The naming — resolving `TR-DEC-014`

You didn't answer this part, and it's a good small lesson.

The build spec calls the column `tickets_sold`. **That name is a lie**, because a hold is a
*reservation*, not a sale:

- Someone holds a ticket → the counter goes **up**, but nothing was sold.
- The hold expires unpaid → the counter goes **down**. Tickets were "unsold"?

An interviewer reading `tickets_sold` will ask what happens when a hold expires, and you'll have to
explain that your column doesn't mean what it says.

**Decision: `tickets_committed`.** It counts inventory that is spoken for — held *or* sold — which is
exactly what the availability check needs. `remaining = total_tickets - tickets_committed`.

---

## Q8 — N+1 in TypeORM

> **Your answer:** not sure

### The analogy

You need phone numbers for 25 people.

- **N+1:** call the operator once for the list of names, then **call back 25 more times**, once per name.
  26 calls.
- **The fix:** one call — "give me the numbers for all 25 of these people."

The "+1" is the first query; the "N" is one query per row it returned.

### What it looks like in code

```ts
const events = await eventRepo.find({ take: 25 });          // 1 query

for (const event of events) {
  const organiser = await userRepo.findOne({                 // 25 more queries
    where: { id: event.organiserId },
  });
  console.log(organiser.email);
}
```

26 round trips to fetch data one query could have returned. Each is only 1ms — but 26 × 1ms of
*latency* plus 26 × connection-acquisition is a slow endpoint, and it gets worse linearly with page size.

*(TypeORM detail: with default eager-less relations, `event.organiser` is simply `undefined` rather than
silently firing a query. So the N+1 usually arrives via explicitly-written loops like the above, or via
lazy relations typed `Promise<User>`, where `await event.organiser` fires a query invisibly.)*

### How you'd notice

- **Turn on query logging** (`logging: true` in the DataSource) and count the lines for one request.
  26 lines for one endpoint call is the tell. This is the fastest way to find it.
- **`pg_stat_statements`** shows the same query with an absurd `calls` count relative to requests.
- **The symptom in production:** the endpoint is fine with 5 rows and unusable with 100. Performance
  degrades *linearly with page size*, which is the signature of N+1.

### The two TypeORM fixes

**1. Load the relation in the same query**

```ts
// Simple form
await eventRepo.find({ take: 25, relations: ['organiser'] });

// Or with the query builder, for control over what's selected
await eventRepo
  .createQueryBuilder('event')
  .leftJoinAndSelect('event.organiser', 'organiser')
  .take(25)
  .getMany();
```

One query with a `JOIN`. 26 → 1.

**2. `eager: true` on the relation**

```ts
@ManyToOne(() => User, { eager: true })
organiser: User;
```

Now every find-family query loads it automatically, with no call-site changes.

### Which I'd choose, and why — `relations`, explicitly

Three reasons:

1. **`eager` is invisible at the call site.** Reading `eventRepo.find()`, you cannot tell a JOIN is
   happening. Explicit `relations: ['organiser']` is greppable and honest.
2. **`eager` loads it even when you don't need it.** A query that only needs event titles now drags a
   full User row per event, forever.
3. **P1 already got burned by `eager`.** Its notes record that **`eager: true` does not apply to
   `save()`** — only to find-family queries. So `create()` returned an entity with the relation
   *missing*, and `update()` returned a *stale* one. That surfaced in the UI immediately after a change
   and self-corrected on the next refetch, making it maddening to reproduce.

**A third option worth naming:** don't load the entity at all. If `GET /events` only needs the
organiser's *email*, select just that column rather than hydrating a whole `User` per row:

```ts
.select(['event.id', 'event.title', 'organiser.email'])
```

### The trap that comes with the fix

**`JOIN` + `LIMIT` interact badly on one-to-many relations.**

`leftJoinAndSelect` on a one-to-**many** (say event → its holds) with `take: 25` gives you 25 **rows**,
not 25 events — because one event with 3 holds becomes 3 rows. You get 8 events and a wrong page.

TypeORM detects this and silently splits into two queries (IDs first, then data). Good, but know it's
happening, because it changes the performance characteristics.

For **many-to-one** (event → its one organiser), there's no fan-out and a plain JOIN is exactly right.
That's our case in M2.

---

## Q9 — The concurrency question

> **Your answer:** not sure

This is **M3's gate**, so let me teach it properly now. It's the most valuable thing in this document.

### The analogy

Two children, one cookie left on the plate.

Both **look** at the plate. Both see one cookie. Both conclude "there's a cookie, I can take it." Both
reach.

You can't fix that by making them look *faster*. The fix is that **checking and taking must be a single
motion that only one child can perform at a time.**

### What has to be true

> The **check** ("is there a ticket left?") and the **change** ("take it") must be **one atomic
> operation** that the database serialises — not two operations with a gap between them.

"Atomic" here means indivisible: no other transaction can observe or act on the state *between* the
check and the change.

### Exactly what goes wrong with read-then-write

Event with `total_tickets = 5`, currently `tickets_committed = 4`. One ticket left. Two requests arrive
at the same instant:

```
time  T1 (Ali)                              T2 (Sara)
────────────────────────────────────────────────────────────────────────────
 1    SELECT tickets_committed → 4
 2                                          SELECT tickets_committed → 4  ← same value
 3    JS: 4 + 1 <= 5  ✓ proceed
 4                                          JS: 4 + 1 <= 5  ✓ proceed
 5    UPDATE SET tickets_committed = 5
 6                                          UPDATE SET tickets_committed = 5
 7    COMMIT  → hold created
 8                                          COMMIT  → hold created
────────────────────────────────────────────────────────────────────────────
RESULT: 2 holds created. 6 tickets committed against 5 seats.
        And tickets_committed reads 5 — so NOTHING LOOKS WRONG.
```

That last line is what makes this dangerous. There's no error, no exception, no log line. The counter
says 5, which is correct-looking. You find out when two people arrive holding tickets for the same seat.

This has a name: a **lost update**. T2's update overwrote T1's, based on a value it read before T1
committed.

### Three things worth internalising

**1. The bug lives in the gap.** Between step 1 and step 5 there's a window where T1 has decided but
not yet recorded. Any other transaction reading in that window gets a stale answer and makes the same
decision.

**2. You cannot fix it by being fast.** Narrowing the window makes it *rarer*, not absent. Which is
worse than it sounds: it means it passes your tests, passes staging, and appears in production under
real load — where the probability is highest and the consequence is a customer with no seat.

**3. Postgres's default isolation level does NOT prevent this.** This surprises people. The default is
**READ COMMITTED**, and T2's `SELECT` was entirely legal — it read committed data. Isolation levels
protect against a defined list of anomalies (dirty reads, non-repeatable reads, phantoms), and
*application-level* read-then-write is not one READ COMMITTED covers. Raising it to `SERIALIZABLE` would
catch it — with a serialisation failure you'd have to retry — but there's a simpler answer.

### The fix — one statement where the condition and the change are inseparable

```sql
UPDATE events
   SET tickets_committed = tickets_committed + $qty
 WHERE id = $id
   AND tickets_committed + $qty <= total_tickets
RETURNING tickets_committed;
```

**Zero rows affected = sold out.** That's the entire mechanism.

Why it works, step by step:

1. T1's `UPDATE` takes a **row lock** on that event row.
2. T2's `UPDATE` arrives and **physically waits** — Postgres blocks it until T1 commits.
3. When T1 commits, T2 **re-evaluates its `WHERE` clause against the new committed value.** This is the
   crucial part: `5 + 1 <= 5` is now false.
4. T2 matches **zero rows**. The service reads "0 rows updated" and returns "sold out".

Note what we did **not** write: any lock. The database's row-level locking does the serialising, because
we asked it a question and made a change in the same breath. The condition is evaluated against the
value *at the moment of the update*, not a value we read earlier and hoped was still true.

### The other two approaches, so you can compare them

**Pessimistic — `SELECT ... FOR UPDATE`**

```sql
BEGIN;
SELECT tickets_committed FROM events WHERE id = $1 FOR UPDATE;  -- locks the row NOW
-- check in application code, safely: nobody else can read-for-update this row
UPDATE events SET tickets_committed = ... WHERE id = $1;
COMMIT;
```

Correct, and sometimes necessary when the decision is too complex for one `WHERE` clause. Cost: the lock
is held for the whole transaction rather than one statement, so it serialises more and for longer.

**Optimistic — a `version` column**

```sql
UPDATE events SET tickets_committed = $new, version = version + 1
 WHERE id = $1 AND version = $versionIReadEarlier;
```

Zero rows means someone else changed it first; the application retries. Good for low-contention data.
Bad for a flash sale, where high contention means retry storms.

**For inventory, the conditional atomic `UPDATE` wins**: one statement, one round trip, no application
retry loop, and the shortest possible lock duration.

### This is the M3 experiment

M3 writes the naive version **on purpose**, fires 20 concurrent requests at an event with 5 tickets, and
watches it oversell. Then swaps in the atomic version and watches exactly 5 succeed. Both stay in the
repo.

Which is how you get to say, truthfully: *"I've seen oversell happen. I wrote the version that fails,
proved it fails, and fixed it."*

---

## Verdict

**M2: proceed, with the concepts doc read alongside the code.**

The reasoning is specific, not generous. M2's failure modes are mostly **visible and cheap**: a missing
index makes something slow, and `EXPLAIN ANALYZE` shows you exactly where. Nothing here silently
corrupts data. Q1's mechanism error and Q2/Q3's gaps are the kind of thing that genuinely lands better
with hands on a real query plan than from reading first — which is why the M2 plan captures
`EXPLAIN ANALYZE` before and after every index, rather than just adding indexes.

Two answers in this round were **not** merely gaps and are already fixed by decision:

- **Q7's misconception mattered**, and it's corrected: the counter lives in **Postgres**, Redis is a
  display cache authoritative for nothing, and `TR-DEC-014` resolves to **`tickets_committed`**.
- **Q6 was genuinely good** and the decision follows your reasoning: offset pagination in M2, with the
  switch-to-keyset threshold written down.

**M3: NOT ready. Holding that gate.**

Q9 was the M3 gate showing its hand and it came back "not sure". That's exactly why I asked it early. A
misconception there produces code that **passes every test and oversells under load** — the one failure
class in this project that is invisible until it costs a real customer a real seat.

### Before M3, study these — in this order

1. **Re-read Q9 above** until you can draw the two-column timeline from memory. That diagram *is* the
   answer.
2. **Lost update** — the canonical form: two transactions read a balance of 100, both subtract 10,
   result is 90 instead of 80. Then the three fixes and when each is right. *(Bank Q83)*
3. **Isolation levels** — READ COMMITTED (Postgres default), REPEATABLE READ, SERIALIZABLE, and which
   anomaly each prevents: dirty read, non-repeatable read, phantom read. Critically: **know that READ
   COMMITTED does not prevent lost update.** *(Q82)*
4. **MVCC** — why an `UPDATE` writes a *new row version* rather than modifying in place, and why that
   makes `VACUUM` necessary. *(Q86)*
5. **`SELECT ... FOR UPDATE` vs atomic `UPDATE` vs optimistic version columns** — and when each is
   right. *(Q85)*

I'll re-ask on all five before M3 opens.

### Added to the learning tracker

`btree-write-amplification` · `free-space-map` · `leftmost-prefix-rule` · `explain-analyze-estimate-vs-actual`
· `when-seq-scan-is-correct` · `ieee754-and-money` · `integer-minor-units` · `zero-decimal-currencies`
· `timestamptz-stores-utc-not-a-zone` · `offset-degradation` · `keyset-requires-stable-unique-sort`
· `inventory-authority-must-be-transactional` · `n+1-and-eager-vs-relations` · `lost-update`
· `atomic-conditional-update`
