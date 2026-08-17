# M0 — Understanding Check: Foundation, Docker & Service Topology

**Date:** 2026-08-15 · **Gate for:** Module 0 (Compose, scaffold, config, health, envelope)

Questions asked cold, before any code. Answers reproduced verbatim, then graded. Misconceptions are
corrected explicitly rather than softened — the point is to find gaps, not to document around them.

> **Format note.** The P1-dashboard project ran these as teaching documents written directly, not as
> quizzes. This project reverses that on explicit direction: real questions, answered cold, graded
> rigorously. That reversal is recorded here so the difference in tone between the two doc sets isn't
> mistaken for inconsistency.

---

## Score summary

| # | Topic | Grade |
|---|---|---|
| 1 | Container networking | **Partially correct** — real insight, wrong mechanism |
| 2 | `depends_on` and boot ordering | Don't know |
| 3 | Volumes | Don't know |
| 4 | Redis vs RabbitMQ | **Partially correct** — right conclusion, no argument |
| 5 | Fail-fast config | **Partially correct** — principle right, mechanics missing |
| 6 | Liveness vs readiness | **Needs more depth** — contains a misconception |
| 7 | Connection pooling | Don't know |
| 8 | The route that breaks the pipeline | **Incorrect** |
| 9 | `NOT NULL` migration | Don't know |

**Three partial, one misconception, one wrong, four unknown.** Honest and useful — five "don't
knows" told me more than five hedged guesses would have.

---

## Q1 — Container networking

> `DATABASE_URL=postgres://app:pw@localhost:5432/ticketrush` works from your host, fails the moment
> Nest itself runs in Compose. Why? What should the host be, and what resolves that name?

**Your answer:**
> if its wrking than the pgadmin or postgress serveer is installed on my machine and when i put it in
> docker compose than docker pull the postgress image for me from docker hub and ran it so now my
> local server is not being used

**Grade: partially correct.** You spotted something real — that there can be *two different Postgres
instances*, a host-installed one and a containerised one, and that connecting to the wrong one is
possible. That's a genuine trap and I'll come back to it. But it isn't the answer, because in this
scenario Postgres is in Compose **both times**; the only thing that changed is where **Nest** runs.

### What's actually happening

**`localhost` is not a machine. It is a network namespace.**

Every container gets its own network namespace — its own loopback interface, its own routing table,
its own view of "the network." When your Nest process runs *inside a container* and connects to
`localhost:5432`, it is asking for port 5432 **on the Nest container itself**. Nothing is listening
there. Postgres is in a different namespace entirely. Connection refused, immediately, and correctly.

**Why it worked from the host.** Your Compose file publishes the port:

```yaml
ports:
  - "5432:5432"     # hostPort:containerPort
```

That instructs Docker to listen on the *host's* 5432 and forward to the container's 5432. It creates
a **host → container** path. It does nothing for container → container traffic.

**What the host should be: `postgres` — the service name.**

```yaml
services:
  postgres:                                        # ← this name is the hostname
    image: postgres:16
  api:
    environment:
      DATABASE_URL: postgres://app:pw@postgres:5432/ticketrush
```

**What resolves it.** Compose creates a **user-defined bridge network** for the project and attaches
every service to it. Docker runs an embedded DNS server reachable at **127.0.0.11** inside each
container's namespace, and `/etc/resolv.conf` in the container points at it. That DNS server resolves
service names, container names, and network aliases to the container's IP on that network. Unlike the
legacy default bridge, user-defined networks get automatic DNS — which is why this "just works" in
Compose and doesn't with a bare `docker run` on the default bridge.

### Three corollaries worth having

**You use the container port, not the published one.** If you mapped `"5433:5432"` to dodge a local
Postgres, the *host* connects on 5433 but the API container still connects on **5432**, because
container-to-container traffic never touches the published mapping. Mixing these up is a classic
hour lost.

**You don't need `ports:` at all for container-to-container.** Publishing exists purely so *you* can
reach the service with psql or a GUI. In production you'd generally omit it — an unpublished
container is unreachable from outside the Docker network, which is a security property, not a
limitation.

