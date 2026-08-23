# M4 — Redis: Code Walkthrough

**How this project implements the ideas taught in
[`concepts/04-redis.md`](../concepts/04-redis.md).** That document explains cache-aside, TTL,
stampede, and the cache-vs-truth line standalone; this one shows exactly where each piece lives in
shipped code, and why the shape it took here isn't the naive version of the pattern.

**Status:** complete and verified live, including a real design fork the naive version of
cache-aside would have gotten wrong for this project specifically.

---

## 1. What exists

```
src/cache/
├── cache.service.ts       getOrSet (cache-aside + single-flight lock), invalidate, bumpVersion, getStats
├── cache.controller.ts    GET /api/cache/stats — the checkpoint's "hit ratio you can quote"
└── cache.module.ts

src/modules/events/
├── events.service.ts      findAll/findOne now cache-aside; create/update invalidate
└── test/events.cache.spec.ts   the stampede + never-stale-availability proof

src/modules/holds/
└── holds.service.ts       hold:<id> countdown key, written/deleted alongside Postgres
```

| Route | Cached? | Notes |
|---|---|---|
| `GET /api/events` | ✅ static shape + total, 60s TTL | availability merged in live on every call |
| `GET /api/events/:id` | ✅ static shape, 60s TTL | same |
| `GET /api/events/mine` | ❌ deliberately | single-viewer page; nothing to protect the DB from |
| `GET /api/cache/stats` | — | reads the hit/miss counters `getOrSet` maintains |

---

## 2. The fork the naive version of this pattern would have gotten wrong

The textbook description of cache-aside is "cache the response." Doing that literally here means
caching `EventResponseDto`, which includes `ticketsRemaining` and `isSoldOut` — precisely the two
fields `TR-DEC-014` and the M2 gate correction say must never be stale, because a wrong read there
isn't cosmetic, it's what an oversell gets built on.

So the cache doesn't hold `EventResponseDto`. It holds a narrower shape:

```ts
interface CachedEventStatic {
  id: string;
  title: string;
  description: string | null;
  venue: string;
  startsAt: string;        // ISO string — see the note on dates below
  priceCents: number;
  totalTickets: number;
  organiser?: { id: string; email: string };
  createdAt: string;
}
```

`ticketsCommitted`, `ticketsRemaining`, `isSoldOut` are absent by construction — there is no field to
accidentally cache stale, because the type doesn't have one. Every call to `findOne`/`findAll`, cache
hit or miss, runs one more query for the live count and merges it in immediately before returning:

```ts
async findOne(id: string): Promise<EventResponseDto> {
  const cacheKey = `cache:event:${id}`;
  const staticEvent = await this.cache.getOrSet(cacheKey, EVENTS_CACHE_TTL_SECONDS, () =>
    this.fetchEventStaticFromDb(id),
  );

  const committedById = await this.getLiveCommittedCounts([id]);
  if (!committedById.has(id)) {
    throw new NotFoundException('Event not found');
  }

  return this.mergeLiveAvailability(staticEvent, committedById);
}
```

The live query is deliberately cheap and deliberately batched — one round trip for however many ids
are on a page, never one per row:

```ts
private async getLiveCommittedCounts(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows: Array<{ id: string; tickets_committed: number }> = await this.events.query(
    `SELECT id, tickets_committed FROM events WHERE id = ANY($1)`,
    [ids],
  );
  return new Map(rows.map((row) => [row.id, row.tickets_committed]));
}
```

`Repository.query()` on a plain `SELECT` returns `Row[]` directly — no tuple-shape trap here, unlike
the `UPDATE ... RETURNING` calls M3 got bitten by. Worth stating precisely: the tuple shape is a
property of non-`SELECT` queries, not of `.query()` in general, and this method is the case where
that distinction actually matters for getting the type right.

**Dates are stored as ISO strings inside the cached shape, not `Date` objects.** `JSON.stringify`
would turn a `Date` into a string anyway, but leaving the source type as `Date` would mean the
cache-hit path (`JSON.parse` → string) and the cache-miss path (`toStaticShape` → `Date`, until it's
serialized) return differently-typed values for a moment — a real bug shape if anything downstream
ever forgot which path it was on. Storing the string explicitly on both paths removes the seam.

