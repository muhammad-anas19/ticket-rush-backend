# Redis, explained from first principles

**Standalone concept doc** — this explains Redis on its own terms, no TicketRush code yet. The
matching walkthrough (`m4-redis-code-walkthrough.md`) will show exactly how these ideas map onto
`GET /events`, `GET /events/:id`, and the hold countdown once M4 is implemented.

This doc exists because the M4 gate came back with three honest "don't know"s and one wrong-but-
reasoned guess. Good — a guess you can inspect is more useful than a guessed-right answer you can't
explain. Each section below states the question, explains the mechanism, and where you guessed,
says exactly where the guess broke.

---

## 1. Why Redis is fast — precisely, not just "it's in-memory"

**The keyword-level answer:** Redis keeps data in RAM, not on disk, so reads/writes skip the disk
seek entirely. True, but it's not the whole story, and it's not the part that matters for this
project.

**The mechanism:** Redis runs command execution on a **single thread**. Every command — `GET`,
`SET`, `INCR`, `LPUSH`, whatever — runs to completion before the next one starts. There is no second
thread that could be reading a key while the first is halfway through writing it.

**Why that's a correctness feature, not just a speed one.** Think about Postgres, or any
multi-threaded database. Two connections can try to update the same row at the same time, so the
database needs **locks** — mechanisms to make one transaction wait for another — to stop them from
corrupting each other's work. That's the entire reason M3 exists: `UPDATE ... WHERE tickets_committed
+ $1 <= total_tickets` takes a row lock precisely because two Postgres backends *could* otherwise run
concurrently and race.

Redis never has that problem for a single command, because there's only ever one thing running at a
time. `INCR counter` — read the value, add one, write it back — cannot be interrupted halfway by
another `INCR counter` on a different connection, because there is no "halfway" from another thread's
perspective. The single thread finishes the whole command before it even looks at the next one in its
queue. This is called **atomicity by construction**: you get it for free, with zero lock code,
because the concurrency problem that locks exist to solve simply cannot occur within one command.