**Your instinct about two databases is a real bug, just a different one.** If you have Postgres
installed on Windows *and* publish the container's 5432, one of two things happens: Docker fails with
`port is already allocated`, or — if the local service is stopped and later starts — you end up
running migrations against one database and reading from the other, and lose an evening to "my table
doesn't exist." **Confirm which Postgres you're on** with `SELECT version(), inet_server_port();` or
by checking `docker compose ps`. Given you appear to have a local install, we'll publish on **5433**
in M0 to keep them unambiguous.

**Also worth knowing now, because M5 needs it:** to reach the *host* from inside a container, the
name is `host.docker.internal` (Docker Desktop provides it automatically; on plain Linux you add
`extra_hosts: ["host.docker.internal:host-gateway"]`). This comes up the moment the Stripe CLI runs
on your host and needs to forward webhooks to a containerised API.

---

## Q2 — `depends_on` and boot ordering

> `depends_on: [postgres]` and it *still* crashes with connection refused. Why doesn't it fix it?
> Two fixes, and which layer each belongs in.

**Your answer:** don't know.

### Why `depends_on` doesn't fix it

**Plain `depends_on` controls start *order*, not *readiness*.** Docker starts the Postgres container,
and the instant the container's main process has been launched, it considers the dependency satisfied
and starts your API. But "the container process has been launched" and "Postgres is accepting
connections on 5432" are seconds apart — and on the **first** run they're much further apart, because
the official image runs `initdb`, creates the database and user, and executes anything in
`/docker-entrypoint-initdb.d/` before it starts listening.

Your API connects during that window and gets `ECONNREFUSED`. The dependency was honoured; it just
guaranteed something weaker than you assumed.

### Fix 1 — orchestration layer: a healthcheck plus a condition

```yaml
services:
  postgres:
    image: postgres:16
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d ticketrush"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s          # failures during this window don't count against retries
  api:
    depends_on:
      postgres:
        condition: service_healthy
```

Now Compose waits until the healthcheck actually passes. Note this only works because Postgres
*defines* a healthcheck — `condition: service_healthy` against a service without one is an error.

### Fix 2 — application layer: retry with backoff

```ts
TypeOrmModule.forRoot({
  retryAttempts: 10,
  retryDelay: 3000,
})
```

### Why you need both, and which matters more

This is the part that separates a real answer from a recited one.

**The healthcheck solves the boot race exactly once.** It is a local-development convenience and a
deployment nicety.

**The retry solves the problem that never goes away.** Postgres restarts. A managed database fails
over to a replica. A network partition drops connections for ninety seconds. The container doesn't
restart, so no startup ordering is re-evaluated — your long-running process simply loses its
connections mid-life and has to recover on its own. `depends_on` has nothing to say about that.

The general principle: **`depends_on` is a startup-ordering hint; the network is unreliable forever.**
Any service that can't reconnect on its own is fragile no matter how carefully you sequence its boot.

Two more things worth knowing: `depends_on` is ignored entirely in Docker Swarm, and a container
that has *exited* (a one-shot migration job) needs `condition: service_completed_successfully`, not
`service_healthy`.

---

## Q3 — Volumes

> Named volume vs bind mount. `docker compose down` vs `down -v`. Why does that matter far more for
> Postgres than for Redis here?

**Your answer:** don't know.

### The two kinds

**Named volume** — Docker-managed storage. You give it a name; Docker decides where it lives.

```yaml
volumes:
  postgres_data:                                  # declared
services:
  postgres:
    volumes:
      - postgres_data:/var/lib/postgresql/data    # used
```

Survives container removal, has correct permissions and ownership, and performs at native speed
because it's a real Linux filesystem inside the VM. **This is the right choice for database data on
every OS, and especially on Windows.**

**Bind mount** — a specific host path mapped into the container.

```yaml
volumes:
  - ./src:/app/src        # host path : container path
```

You control the exact location, so it's ideal for source code in development — edit on the host, the
container sees it, hot reload fires. But the host filesystem's semantics come with it: ownership and
permission mismatches, case-insensitivity on Windows and macOS, and a **slow** filesystem bridge on
Docker Desktop. Putting Postgres data files on a bind mount on Windows is a well-known way to get
mysterious corruption and terrible performance.

### `down` versus `down -v`

| Command | Containers | Network | **Named volumes** |
|---|---|---|---|
| `docker compose down` | removed | removed | **kept** |
| `docker compose down -v` | removed | removed | **deleted, unrecoverably** |