---

## 3. Cache-aside and the single-flight lock, as shipped

```ts
async getOrSet<T>(key: string, ttlSeconds: number, fetcher: () => Promise<T>): Promise<T> {
  const cached = await this.redis.get(key);
  if (cached !== null) {
    await this.redis.incr(HIT_COUNTER_KEY);
    return JSON.parse(cached) as T;
  }

  await this.redis.incr(MISS_COUNTER_KEY);

  const lockKey = `lock:${key}`;
  const acquiredLock = await this.redis.set(lockKey, '1', 'PX', LOCK_TTL_MS, 'NX');

  if (acquiredLock === 'OK') {
    try {
      const value = await fetcher();
      const jitterSeconds = Math.floor(Math.random() * ttlSeconds * JITTER_RATIO);
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds + jitterSeconds);
      return value;
    } finally {
      await this.redis.del(lockKey);
    }
  }

  // lost the lock — someone else is refilling; poll briefly, then fetch directly if they never finish
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(LOCK_WAIT_STEP_MS);
    const refilled = await this.redis.get(key);
    if (refilled !== null) return JSON.parse(refilled) as T;
  }
  return fetcher();
}
```

The `SET ... NX` is what makes this safe under real concurrency, and it's safe for the same reason
`concepts/04-redis.md` Q1 explains: Redis executes one command at a time, so when 25 concurrent
requests all issue `SET lockKey 1 PX 5000 NX` at once, Redis still processes them one at a time
internally — exactly one sees "key didn't exist, now it does, OK"; every other one sees "key already
exists, NX failed, null." There's no window where two callers both believe they won.

**Invalidation is a `DEL`, never a write.** `EventsService.update()`:

```ts
const saved = await this.events.save(event);
await this.cache.invalidate(`cache:event:${id}`);
await this.cache.bumpVersion(EVENTS_LIST_CACHE_NAMESPACE);
return saved;
```

No branch writes a new value into `cache:event:<id>` directly — see `concepts/04-redis.md` Q2 for
why that's the one instinct to actively avoid, not just an alternative with different tradeoffs.

**List invalidation is a version bump, not a key scan.** Every `findAll` cache key embeds the current
value of `version:events-list`:

```ts
const version = await this.cache.getVersion(EVENTS_LIST_CACHE_NAMESPACE);
const cacheKey = `cache:events:list:v${version}:${this.buildListCacheKey(query)}`;
```

`create()` and `update()` both call `cache.bumpVersion('events-list')`. That single `INCR` makes
every previously-cached list key — for every combination of page/search/sort that happened to be
cached — stop being read, in one O(1) operation, regardless of how many such keys exist. See
`TR-DEC-023` for why this beats `SCAN`-and-delete.

---

## 4. Verified live

### The stampede proof (`events.cache.spec.ts`)

```
25 concurrent findOne() calls against a COLD key
  → exactly 1 call to fetchEventStaticFromDb (the spy)                          ✅ PASS
  → all 25 responses correct and identical
```

### The rule the whole module exists for

```
findOne(id) → ticketsRemaining: 10           (cache now warm)
UPDATE events SET tickets_committed = 4      (bypasses the cache entirely, like a real hold would)
findOne(id) → title unchanged (from cache), ticketsRemaining: 6 (live, NOT from cache)   ✅ PASS
```

### Invalidation on write

```
findOne(id).title === 'Original Title'
update(id, { title: 'Renamed Title' })
findOne(id).title === 'Renamed Title'                                           ✅ PASS
```

### Hit/miss counters

```
cold findOne  → +1 miss
warm findOne  → +1 hit
warm findOne  → +1 hit
```

Confirmed against the live dev server too, not just the test DB — `GET /api/cache/stats` before and
after two identical `GET /api/events` calls moved from `{hits: 6, misses: 59}` to
`{hits: 7, misses: 59}`, the second call served entirely from Redis.

---

## 5. The Redis hold-countdown key

