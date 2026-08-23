# Backend — Module Plan

Each module is **backend + database first, then the matching frontend slice**
(`frontend/docs/phases.md`). ★ marks the five modules this project exists for.

```
M0  Foundation — Compose (PG + Redis + RabbitMQ), scaffold, config, health, envelope, Swagger
M1  Auth — Argon2id, NextAuth-facing login, organiser/attendee, ownership guard
M2  Events — schema, migrations, indexes, pagination, CRUD
M3  ★ Holds & Concurrency — atomic conditional UPDATE, transaction discipline
M4  ★ Redis — cache-aside, TTL, invalidation, stampede, what we refuse to cache
M5  ★ Stripe — Checkout, raw body, signature, in-transaction dedupe
M6  ★ RabbitMQ — topic exchange, manual ack, idempotent consumers, DLQ, TTL+DLX
M7  ★ WebSockets — Socket.IO gateway, rooms, the two-instance failure, redis-adapter
M8  Tests, CI, security review
```

**Gate rule.** No module's code is written before its `qa/` understanding check is answered and
graded. No exceptions — the gate is the point.

**Timeline.** The build spec targets 14 evenings, which assumes prior familiarity with all five
technologies. With a concepts doc, a graded Q&A, and a walkthrough per module, budget **35–45
sessions**. Stated up front so being at session 20 doesn't read as falling behind.

---

## Status

| Module | Understanding check | Implementation |
|---|---|---|
| M0 | ✅ Graded — [qa/phase-0-foundation-understanding-check.md](qa/phase-0-foundation-understanding-check.md) | ✅ Complete & verified — [walkthroughs/m0-foundation-code-walkthrough.md](walkthroughs/m0-foundation-code-walkthrough.md) |
| M1 | ✅ Graded — [qa/phase-1-auth-understanding-check.md](qa/phase-1-auth-understanding-check.md) | ✅ Backend complete & verified — [walkthroughs/m1-auth-code-walkthrough.md](walkthroughs/m1-auth-code-walkthrough.md) · frontend (NextAuth) next |
| M2 | ✅ Graded — [qa/phase-2-events-understanding-check.md](qa/phase-2-events-understanding-check.md) | ✅ Complete & verified — [walkthroughs/m2-events-code-walkthrough.md](walkthroughs/m2-events-code-walkthrough.md) |
| M3 | ✅ Re-quizzed and passed — see [walkthroughs/m3-holds-code-walkthrough.md](walkthroughs/m3-holds-code-walkthrough.md) §0 | ✅ Complete & verified — [walkthroughs/m3-holds-code-walkthrough.md](walkthroughs/m3-holds-code-walkthrough.md) (decisions + the tuple bug) · [walkthroughs/m3-holds-end-to-end-flow.md](walkthroughs/m3-holds-end-to-end-flow.md) (request-by-request trace) |
| M4 | ✅ Explained in detail with analogies — [concepts/04-redis.md](concepts/04-redis.md) | ✅ Backend complete & verified — [walkthroughs/m4-redis-code-walkthrough.md](walkthroughs/m4-redis-code-walkthrough.md) · frontend slice next |
| M5–M8 | not started | not started |

**M0 checkpoint met.** Three containers healthy; API boots and connects to Postgres and Redis;
readiness returns 503 with Redis stopped while liveness stays 200; readiness stays 200 with RabbitMQ
stopped, by design; error envelope confirmed on a normal route; Swagger live; frontend renders and
reaches the API across CORS. Lint and typecheck clean both sides.

---

## M0 — Foundation

**Goal.** Three containers, a booting API, and a verified connection to each — no domain logic.

**Deliverables.**
1. `backend/docker-compose.yml`: Redis and RabbitMQ (management plugin), **named volumes**, health
   checks, explicit project name. **Postgres runs natively** (PostgreSQL 18, pgAdmin, connecting as
   the `postgres` superuser) — see `TR-DEC-015` for the tradeoffs. One-time setup is creating the
   `ticketrush` database in pgAdmin.