`down` is safe and routine. **`down -v` is the "give me an empty database" command** — genuinely
useful when you want to prove your migrations run correctly from zero, which you'll want in M2. It is
never something to type reflexively.

### Why it matters far more for Postgres than Redis *here*

Because of what each one holds in this specific project.

**Postgres holds authoritative state that cannot be reconstructed.** Users, events, orders, tickets —
and `processed_events`, the Stripe webhook dedupe table. Losing it means re-running migrations, but
it also means losing the dedupe history: a webhook Stripe replays after the wipe would be treated as
new and **fulfil a second time**. That's `TR-DEC-008`'s whole reason for existing, destroyed by a flag.

**Redis holds only derived, reconstructable state.** Cached event listings repopulate on the next
cache miss. Hold countdown keys are a convenience whose authority is `ticket_holds.expires_at` in
Postgres — that's precisely why `TR-DEC-007` makes Postgres authoritative and Redis authoritative for
nothing. Wipe Redis and you get a cold cache for sixty seconds. Nothing is *lost*.

That asymmetry is not an accident of configuration; it's a design property we chose. Being able to
say "Redis holds nothing I can't rebuild, and that's deliberate" is the answer to a good chunk of
"what happens when your cache goes down."

**RabbitMQ sits in between** — it *can* hold durable queues with persistent messages, and in M6 it
will hold pending hold-expiry messages. Wiping it there means expired holds never get their release
trigger. That's exactly why `TR-DEC-007` also specifies a sweeper.

---

## Q4 — Redis vs RabbitMQ

> "Drop RabbitMQ, use a Redis list — one less container." Make the argument. What does RabbitMQ give
> you that a Redis list doesn't, and is there a defensible version of the suggestion?

**Your answer:**
> both have diff purpose redis is for in memory cahing so i dont have to quesry db every time AND
> rabbitmq is for quese so that user dont havr to wait for response if we are doing or calling
> multiple services on backend

**Grade: partially correct.** Both halves are true as far as they go, and "so the user doesn't have to
wait" is exactly the right instinct for *why a queue exists at all* (that's Q139 in the bank, and
you'd get credit for it).

But it doesn't answer this question, and the gap matters. Your colleague's proposal isn't confused
about purposes — it's pointing out that **Redis can genuinely act as a queue**: `LPUSH` to add,
`BRPOP` to block until something arrives. Answering "they have different purposes" restates the
conclusion without providing the argument. An interviewer asking this is specifically testing whether
you know *mechanism* or just *category*.

Also, one framing correction: **Redis is not "the caching thing."** It's a single-threaded in-memory
data-structure server. Caching is its most common application, not its definition. In this project it
will also do TTL countdowns and pub/sub for the Socket.IO adapter — neither is caching.

### What RabbitMQ gives you that a Redis list doesn't

**1. Acknowledgements — and this is the whole argument.**

With `BRPOP`, the moment Redis hands you the item it is **gone from the list**. If your consumer
crashes one line later, that message is lost permanently and nothing in the system knows it existed.

RabbitMQ delivers a message and holds it in an **unacked** state. If the channel closes without an
`ack` — crash, restart, network drop — the broker **requeues and redelivers** it. That's at-least-once
delivery, and it's why consumers must be idempotent.

This is not academic here. M6's central experiment is throwing inside the fulfilment consumer before
the ack, restarting it, and watching the same message come back. With a Redis list, that experiment
has no equivalent: the message is simply gone, and a paying customer never receives a ticket.

*(You can emulate acks with `BLMOVE` into a processing list — but then you have to write the reaper
that notices stuck entries and returns them, pick a timeout, and handle the reaper crashing. At that
point you are writing a broker.)*

**2. Routing.** Exchanges — direct, topic, fanout — mean one publish can reach many queues by routing
key. A Redis list is a single destination with no routing; fan-out means pushing to N lists yourself
and keeping them consistent.

**3. Dead-lettering and delayed delivery.** TTL + DLX gives you both the poison-message sink *and*
the delayed-release mechanism this project uses for hold expiry (`TR-DEC-007`). A Redis list has
neither.