**The analogy:** Imagine a small shop with exactly one cashier. Ten customers can be in line, but the
cashier rings up one sale completely — scan, total, payment, receipt — before starting the next
customer's sale. You never get a "mixed" transaction where customer A's items get scanned into
customer B's receipt, because there's no second cashier to collide with the first mid-transaction.
Now imagine the same shop with five cashiers sharing one till drawer — now you need a rule ("only one
cashier touches the drawer at a time") to prevent them from double-counting the same cash. That rule
is a lock. Redis has one cashier. It never needed the rule.

**Where "single-threaded" stops helping you:** it only protects *one command*. If your application
does `GET counter` then, in separate code, computes `counter + 1` and does `SET counter <newvalue>`,
that's **two Redis commands** with your own code running in between — and two concurrent requests
absolutely can interleave there, each reading the same starting value and both writing the same
result, losing an increment. This is the *exact same lost-update shape* as the M3 Postgres bug. The
fix is the same shape too: use a single atomic command (`INCR`, or a Lua script, which Redis also
runs as one atomic unit) instead of read-then-write-in-your-own-code. **Single-threaded buys you
per-command atomicity, not transaction-shaped atomicity across multiple commands** — that distinction
is worth stating exactly like that if asked.

**Correction to internalize:** "Redis is fast because it's in-memory" answers a performance question.
"Redis is single-threaded, so any single command is atomic with no lock overhead — but chaining
commands in application code reopens the same race condition Postgres locks exist to close" answers
the interview question. The second sentence is the one worth having ready.

---

## 2. Cache-aside — the pattern, and where your guess broke

**Your answer:** *"when cache miss we will look into db and than update the redis and then send
response to user, on write cache will be invalidated because if we directly update it than maybe our
db will not be updated with new record"*

The read-path half is exactly right. The write-path *reasoning* has the causality backwards — let's
fix that precisely, because the real reason is more interesting and it's the reason this pattern
exists at all.

### The read path (you had this correctly)

```
request comes in for event X
  → ask Redis: GET event:X
  → HIT?  → return it, done. Database never touched.
  → MISS? → ask Postgres for event X
          → write the result into Redis (SET event:X <data> EX 60)
          → return it to the caller
```

The **application** populates the cache, not Redis itself. Redis is a passive key-value store — it
doesn't know what a "miss" means or go fetch anything on your behalf. Your service code is the thing
that notices the miss, goes to the source of truth, and writes the result back into Redis before
answering. That's the "aside" in cache-aside: the cache sits *beside* the data path, and your
application code is the one stepping around it on a miss.

### The write path (this is where the guess needs correcting)

Here's an organiser calling `PATCH /events/:id` to change the title. Two options exist:

**Option A — update the cache too.** Write the new title to Postgres, then also write the new title
into the Redis key, so the cache reflects the change immediately.

**Option B — invalidate (delete) the cache key.** Write the new title to Postgres, then `DEL
event:X`. The next `GET` is a guaranteed miss, which re-reads from Postgres and repopulates the
cache with fresh data.

**We use B. Your instinct to invalidate was right. The reason you gave — "maybe our DB will not be
updated with new record" — isn't the actual danger. The DB write either succeeds or the whole request
fails; there's no scenario where the app proceeds to touch the cache with an update that never
committed to Postgres, because you'd only reach the caching step after the DB write already
succeeded.**

The real danger with Option A is a **race between two concurrent writers**, and it's structurally
identical to the M3 lost-update problem:

```
Organiser A calls PATCH, changes title to "Summer Fest"
Organiser B calls PATCH, changes title to "Summer Fest 2.0" — a split second later

If both go to the DB and then update the cache directly, the ORDER of the two cache writes
is not guaranteed to match the order the DB writes actually landed in. Two things running on
separate connections, both slightly delayed by network jitter, can complete in either order.

Suppose A's DB write lands first, then B's DB write lands (Postgres now correctly has "Summer
Fest 2.0" — B won, as it should, since B was last). But suppose A's cache write happens to
arrive at Redis AFTER B's cache write, because A's request took a slightly slower path back.

Now Redis says "Summer Fest" while Postgres says "Summer Fest 2.0" — permanently wrong, until
the TTL eventually expires and forces a re-read. Every reader hits the cache and sees stale
data with NO signal that anything is wrong.
```

Deleting the key instead of writing to it sidesteps this entirely: whichever writer's `DEL` runs
doesn't matter, because deleting is **idempotent** — deleting a key that's already gone is a no-op,
and deleting it three times has the same effect as once. There's no "last write wins with a
different, wrong entry" outcome, because there's no data being written to race over. The very next
`GET`, from anyone, is forced to go ask Postgres — the actual source of truth — and whatever it says
is authoritative, full stop.

**The one-sentence version, corrected:** *update-the-cache-directly is dangerous not because the DB
write might fail, but because two concurrent writers' cache updates can complete in the opposite
order from their DB writes, leaving the cache confidently wrong with no expiry to save you until the
TTL runs out. Deleting the key instead of writing to it removes the race entirely, because deletion
has no ordering to get wrong.*

---

## 3. TTL — why 60 seconds, and what you're actually trading off

TTL (time-to-live) is Redis's built-in self-destruct timer on a key. `SET event:X <data> EX 60` means
"this key deletes itself automatically 60 seconds from now, no application code required."

**The analogy:** think of it like a "best by" date stamped on a carton of milk, except the carton
physically vanishes from the fridge the instant the date passes, whether or not anyone's looking.
Nobody has to remember to check the date and throw it out — the fridge does it for you.

**What TTL trades against what.** Every cached value sits somewhere on a line between "always
correct" and "always fast," and the TTL length is the dial:

- **Too long (say, 1 hour):** if an organiser edits the event description, and for some reason the
  cache invalidation on that write didn't fire (a bug, a bypass, a code path that forgot to `DEL`),
  every visitor for up to an hour sees the stale description. TTL is your **backstop**, not your
  primary invalidation mechanism — it's the safety net that guarantees "wrong, but only wrong for at
  most this long" even if the explicit invalidation logic has a bug somewhere. A long TTL means a
  wide window for that backstop to matter, i.e., a bug hides for longer before self-correcting.

- **Too short (say, 2 seconds):** you barely reduce database load at all, because the cache expires
  almost as fast as requests refill it. Worse, under real traffic, a 2-second expiry on a popular key
  means it's constantly flipping between "hot, being read from cache" and "just expired, everyone
  piling onto Postgres to refill it" — which is exactly the stampede problem in Q4 below, and a short
  TTL makes stampedes happen *more often*, not less.

**Why 60 seconds specifically, for `GET /events` and `GET /events/:id`:** it's a judgment call, not a
formula, but the reasoning goes: event titles, descriptions, venues, and prices change rarely — an
organiser edits them occasionally, not every few seconds. A 60-second staleness window on "what does
this event's description say" is invisible to a real user; nobody reloads a page twice in one minute
to check if the venue text changed. Meanwhile 60 seconds is long enough that a popular event page
under real load hits the cache for the overwhelming majority of requests instead of hammering
Postgres on every single pageview. If this were a field that changed every few seconds instead
(availability count — see Q5), 60 seconds of staleness would be a **user-facing bug**, not a
harmless tradeoff, which is exactly why that field is never cached at all regardless of TTL.

**The precise cost statement, stated the way an interviewer wants it stated:** *"TTL too long widens
the window where a cache-invalidation bug goes unnoticed; TTL too short defeats the purpose of
caching by forcing near-constant refills, which under load turns into repeated stampedes. 60 seconds
here is chosen because it's short enough that staleness is imperceptible to a human reading rarely-
changing fields, and long enough to absorb real read traffic on hot event pages without hitting
Postgres on every request."*

---

## 4. Cache stampede (a.k.a. thundering herd)

**The scenario, mechanically:** a popular event's page is cached under key `event:X`, TTL 60 seconds.
500 people are looking at it right now, each request hitting the cache — fast, cheap, one Redis read
each. At second 60, the key expires and vanishes. At second 61, the *next* request comes in, gets a
cache miss (correctly — the key really is gone), and starts a database query to refill it.

**The problem:** if 500 people are hitting refresh roughly together (a popular event does get
simultaneous traffic, that's what "popular" means), it isn't just *one* request that misses at second
61 — it's dozens or hundreds, all in the same instant, because they all had the same 60-second TTL
starting from roughly the same moment the key was first written. **Every one of those requests
independently decides "cache miss, I'll go ask Postgres,"** and all of them fire a nearly identical
query at the database at the same moment. Postgres, which was happily serving zero queries for this
event a moment ago (everyone was hitting Redis), suddenly gets hit with 500 simultaneous identical
queries. For a cheap query this might just be wasteful; for an expensive one, or under enough
concurrent popular events expiring near-simultaneously, this can be enough sudden load to slow down
or take down the database — the exact thing the cache existed to prevent.

**The analogy:** picture a single open door into a stadium, closed for exactly one minute while staff
do something quick behind it, then reopened. If people were trickling in one at a time, no problem.
But if a large queue built up *while the door was still open* and is now all waiting for the same
reopening moment, the instant it swings open, everyone surges through at once — the door is fine,
what breaks is whatever is immediately on the other side that wasn't built for 500 simultaneous
arrivals.

**One concrete mitigation (there are several; naming one is enough for the gate):**

**Single-flight refill (a.k.a. request coalescing).** When a cache miss happens, before querying
Postgres, the application first tries to acquire a short-lived Redis **lock key** (e.g. `SETNX
event:X:lock 1 EX 5`). Only the request that successfully acquires the lock actually queries
Postgres and refills the cache; every other concurrent request that also missed simply waits a few
milliseconds and retries the Redis read, which by then is populated by the winner. Instead of 500
requests hitting Postgres, exactly 1 does, and the other 499 get served from Redis moments later once
the winner has refilled it. This is the same principle as M3's atomic `UPDATE ... WHERE` — one
gatekeeping condition that only one caller can satisfy, and everyone else falls back to reading the
result instead of redoing the work themselves.

*(A second, complementary mitigation worth knowing exists but isn't the one to lead with: **jittered
TTLs** — instead of every key expiring at exactly 60s, randomize slightly (55–65s) so keys for
different events don't all expire in lockstep, spreading refill load over time instead of
concentrating it into instants.)*

---

## 5. The line between "stale is fine" and "stale is a bug" — the one that matters most

This is the direct continuation of the M2 correction: putting `tickets_committed` or
`ticketsRemaining` in Redis was the wrong instinct, and the fix was keeping inventory in Postgres,
checked by an atomic `UPDATE`, never read from a cache.

**The rule, stated as one sentence:** *staleness is acceptable exactly when nobody acts irreversibly
on the stale value before the system gets a chance to double-check it for real; staleness is a
correctness bug exactly when someone (a person or the code) treats the cached number as ground truth
and takes an action that can't be undone based on it.*

**Apply it to two more examples from this project, one on each side:**

**Side A — safe to cache: the event's title, description, venue, and price.** If Redis serves a
title that's 45 seconds out of date because an organiser just edited it, the *worst* outcome is a
user reads a slightly-stale description for under a minute. Nobody's money moves, nobody's seat is
double-booked, and the very next click (like actually holding a ticket) round-trips to the real
backend regardless of what the page displayed. The stale read is cosmetic and self-heals on its own
via TTL expiry. This is exactly why `GET /events` and `GET /events/:id`'s non-numeric fields are
prime cache-aside candidates.

**Side B — unsafe to cache: `ticketsRemaining` / `isSoldOut`, and by the same logic, whether a
specific hold is still active.** If Redis says "3 tickets left" for 40 more seconds after the real
count actually hit zero, every one of those 40 seconds is a window where the frontend shows a "Hold a
ticket" button that *will* 409 the instant it's pressed, or worse, if the availability check itself
were ever read from cache instead of computed live in the `UPDATE ... WHERE` condition, it could
actually let a sale through that the real inventory can't support — an oversell, the exact failure M3
exists to prevent. The cost here isn't cosmetic; it's money and inventory correctness, and it cannot
self-heal by waiting out a TTL, because the wrong action (an oversold seat) already happened before
the TTL got a chance to expire.

**Why this is genuinely the important question of the whole module:** a system that caches a title
wrong is embarrassing. A system that caches availability wrong sells a ticket that doesn't exist,
which is the one failure this entire project's five-technology list was built around preventing (see
the "Concurrency" row in the root `CLAUDE.md` table — "Two people buying the last ticket at once.
Postgres decides, atomically"). Redis speeding up a read is a nice-to-have; Redis silently becoming
the thing an oversell decision is based on is the specific mistake to never make here.

---

## 6. Invalidation on write — what has to happen, and the failure if you skip it

An organiser calls `PATCH /events/:id`, changing (say) the venue from "Hall A" to "Hall B".

**What must happen, precisely:** immediately after the Postgres `UPDATE` commits, the application
must `DEL` every cache key that could contain this event's now-stale data — at minimum `event:<id>`
(the detail cache) and, since the event also appears inside list responses, whatever key(s) back the
`GET /events` listing cache (or that listing cache needs its own, typically shorter, invalidation
story — worth naming as a design decision when M4 is actually implemented, not glossed over).

**What happens if you forget it — the concrete bad outcome, not just "stale data":** say the
organiser is fixing the venue because the *original* venue got double-booked by another event and
attendees would show up at the wrong building. The `PATCH` succeeds, Postgres now correctly says
"Hall B." But the Redis key `event:X` still holds the old cached response with "Hall A," and will
keep serving it to every visitor for up to the remaining TTL. If the TTL is 60 seconds, that's a
minor annoyance. But if this event page happened to get cached earlier with a *longer* TTL, or if the
sweep of "which keys need invalidating" missed the listing cache (a very real bug shape — remembering
the detail key but forgetting the list key that also embeds this event's data), attendees could be
shown the wrong venue for as long as that forgotten key's TTL runs, with zero indication anything is
wrong — the page loads fine, the data's just wrong. This is the cache-invalidation equivalent of the
M3 tuple bug: the underlying write was completely correct, but a downstream consumer of that write
(here, everyone reading the cache) never got the memo, and nothing throws an error to reveal it.

**Why this reinforces "TTL is a backstop, not a plan" from Q3:** the *only* reason a forgotten
invalidation self-heals at all is that the TTL eventually expires anyway. If TTL were infinite (never
expiring, cache-forever), a missed invalidation would be permanently wrong until a human noticed and
manually flushed the key. TTL is what turns "this bug lasts forever" into "this bug lasts at most N
seconds" — necessary, but explicit invalidation-on-write is what makes the *normal* case correct
within milliseconds instead of relying on the backstop to eventually cover the mistake.

---

## 7. Redis beyond caching — the two other things this project needs it for

Caching is one use of Redis; it's a **data-structure server** underneath, and this project leans on
that for at least two more mechanisms named directly in `backend/docs/phases.md`'s M4 scope and
`TR-DEC-007`'s three-layer hold-expiry design:

**1. TTL keys as a "this expires by itself" primitive — the hold countdown.** Right now (M3), a
hold's expiry is enforced by Postgres's `expires_at` column plus the 30-second cron sweeper checking
"is anything past its expiry" on a polling interval. That works, but it's polling — the sweeper might
notice a hold expired anywhere from 0 to 30 seconds late, and it's constant background query load
even when nothing has expired. A Redis key with a TTL exactly matching the hold's duration (e.g. `SET
hold:<id> 1 EX 600` for a 10-minute hold) gives you a **precise, self-expiring signal** with zero
polling: Redis fires a keyspace-notification event the instant that key disappears, which (from M6
onward, per `TR-DEC-007`'s RabbitMQ TTL+DLX layer) becomes the trigger to release the hold immediately
rather than waiting for the next sweep. A plain string value in a database row can't notify anyone
when it "expires" — expiry there means "a query has to go and check the clock," which is exactly the
polling behavior a TTL key removes.

**2. Pub/Sub — the mechanism M7's WebSocket fan-out is built on.** "127 tickets left" needs to update
live for everyone watching an event page, across however many backend instances are running. A plain
in-memory list of "who's currently connected" only knows about sockets connected to *that one
instance* — if instance A's hold-purchase changes the count, instance B's connected clients never
hear about it unless something bridges the two processes. Redis's `PUBLISH`/`SUBSCRIBE` (or the
`socket.io-redis` adapter that wraps it) is that bridge: every instance subscribes to a channel, any
instance can publish "event X's count changed" to it, and every instance — including ones that had
nothing to do with the write — receives the message and can push it down to its own connected
sockets. A plain key-value string can't do this: a string is something you have to actively poll and
compare against its last-seen value to notice a change; Pub/Sub *pushes* the notification the instant
it happens, to every subscriber, with no polling anywhere in the path. That distinction — push versus
poll — is the same shape as the TTL-key-vs-polling-sweeper distinction in point 1, and it's worth
having both examples ready since they're really the same underlying idea applied twice: **Redis lets
you react to an event the instant it happens, instead of periodically asking "has anything changed
yet?"**

---

## Recap — the one thing to hold onto from all seven

Every answer above traces back to the same handful of ideas, applied to different problems:

- **Single-threaded → atomic per command, not atomic across commands** (Q1) — the same lost-update
  shape as M3, just at the Redis layer instead of the Postgres layer.
- **Cache-aside invalidates rather than updates because deletion has no ordering to get wrong under
  concurrent writers** (Q2) — the same "don't let two racing writers corrupt shared state" theme as
  M3, solved differently because Redis's job here is disposable, not authoritative.
- **TTL is a backstop against invalidation bugs, not the primary correctness mechanism** (Q3, Q6) —
  explicit `DEL`-on-write does the real work; TTL just bounds the damage when that's missed.
  Same for a forgotten invalidation.
- **Stampede is many independent cache-misses converging on the database at once; single-flight
  refill turns "many workers redo the same work" into "one worker does it, everyone else waits and
  reads the result"** (Q4) — conceptually the same gatekeeping idea as M3's atomic `UPDATE`.
- **The cache-vs-truth line is drawn at reversibility: cache what nobody acts irreversibly on; never
  cache what a wrong read turns into an unrecoverable action** (Q5) — the single most important rule
  in this module, and the one M2's Q7 already cost you once.
- **Redis's real value beyond speed is push-not-poll: TTL keys and Pub/Sub both let the system react
  the instant something happens instead of periodically asking** (Q7).

Ready to move into M4 implementation whenever you are — cache-aside on `GET /events` /
`GET /events/:id`, TTL + explicit invalidation on the events write paths, and a look at where
single-flight refill is worth adding given this project's real traffic shape.