2. Nest scaffold per the established layout: `modules/`, `common/`, `config/`, `database/`, with the
   inward-only import rule.
3. Fail-fast env validation — the process refuses to boot on a missing or malformed variable rather
   than failing at first use. `.env.example` committed, `.env` git-ignored.
4. TypeORM `DataSource` + migration CLI wiring, plus connection retry with backoff.
   `synchronize: false` in every environment including local dev.
5. `@nestjs/terminus` health: `/health/live` (**no dependency checks**) and `/health/ready`
   (Postgres + Redis, deliberately **not** RabbitMQ — see the M0 Q&A, Q6).
6. `ResponseEnvelopeInterceptor` + `AllExceptionsFilter` producing `ApiEnvelope<T>` on every path.
7. Global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`.
8. `app.setGlobalPrefix('api', { exclude: ['health/(.*)'] })` — set now, not retrofitted. P1 added
   its prefix late and lost an evening to cookie paths scoped against the old structure.
9. Swagger at `/docs` (`TR-DEC-004`).

**Checkpoint.** `docker compose up` brings Redis and RabbitMQ healthy; the API boots, connects to
Postgres and Redis, and `/health/ready` reports honestly when a dependency is stopped.

**Docs.** [qa/phase-0-foundation-understanding-check.md](qa/phase-0-foundation-understanding-check.md) ·
`concepts/00-docker-and-service-topology.md` · `walkthroughs/m0-foundation-code-walkthrough.md`

---

## M1 — Auth

**Goal.** Register and login, nothing else. No password reset, no email verification, no profile
pages — the spec's scope discipline holds.

**Deliverables.** `users` entity + migration; Argon2id hashing with a pepper (`TR-DEC-006`);
`POST /api/auth/register` with role self-selection (`TR-DEC-003`); `POST /api/auth/login` returning
`{ user, accessToken, refreshToken }` **in the body**, no cookies (`TR-DEC-001`);
`POST /api/auth/refresh`; `GET /api/auth/me`; `JwtAuthGuard` reading the `Authorization` header;
`@Roles()` + `RolesGuard`; `@CurrentUser()`; and an **ownership guard distinct from the role guard**.

**Checkpoint.** Full register → login → authenticated request → refresh cycle over real HTTP. A token
signed with the wrong secret, an expired token, and a missing header each rejected with the correct
status.

**Docs.** `concepts/01-jwt-sessions-and-refresh-rotation.md`

---

## M2 — Events

**Goal.** The schema this project runs on, and a familiar CRUD module on top of it.

**Deliverables.** Full migration set for `events`, `ticket_holds`, `orders`, `tickets`,
`processed_events` (schema now, behaviour later). `price_cents`/`amount_cents` as **integers, never
float**. `TIMESTAMPTZ` throughout. Deliberate indexes with `EXPLAIN ANALYZE` captured before and
after. Server-side pagination via `PaginatedResponse<T>` with `limit`. Events CRUD with DTO
validation and the M1 ownership guard enforced on update.

Resolve `TR-DEC-014` here — the inventory counter's name and semantics.

**Prove migrations run from empty.** Since `TR-DEC-015` moved Postgres out of Compose, this is a
manual drop-and-recreate in pgAdmin rather than `down -v`. Do it anyway — a migration set that has
only ever run incrementally against a database you evolved by hand is not known to work.

**Checkpoint.** Migration history in the repo; an organiser can create an event; an attendee can list
events; a second organiser gets **403, not 404**, attempting to edit someone else's.

**Docs.** `concepts/02-postgres-indexing-and-query-plans.md` · `concepts/02b-typeorm-migrations.md`

---

## M3 ★ — Holds and Concurrency

**The hardest and most valuable module.** Postgres only — no Redis, no queue.

**Deliverables.** `POST /api/events/:id/holds` creating a hold and committing inventory in a **single
atomic conditional UPDATE**:

```sql
UPDATE events
   SET tickets_committed = tickets_committed + $qty
 WHERE id = $id
   AND tickets_committed + $qty <= total_tickets