**4. Prefetch / QoS.** Bound how many unacked messages one consumer holds, so work distributes fairly
and one slow consumer can't hoard the queue. Unbounded prefetch means one consumer grabs everything
and the others idle (Q145).

**5. Durability semantics.** Durable queues + persistent messages + publisher confirms give a defined
answer to "the broker restarted." Redis persistence (RDB snapshots, AOF) is tuned for a cache; with
default settings you can lose the last window of writes.

**6. Observability.** The management UI shows queue depth, consumer count, unacked messages, and
message rates — which is how you actually answer "the queue is backing up, diagnose it" (Q146).

### Is there a defensible version? Yes — and saying so is the strong answer

**If the work is fire-and-forget, idempotent, low-value, and losing one occasionally is acceptable**,
a Redis list is fine and one less container is a real operational win. Don't run a broker for
cache-warming jobs.

More importantly: **Redis Streams are not Redis lists.** Streams have consumer groups, explicit
acknowledgement (`XACK`), a pending-entries list, and claim-on-timeout for stuck messages. That is a
credible queue with real delivery semantics. And **BullMQ** — Redis-backed — is one of the most common
job-queue choices in production Node systems.

So the strongest version of your answer is:

> "A Redis *list* isn't a queue in the sense I need — no acknowledgements, so a consumer crash loses
> the message, and no routing or dead-lettering. Redis *Streams* or BullMQ would be defensible; they
> have consumer groups and acks. I chose RabbitMQ because the two things this system depends on are
> exactly ack-plus-redelivery and TTL-with-dead-letter-exchange for delayed hold release, and those
> are native there rather than assembled."

That's Q147, and it's a much better answer than "different purposes."

---

## Q5 — Fail-fast config

> Boots clean, dies 40 minutes later on a missing `STRIPE_SECRET_KEY`. What should have happened, and
> when? And: `.env` vs `.env.example` vs what reaches production.

**Your answer:**
> it basiccally stop us from deploying or running project if we are using any env in code but didnot
> provided its value in env

**Grade: partially correct.** The principle is right and stated correctly — refuse to run rather than
run broken. That's the core of it. What's missing is *when*, *how*, and *why the timing is the whole
point*.

### When: at bootstrap, before the server binds a port

The failure must happen **before the application starts accepting traffic**. That's not a detail — it
is the entire mechanism. An app that validates lazily at first use has already:

- bound its port,
- reported healthy to the orchestrator,
- been added to the load balancer,
- and served forty minutes of requests

before anyone discovers it's broken. And it breaks for the *user unlucky enough to hit checkout
first*, as a 500 — not for you, at deploy time, as a clear error.

In Nest:

```ts
ConfigModule.forRoot({ isGlobal: true, validate })   // throws → process exits non-zero
```

**The non-zero exit matters.** A crash-looping container stops a rolling deployment: the orchestrator
sees the new version failing and keeps the old one serving. A silently-degraded instance passes its
health check and quietly serves errors — strictly worse, because nothing alerts and the old version
is already gone.

### Validate the *shape*, not just presence

Presence checks catch missing variables. They don't catch:

- `STRIPE_SECRET_KEY` present but holding a **live** key (`sk_live_…`) in development — arguably worse
  than missing, since it's a real-money mistake rather than a crash. Validate the prefix.
- `DATABASE_URL` that isn't a valid URL.
- `PORT=abc`.
- A `JWT_SECRET` of eight characters.

Encode those as `class-validator` rules on the config schema.

### `.env` vs `.env.example` vs production

| | What it is | Committed? |
|---|---|---|
| `.env` | Real local values, including real secrets | **Never.** Git-ignored from the first commit. |
| `.env.example` | Same keys, placeholder or empty values | **Yes.** It is the contract. |
| Production | Neither file exists | Values injected by the platform |

`.env.example` is documentation that can't drift silently: it tells the next person — and you in three
months — which variables exist, and it's the first thing you diff against when the app won't boot.
Add a key to the schema, add it to `.env.example` in the same commit.

In production the values come from the platform's secret store — Docker secrets, Kubernetes Secrets,
Railway/Vercel/Fly environment variables, AWS Secrets Manager. The application code is identical; it
reads `process.env` either way. Only the *source* changes, which is precisely why the twelve-factor
rule is "config in the environment" rather than "config in a file."