`HoldsService.create()`, immediately after the Postgres transaction that actually decides the outcome
commits:

```ts
await this.redis.set(
  this.holdCountdownKey(result.hold.id),
  result.hold.expiresAt.toISOString(),
  'PX',
  HOLD_DURATION_MS,
);
```

Outside the transaction, deliberately — Redis can't join a Postgres rollback, and `TR-DEC-007` already
settles that this key is authoritative for nothing, so there's nothing here worth undoing if the write
fails. `release()` and the sweeper both `DEL` it. See `TR-DEC-025` for why nothing reads this key yet:
the frontend already gets `expiresAt` directly and computes its own countdown, and RabbitMQ (M6), not
this key's own expiry, is the mechanism that actually triggers a release — a Redis key expiring is a
fire-and-forget notification with no delivery guarantee, which is the entire reason M6 exists instead
of relying on this.

---

## 6. Decisions visible in the code

See `DECISIONS.md`: `TR-DEC-022` (cache the static shape, read availability live), `TR-DEC-023`
(version-counter invalidation for lists), `TR-DEC-024` (single-flight lock over jitter alone),
`TR-DEC-025` (the countdown key's scope in M4).

**`findMine` stays uncached.** It's an organiser's own dashboard — one viewer, low traffic. Caching
exists to protect the database from many readers hammering the same hot key; there's no "many
readers" here to protect against, so caching it would be the pattern applied because it exists rather
than because the endpoint needs it.

---

## 7. Known gaps, named as decisions

- **No cache warming.** The very first request after a TTL expiry (or after a version bump) is always
  a real miss, paying the full query cost. Acceptable at this traffic scale; a background refresh-
  ahead-of-expiry job would be the fix if a hot key's occasional slow request ever became a real
  complaint.
- **Version counters never reset.** `version:events-list` grows forever, one `INCR` per write. Harmless
  — Redis integers don't meaningfully overflow at any realistic write volume — but worth naming so it
  doesn't look like an oversight.
- **The lock-wait timeout (1s) and lock TTL (5s) are not configurable**, only constants in
  `cache.service.ts`. Fine at current scale; would want tuning knobs before trusting this under
  unknown production load.

---

## 8. Running it

```bash
cd backend
docker compose up -d && npm run start:dev   # :3001

# the stampede + never-stale-availability proof — a real DB and real Redis, not mocks
npx jest src/modules/events/test/events.cache.spec.ts --verbose
```

### Seeing it, not just measuring it

`docker compose up -d` also brings up **RedisInsight** (`TR-DEC-026`) at
[http://localhost:5540](http://localhost:5540) — a GUI over the same Redis the app uses, for
watching the mechanism happen rather than inferring it from counters. Takes 60–90s to finish booting
the first time; refresh if it doesn't load immediately.

**First-time setup (once per RedisInsight install, not per session):** open the URL, "Add Redis
database", host `redis`, port `6379`, no password, no TLS. It doesn't auto-discover the sibling
container by name resolution from the browser — `redis` only resolves inside the Compose network,
which is exactly where RedisInsight's own backend runs, so the hostname is correct even though your
browser itself can't reach `redis:6379` directly.

**Things worth actually watching happen, live:**

- Hold a ticket, then find `hold:<id>` in the key browser — watch its TTL count down in real time,
  and watch it vanish the instant you release the hold or it expires.
- Hit `GET /api/events/:id` once, find `cache:event:<id>` — then `PATCH` that event and watch the key
  disappear (invalidation), not get overwritten.
- Browse for `version:events-list` as a plain integer key, and watch it increment on every event
  create/update — then look at how many now-orphaned `cache:events:list:v<old>:*` keys are sitting
  there with a countdown of their own (`TR-DEC-023`'s "leave them for their own TTL" in action).

To watch the hit ratio move in real time:

```bash
curl http://localhost:3001/api/cache/stats
curl http://localhost:3001/api/events > /dev/null   # miss, populates the cache
curl http://localhost:3001/api/cache/stats           # misses +1
curl http://localhost:3001/api/events > /dev/null   # hit
curl http://localhost:3001/api/cache/stats           # hits +1
```