RETURNING tickets_committed;
```

Zero affected rows means sold out. No read-then-write, no race window. The hold insert and this
update share one transaction, and **every repository call inside uses the transactional manager** —
miss that and the write silently escapes the transaction. This is a genuine senior tell.

`DELETE /api/holds/:id` for early release. A sweeper releasing expired holds (`TR-DEC-007`).

**Keep transactions short.** Never hold one open across a network call — an HTTP request to Stripe
inside a transaction pins a pooled connection for hundreds of milliseconds and is how pool exhaustion
happens under load.

**The experiment that earns the story.** A test firing 20 concurrent hold requests at an event with
5 tickets, asserting exactly 5 succeed and `tickets_committed` equals 5. Then the naive version —
`SELECT` the count, check it in JS, `UPDATE` — kept in the repo and watched to fail with oversell.
Both versions documented in the README.

**Checkpoint.** The concurrency test passes on the atomic version and **fails on the naive one**.
Both outcomes captured.

**Docs.** `concepts/03-database-concurrency-and-isolation.md` — ACID per letter; the isolation levels
and the anomaly each prevents; lost update; MVCC and why Postgres needs `VACUUM`; optimistic vs
pessimistic locking; `SELECT ... FOR UPDATE` versus the atomic UPDATE and when each is right.

---

## M4 ★ — Redis

**Deliverables.** Cache-aside on `GET /api/events` and `GET /api/events/:id` with a 60s TTL and
invalidation on write. Hit/miss counters so the real ratio can be quoted. Hold countdown keys.
Stampede mitigation — jittered TTLs and single-flight refill.

**The deliberate exclusion.** The availability count is **not cached**. Stale inventory is a
correctness bug, not a performance tradeoff. "I deliberately excluded X because staleness there is a
correctness problem" is worth more than the cache itself.

**Checkpoint.** A measured hit ratio you can quote, and a demonstrated stampede on a cold key.

**Checkpoint met.** `events.cache.spec.ts`: 25 concurrent requests against a cold `GET
/api/events/:id` key trigger exactly 1 database fetch (single-flight lock); a live test proves
`ticketsRemaining` reflects a write made entirely outside the cache's knowledge, even while the rest
of the cached row is still warm; `GET /api/cache/stats` on the running dev server moved from
`{hits:6, misses:59}` to `{hits:7, misses:59}` across two identical list requests. Lint and typecheck
clean; the M3 concurrency suite re-verified passing with the Redis client now threaded through
`HoldsService`.

**Docs.** `concepts/04-redis.md` — single-threaded event loop and why that's fine; cache-aside read
and write paths; TTL tradeoffs; stampede and single-flight refill; the cache-vs-truth line;
`concepts/00-docker-and-service-topology.md`-adjacent data-structure uses beyond caching (TTL keys,
Pub/Sub). [walkthroughs/m4-redis-code-walkthrough.md](walkthroughs/m4-redis-code-walkthrough.md) —
code-level trace, including the fork where caching the whole `EventResponseDto` would have violated
the deliberate exclusion above.

---

## M5 ★ — Stripe

Test mode only. Live keys never touched.

**Deliverables.** `POST /api/holds/:id/checkout` — verifies the hold is `active`, unexpired, and owned
by the caller; creates the order as `pending`; creates a Checkout Session with
`metadata: { holdId, orderId }`. `POST /api/webhooks/stripe` — **raw body** preserved for signature
verification, exempt from the global `ValidationPipe`, registered at the real prefixed path.
Signature verified with `stripe.webhooks.constructEvent`, 400 on failure. Dedupe insert and
fulfilment in **one transaction** (`TR-DEC-008`). Resolve `TR-DEC-011` — payment arriving after the
hold expired.

**The three experiments.** `stripe listen --forward-to localhost:3001/api/webhooks/stripe`; a test
payment with `4242 4242 4242 4242`; `stripe events resend {id}` watched being rejected by the dedupe
guard, log line kept; a tampered signature header confirmed returning 400.

**Checkpoint.** A resent event is a no-op, with the log line to prove it.

**Docs.** `concepts/05-stripe-payments-and-webhooks.md` — why webhooks rather than the client success
callback; signature verification and the attack without it; idempotency; out-of-order events; PCI
scope and why card data must never reach this server.

---

## M6 ★ — RabbitMQ

**Two flows.**

*Fulfilment.* `order.paid` published to a topic exchange on payment confirmation. A consumer generates
ticket rows with codes and logs a fake email. **Manual acknowledgement** — `ack` only after the
database write commits. Resolve `TR-DEC-012` — the dual-write between commit and publish.

*Delayed hold release.* The hold published to a queue with a 600s message TTL and a dead-letter
exchange pointing at `holds.expired`. On TTL the message dead-letters and the consumer releases the
tickets — **only if the hold is still `active`**, so a converted hold isn't wrongly released. This
TTL-plus-DLX pattern is RabbitMQ's native delayed-message idiom and most candidates have never seen it.

**The two experiments.** `throw` inside the fulfilment consumer before the ack, restart it, and watch
the same message redelivered — at-least-once delivery observed rather than read about. Then make the
consumer idempotent (check whether tickets already exist for that order) and confirm redelivery
becomes a safe no-op. Then a retry limit routing repeated failures to a DLQ, so one poison message
can't hot-loop.

**Checkpoint.** Kill the consumer mid-message and still end with exactly the right number of tickets.

**Docs.** `concepts/06-rabbitmq-and-async-messaging.md` — the AMQP model; exchange types; delivery
guarantees; ack/nack/reject; prefetch and what unbounded prefetch breaks; DLQs and poison messages;
why naive immediate requeue is dangerous; RabbitMQ vs Redis lists vs Redis Streams vs Kafka vs SQS.

---

## M7 ★ — WebSockets

**Deliverables.** A Socket.IO gateway with a room per event, broadcasting the new remaining count to
`event:{id}` on hold, purchase, and expiry. Connection authenticated **at the handshake**, not in a
message. Resolve `TR-DEC-013` — token in the handshake versus a single-use Redis ticket.

**The experiment that earns the claim.** Run the API on ports 3000 and 3001 against the same Postgres
and Redis. Two browser tabs, one per instance. Buy through instance A — **instance B's tab doesn't
update.** That's the instance-local broadcast problem, seen rather than read about. Then add
`@socket.io/redis-adapter`, restart both, and watch it work.

**Checkpoint.** Two instances stay in sync, and you can explain precisely what the adapter changed.

**Docs.** `concepts/07-websockets-and-realtime.md` — the HTTP upgrade handshake; frames; ping/pong;
WebSocket vs SSE vs polling; sticky sessions behind a load balancer; why presence is harder than it
looks across instances; what limits connections per Node process.

---

## M8 — Tests, CI, Security Review

**Deliverables.**
- Webhook handler unit tests: valid event fulfils; duplicate `event.id` is a no-op; invalid signature
  returns 400; unknown event type is ignored gracefully.
- The M3 concurrency test — 20 parallel requests, 5 tickets, exactly 5 succeed.
- Consumer idempotency test: the same `order.paid` processed twice yields one set of tickets.
- One Supertest e2e: register → login → create event → hold → assert availability dropped.
- CI: lint, test, build on every push.
- **Security review specific to this domain:** IDOR on holds and orders; webhook replay;
  hold-endpoint abuse as inventory denial-of-service; the `TR-DEC-002` XSS exposure; secrets
  handling. The rate limiting cut in `TR-DEC-004` is recorded here as a known finding, not quietly
  omitted.

**This is the user's first time writing tests of any kind.** Treat it as a teaching module.

---

## End-of-module protocol

1. Update [qa/learning-topics-tracker.md](qa/learning-topics-tracker.md) — mark items practiced, add
   gaps surfaced during implementation, not just during the Q&A.
2. Write the walkthrough against the code that actually shipped, including what surprised you.
3. Confirm the checkpoint above.
4. Only then does the next module's understanding check begin.