**If a secret does reach a commit:** rotate it first. It is compromised from the moment it's pushed —
public repositories are scraped by bots within minutes, and a private repo still exposes it to
everyone with read access and to every clone already taken. Purging git history is cleanup, not the
fix. Rotation is the fix. (Q177.)

---

## Q6 — Liveness vs readiness

> RabbitMQ crashes. Should `/health/ready` 503? Should `/health/live`? What does an orchestrator do
> with each, and what's the concrete user-facing failure if you invert them?

**Your answer:**
> so before staring container we fuct ping the db redis rabbit mq and hatever we are suing on which
> our codebase is depended and if tehy are workin than we mark the conatner as healty and run it

**Grade: needs more depth, and there's a misconception to clear.**

You described a **startup** check — verify dependencies, then start. That's a real thing (it's the
Compose `healthcheck` from Q2), but it's a *different mechanism* answering a *different question*, and
merging it with liveness and readiness is the misconception. The question asked what happens when a
dependency dies **while the app is already running and serving traffic**, and there the distinction
between the two probes is the entire point.

Second issue: your answer checks *everything the codebase depends on*. That instinct — "check all
dependencies" — is the specific thing that causes the outage described below.

### The three probes

| Probe | Question | On failure the orchestrator… |
|---|---|---|
| **Startup** | Is it still booting? | Waits. Suppresses the other two meanwhile. |
| **Liveness** | Is this process irrecoverably broken? | **Kills and restarts the container.** |
| **Readiness** | Can this instance serve traffic *right now*? | **Removes it from the load balancer**, leaves it running, re-adds it on recovery. |

The difference is the *remedy*. Liveness means "restarting might help." Readiness means "don't send me
requests for the moment."

### Liveness must never check dependencies

This is the rule, and the reason is the failure you were asked about.

Suppose `/health/live` checks RabbitMQ. RabbitMQ crashes. Now **every** API instance fails liveness
simultaneously. The orchestrator dutifully kills and restarts all of them. Restarting changes nothing
— RabbitMQ is still down — so they fail again and get killed again. You now have a **restart storm**:
your entire API is down, nothing is serving, and the restarts hammer the broker as it tries to
recover. A degraded-checkout incident just became a total outage, caused by the health check rather
than by the fault.

Liveness should test only the process itself: is the event loop responsive, can it answer at all. In
practice `/health/live` returns `200 { status: 'ok' }` and touches nothing external. That looks
uselessly trivial. It is correct precisely *because* it's trivial.

### Readiness: which dependencies, not all of them

The right question isn't "is everything up," it's **"can this instance serve the traffic it will
receive?"**

Applied to TicketRush:

| Dependency | Down → `/health/ready` 503? | Why |
|---|---|---|
| **Postgres** | **Yes** | Nothing works. Every endpoint reads or writes it. This instance genuinely cannot serve. |
| **Redis** | **Judgement call — no** | It's a cache, and `TR-DEC-007` makes it authoritative for nothing. Losing it means slower responses, not wrong ones. Pulling every instance out over a *performance* dependency turns a slowdown into an outage. |
| **RabbitMQ** | **No** | Browsing events, viewing an event, reading availability — none of it touches the broker. Fail readiness on RabbitMQ and users can't even *look at* events because checkout fulfilment is degraded. |

So: **RabbitMQ crashes → `/health/ready` stays 200, `/health/live` stays 200.** The correct response
is to keep serving, let checkout fail loudly on the specific endpoint that needs the broker, and
**alert a human** — because health probes drive *automation*, and monitoring drives *people*. Don't
overload readiness with "something is wrong"; it means one thing, "don't route requests here."

### The concrete failure if you invert them

- **Dependencies in liveness:** the restart storm above. A broker outage takes down the whole API,
  and the restarts slow the broker's recovery.
- **Nothing in readiness:** a rolling deploy sends traffic to an instance whose database pool hasn't
  connected yet. Users get 500s for the first few seconds of every deployment, reliably, and it looks
  random.
- **Everything in readiness:** Redis hiccups for ten seconds; every instance is simultaneously pulled
  from the load balancer; there is nothing left to route to; the site is down. Meanwhile every
  instance was perfectly capable of serving from Postgres.

**M0 decision, following from this:** `/health/live` checks nothing. `/health/ready` checks Postgres
and Redis, deliberately **not** RabbitMQ. That asymmetry gets a comment in the code, because it looks
like an oversight and is a decision.

---

## Q7 — Connection pooling

> Two instances, pool of 10 each, `max_connections` 100. Do the arithmetic, name what else eats
> connections, and be precise about what the *caller* sees on exhaustion versus Postgres refusing
> outright.

**Your answer:** don't know.

### Why a pool exists at all

Postgres uses **one OS process per connection**. Establishing one means forking a backend process,
negotiating TLS, and authenticating — on the order of milliseconds, which is enormous compared to a
1ms query. A pool opens N connections once and lends them out, so a request borrows and returns
instead of building and tearing down.

### The arithmetic

2 instances × 10 = **20** at steady state, against 100. Comfortable. But that's the naive figure, and
the naive figure is what gets people paged. What else is drawing from the same 100:

- **`superuser_reserved_connections`** — default 3, held back so an admin can still get in when the
  server is saturated. Your real ceiling is 97.
- **Your own tools** — pgAdmin, DBeaver, a `psql` you left open. Each is a connection, and GUI clients
  frequently open several.
- **The migration runner** during a deploy — a separate short-lived connection.
- **Separate worker processes.** In M6 the RabbitMQ consumer may run as its own process with **its own
  pool**. That's not 20 any more, it's 20 + the consumer's pool.
- **Rolling deploys** — old and new instances are alive at the same time. Peak is transiently
  **double** steady state.

So "2 × 10 = 20" quietly becomes 4 × 10 + 5 + a few tools ≈ 50 during a deploy. Still fine at 100 —
but the trap is scaling. Scale the API to 10 instances without touching the pool and it's 100 = the
entire limit, and Postgres starts refusing.

**Rule of thumb:** `(instances × pool) + workers + tools + headroom < max_connections`, computed at
*peak* (mid-deploy), not steady state.

### The precise distinction you were asked for

**Pool exhausted — a client-side wait.**

The pool is a queue. A request needing a connection when all 10 are lent out doesn't fail — it
**waits**. If one frees within `connectionTimeoutMillis` it proceeds, just slower. If not, the driver
throws a *timeout acquiring a connection* error.

Symptom: **latency climbs on every endpoint at once**, then requests start timing out. Crucially,
**the database looks healthy** — low CPU, few active queries, nothing slow in `pg_stat_activity`.
That mismatch is the signature, and it's why this gets misdiagnosed as "the database is slow" when
the database is idle and the queue is inside your own process.

**Postgres refusing — a server-side rejection.**

At `max_connections`, the server rejects the connection attempt outright:
`FATAL: sorry, too many clients already`. No wait, immediate hard failure. And it affects
*everything* — including your attempt to open a psql session to find out what's wrong, which is
exactly what `superuser_reserved_connections` exists to prevent.

One is your app queuing internally; the other is the server slamming the door. Different symptom,
different diagnosis, different fix.

### The fix is usually not a bigger pool

Counterintuitive and worth internalising. Because Postgres is process-per-connection, more concurrent
connections means more context switching and more lock contention — throughput can *decrease* past a
certain point. The genuine fixes:

1. **Shorter transactions.** A connection is held for the whole transaction, not just the query.
2. **Faster queries** — usually an index.
3. **PgBouncer in transaction mode** — hundreds of client connections multiplexed onto a few real
   backends. The standard answer at scale.
4. Only then, a bigger pool.

**Directly relevant to M3.** The hold transaction must be short, and **never** hold a transaction open
across a network call. Wrapping a Stripe HTTP request inside a database transaction pins a pooled
connection for hundreds of milliseconds; under load that exhausts the pool on its own. Structure it
as: transaction → commit → then call Stripe.

---

## Q8 — The route that breaks the pipeline

> Global envelope interceptor, global exception filter, global
> `ValidationPipe({ whitelist, forbidNonWhitelisted })`. Which single route can't go through that
> unmodified, and which stage breaks it?

**Your answer:** don't know or maybe login.

**Grade: incorrect** — and worth addressing the guess, because it's a reasonable instinct pointing at
the wrong thing.

**Login is entirely ordinary.** It has a DTO (`{ email, password }`), it *wants* whitelist validation
— rejecting unexpected fields on a login body is exactly right — and its response should be
enveloped like everything else. Nothing about it fights the pipeline. In P1, login needed a CSRF
*skip*, which may be what you were reaching for; but `TR-DEC-001` removed CSRF from this project
entirely, so not even that applies.

### The answer: `POST /api/webhooks/stripe`

And the stage that breaks it is **body parsing — before the `ValidationPipe` ever runs.**

**The mechanism.** Stripe signs the **exact bytes** of the request body and sends the signature in a
`Stripe-Signature` header. Verification recomputes an HMAC-SHA256 over `timestamp + "." + rawBody`
using your webhook signing secret and compares the result.

Express's global `express.json()` middleware parses the body into a JavaScript object and **discards
the original buffer**. By the time your handler runs, the bytes Stripe signed are gone.

And you cannot reconstruct them. `JSON.stringify(req.body)` is *not* byte-identical to what Stripe
sent — key order, whitespace, and unicode escaping can all differ, and any single differing byte
produces a completely different HMAC. So the signature check fails on **every legitimate webhook**,
and the failure mode is maximally confusing: your code looks correct, Stripe's dashboard shows the
event was delivered, and you get 400 every time.

**The fix**, one of:

```ts
const app = await NestFactory.create(AppModule, { rawBody: true });   // then req.rawBody
```

or register `bodyParser.raw({ type: 'application/json' })` for that path specifically.

**Then the ValidationPipe, which is the second collision.** The handler receives a raw `Buffer`, not a
DTO. With `forbidNonWhitelisted: true` and no DTO to whitelist against, the pipe would reject Stripe's
payload outright. The route must be exempt.

**The envelope interceptor is harmless** — Stripe only reads the HTTP status code and ignores the body
— but be deliberate rather than lucky about it: return 200 fast, and don't do anything clever in the
response.

**And the path.** With `setGlobalPrefix('api')` the real URL is `/api/webhooks/stripe`, not the
`/webhooks/stripe` in the build spec. Point `stripe listen --forward-to` at the real one. This is the
same class of bug as P1's cookie-`Path`-versus-global-prefix incident: a global configuration change
invalidating a path assumption made earlier.

The build spec calls raw-body handling "the #1 Stripe integration bug" and it's right. You now know
it before hitting it — though I'd still expect it to cost you twenty minutes in M5, because knowing
about it and remembering it at 11pm are different things.

---

## Q9 — `NOT NULL` on a populated table

> A migration adds a `NOT NULL` column to `events`, which already has rows. What happens? What's the
> safe multi-step version, and why does the sequence matter more once the table is large and live?

**Your answer:** don't know.

### What happens

```sql
ALTER TABLE events ADD COLUMN venue TEXT NOT NULL;
```

**Fails immediately.** Every existing row would need a value for `venue`, and there isn't one:

```
ERROR:  column "venue" of relation "events" contains null values
```

The migration aborts and rolls back. Annoying locally, but it *fails loudly*, which is the good case.

### The quick fix, and the version boundary that matters

```sql
ALTER TABLE events ADD COLUMN venue TEXT NOT NULL DEFAULT 'TBD';
```

**In Postgres 11 and later this is fast** — the default is stored as table metadata and existing rows
are **not** rewritten; they materialise the default on read.

**Before Postgres 11 this rewrote the entire table** under an `ACCESS EXCLUSIVE` lock — the classic
"my migration took the site down for eleven minutes" story. Worth knowing the boundary, because
interviewers who learned this in 2016 still ask the old version, and answering "that depends on your
Postgres version, and here's why" is a strong signal.

### The safe multi-step version — expand, migrate, contract

Use it when there's no sensible default, or the value must be *computed* per row.

**1. Add the column nullable.** No default, no rewrite. Brief lock, effectively instant.
```sql
ALTER TABLE events ADD COLUMN venue TEXT;
```

**2. Deploy code that writes it.** Every new insert and update populates it. The code must tolerate
*both* states — old rows with `NULL`, new rows with values — because during a rolling deploy both
code versions run against the one schema.

**3. Backfill in batches.**
```sql
UPDATE events SET venue = 'TBD' WHERE venue IS NULL AND id IN (
  SELECT id FROM events WHERE venue IS NULL LIMIT 1000
);
```
Loop, committing between batches. A single `UPDATE` over millions of rows holds locks for the whole
duration, generates a huge amount of WAL, and — because Postgres's MVCC writes a *new row version* for
every update — bloats the table and creates a lot of work for `VACUUM`.

**4. Add the constraint, cheaply.** Postgres 12+:
```sql
ALTER TABLE events ADD CONSTRAINT venue_not_null CHECK (venue IS NOT NULL) NOT VALID;
ALTER TABLE events VALIDATE CONSTRAINT venue_not_null;   -- SHARE UPDATE EXCLUSIVE: doesn't block reads/writes
ALTER TABLE events ALTER COLUMN venue SET NOT NULL;      -- cheap: uses the validated CHECK
ALTER TABLE events DROP CONSTRAINT venue_not_null;
```

### Why the sequence matters more when the table is large and live

**`SET NOT NULL` requires a full table scan under an `ACCESS EXCLUSIVE` lock** — the strongest lock
Postgres has. It blocks every read *and* every write to that table for the scan's duration. On a large
table that's a genuine outage, not a hiccup.

**And the part most people miss: lock queuing.** Your `ALTER` requests `ACCESS EXCLUSIVE`. If a
long-running `SELECT` is already holding a weaker lock, the ALTER **waits** — and every query that
arrives afterwards queues *behind the ALTER*, because Postgres's lock queue is ordered. One slow
report plus one ALTER freezes the entire table, even though the ALTER hasn't started and the SELECT
would have finished.

Which is why you always do this before DDL on a live table:

```sql
SET lock_timeout = '3s';
```

The migration gives up rather than building a queue. Failing a deploy is cheap; freezing a table is
not.

**The general rule:** a migration and a deploy are two separate events, and during a rolling deploy
both code versions run against one schema. Every change must be backward-compatible with the code
currently running. Never drop or rename a column in the same release that stops using it — expand,
migrate, then contract in a later release.

---

## Verdict

**Ready to proceed to M0 — with the concepts doc read first and the compose file walked line by line.**

Not because the answers were strong; they weren't. Four "don't know"s and a misconception is a weak
round on paper. But the reasoning for proceeding is specific:

**M0's failure modes are immediate, visible, and cheap.** A misunderstood Docker network produces a
container that won't start — you find out in ten seconds and the fix teaches the concept. Nothing
here can silently corrupt data or ship a subtle bug. This is exactly the material that's better
learned with hands on the keyboard and an explanation attached than by reading first.

**Contrast M3.** A misconception about transaction isolation produces code that *works in testing*
and oversells under concurrency. That gate is real, and I'll hold it. Q7's transaction-length point
and Q9's lock-queuing point both feed directly into it.

**The Q8 miss is the one to actually carry forward.** Not because raw-body handling is conceptually
hard, but because it's the difference between losing twenty minutes in M5 and losing an evening.

### Study before M3 — not before M0

- **Isolation levels and anomalies** — read committed (Postgres default), repeatable read,
  serializable; dirty read, non-repeatable read, phantom read. *(Q82)*
- **Lost update** — two transactions read 100, both subtract 10, result is 90 not 80. Then the three
  fixes: `SELECT ... FOR UPDATE`, atomic `SET x = x - 10`, and an optimistic version column. *(Q83)*
- **MVCC** — why Postgres writes a new row version per update, and why that makes `VACUUM` necessary.
- **Transaction duration** — connections are held for the whole transaction; never span a network call.

### Worth an hour before M0, optional

- Docker networking: namespaces, user-defined bridge networks, the embedded DNS at 127.0.0.11.
- Compose healthchecks and `depends_on` conditions.
- Named volumes vs bind mounts.
- Kubernetes probe semantics — liveness, readiness, startup — even though we aren't using Kubernetes.
  The vocabulary is what interviewers use.

### Added to the learning tracker

`docker-networking` · `compose-healthchecks` · `volumes-and-persistence` · `redis-streams-vs-lists-vs-rabbitmq`
· `config-validation-shape-not-presence` · `liveness-vs-readiness` · `connection-pool-exhaustion`
· `pgbouncer` · `stripe-raw-body` · `expand-migrate-contract` · `postgres-lock-queuing`
