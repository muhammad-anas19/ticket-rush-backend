# Docker, Compose, and Service Topology

**Concepts doc — the technology itself.** No TicketRush code here; this should make sense to someone
who has never seen this repo. For how we actually wire it, see the M0 walkthrough. For the graded
Q&A this was written to remediate, see [../qa/phase-0-foundation-understanding-check.md](../qa/phase-0-foundation-understanding-check.md).

---

## 1. What a container actually is

A container is **not a virtual machine.** There's no guest OS, no hypervisor, no emulated hardware. A
container is an ordinary Linux process on the host kernel, running with a restricted view of the
system. Two kernel features do the work:

- **Namespaces** control *what the process can see.* Separate namespaces exist for the process tree
  (PID), the network stack, mount points, hostnames, users, and IPC. A process in its own PID
  namespace sees itself as PID 1 and cannot see the host's processes. A process in its own **network
  namespace** has its own interfaces, its own routing table, and — critically — **its own
  `localhost`**.
- **cgroups** control *what the process can use* — CPU, memory, I/O limits.

That's the entire trick. This is why containers start in milliseconds while a VM takes tens of
seconds: there's nothing to boot. It's also why a Linux container can't run on Windows natively —
Docker Desktop quietly runs a Linux VM and puts your containers inside it.

**The consequence that trips everyone up:** because each container has its own network namespace,
`localhost` inside a container means *that container*, not your machine and not another container.
Almost every "it worked outside Docker" bug traces back to this one fact.

### Image vs container vs volume

| | What it is | Analogy |
|---|---|---|
| **Image** | An immutable, layered filesystem snapshot plus metadata (default command, env, exposed ports) | A class |
| **Container** | A running (or stopped) instance of an image, with a thin writable layer on top | An instance |
| **Volume** | Storage that lives outside the container's writable layer and outlives the container | A mounted disk |

Images are built in **layers**, one per Dockerfile instruction, and layers are cached and shared. This
is why ordering matters in a Dockerfile: copy `package.json` and run `npm ci` *before* copying source
code, so a source change doesn't invalidate the dependency layer and force a reinstall on every build.

**A container's writable layer is disposable.** Remove the container and everything written inside it
is gone. That is by design — and it's why databases need volumes.

---

## 2. Networking — the part that causes the most lost hours

### `localhost` is a namespace, not a machine

Say it once more, because it's the root of most Docker confusion. When a process inside container A
connects to `127.0.0.1:5432`, the kernel looks at container A's loopback interface. If nothing in
container A is listening on 5432, the connection is refused — regardless of what's running in
container B or on the host.

### Publishing a port is a host→container door

```yaml
ports:
  - "5432:5432"      # hostPort : containerPort
```

This tells Docker to listen on the *host's* port 5432 and forward to the container's 5432. It exists
so **you** — psql, pgAdmin, an app running directly on your machine — can reach the service. It has
nothing to do with container-to-container traffic.

Two consequences:

- **Container-to-container always uses the container port**, never the published one. If you map
  `"5433:5432"` to avoid clashing with a local install, other containers still connect on **5432**.
- **You don't need `ports:` for containers to talk to each other.** In production you usually omit it:
  an unpublished container is unreachable from outside the Docker network, which is a security
  property.

### User-defined bridge networks and embedded DNS

Docker Compose creates a **user-defined bridge network** for the project and attaches every service
to it. On that network:

- Every container gets an IP.
- Docker runs an **embedded DNS server at 127.0.0.11** inside each container's namespace, wired up via
  the container's `/etc/resolv.conf`.
- That DNS resolves **service names**, container names, and network aliases to container IPs.

So the hostname for another service is simply **the service key in your Compose file**:

```yaml
services:
  postgres:                                            # ← this is the hostname
    image: postgres:16
  api:
    environment:
      DATABASE_URL: postgres://app:pw@postgres:5432/mydb
```

This automatic DNS is a property of *user-defined* networks. The legacy default bridge (what you get
from a bare `docker run` with no network specified) does **not** provide it — which is why Compose
"just works" and manual `docker run` often doesn't.

### Reaching the host from inside a container

Sometimes you need the opposite direction — a container calling something on your machine. The name
is **`host.docker.internal`**. Docker Desktop provides it automatically; on plain Linux you add:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

This matters whenever a CLI tool runs on your host and needs to forward requests into a containerised
API — the Stripe CLI's webhook forwarding being the obvious case.

### Diagnosing network problems

```bash
docker compose ps                      # what's actually running, and its health
docker compose logs -f <service>       # why it died
docker network inspect <project>_default   # who's attached, and at which IPs
docker compose exec api sh             # get a shell inside the container
  getent hosts postgres                #   does the name resolve?
  nc -zv postgres 5432                 #   is the port open from here?
```

That sequence — resolve, then connect — separates a DNS problem from a "service isn't listening"
problem in about ten seconds.

---

## 3. Persistence: volumes

A container's writable layer dies with the container. Anything that must survive needs a volume.

### Named volumes

```yaml
volumes:
  postgres_data:                                    # declare
services:
  postgres:
    volumes:
      - postgres_data:/var/lib/postgresql/data      # mount
```

Docker manages the storage and decides where it physically lives. Named volumes have correct
ownership and permissions, perform at native filesystem speed, and behave identically across Linux,
macOS, and Windows. **This is the right choice for database data, always.**

### Bind mounts

```yaml
volumes:
  - ./src:/app/src        # hostPath : containerPath
```

You choose the exact host path. Perfect for **source code during development** — edit on the host, the
container sees the change, hot reload fires. But the host filesystem's semantics come along with it:
ownership and permission mismatches, case-insensitivity on Windows and macOS, and a notably **slow**
filesystem bridge on Docker Desktop. Putting database data files on a bind mount is a well-known way
to get poor performance and, on Windows, occasional corruption.

**Rule of thumb: bind mounts for code, named volumes for data.**

### The two commands, and the difference that bites

| Command | Containers | Network | Named volumes |
|---|---|---|---|
| `docker compose down` | removed | removed | **kept** |
| `docker compose down -v` | removed | removed | **deleted, unrecoverably** |

`down` is safe and routine. `down -v` is the deliberate "give me an empty database" command — genuinely
useful for proving migrations run correctly from zero. It is never something to type reflexively, and
there is no undo.

### Which services can afford to lose their data

This is a design question, not a Docker question, and it's worth answering explicitly for any system:

- **Data you cannot reconstruct** (users, orders, payment records, idempotency ledgers) → durable
  storage, backed up, never casually wiped.
- **Data you can rebuild from the authoritative store** (caches, denormalised read models) → losing it
  costs latency, not correctness.
- **Data in flight** (queued messages) → sits in between; durable queues plus a reconciliation
  mechanism, because a broker is not a database.

A system where you can say "this store holds nothing I can't rebuild, deliberately" has a much better
answer to "what happens when your cache goes down."

---

## 4. Compose: orchestration for one machine

Compose describes a multi-container application in one YAML file: services, their images, their
environment, their networks, their volumes. `docker compose up` reconciles reality to that
description.

It is a **development and single-host tool**. It has no scheduling, no self-healing across machines,
no rolling deploys. Kubernetes, ECS, or Nomad do that. But the *concepts* transfer almost directly,
which is why learning Compose properly is worth it even if you never write a Compose file at work.

### The startup-ordering problem

```yaml
services:
  api:
    depends_on:
      - postgres        # ← weaker than it looks
```

**Plain `depends_on` controls start order, not readiness.** Docker starts Postgres, and the moment the
container's main process has launched, it considers the dependency met and starts the API. But
"process launched" and "accepting connections on 5432" are seconds apart — and on the *first* run
they're much further apart, because the official Postgres image runs `initdb`, creates the database
and user, and executes anything in `/docker-entrypoint-initdb.d/` before it starts listening.

Your app connects into that gap and gets `ECONNREFUSED`.

### Fix one: healthchecks and conditions

```yaml
services:
  postgres:
    image: postgres:16
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d mydb"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s      # failures in this window don't count against retries
  api:
    depends_on:
      postgres:
        condition: service_healthy
```

Now Compose waits for the check to actually pass. Notes:

- `condition: service_healthy` requires the dependency to *define* a healthcheck; without one it's an
  error.
- For a one-shot container that runs and exits (a migration job), the condition is
  `service_completed_successfully`.
- `start_period` exists so a slow-starting service isn't killed by its own healthcheck during boot.

### Fix two: retry in the application

```ts
// TypeORM
{ retryAttempts: 10, retryDelay: 3000 }
```

### Why both, and which actually matters

**The healthcheck solves the boot race exactly once.** It's a local-development convenience.

**The retry solves the problem that never goes away.** Databases restart. Managed instances fail over
to a replica. Networks partition for ninety seconds. None of that restarts your container, so no
startup ordering is re-evaluated — a long-running process simply loses its connections mid-life and
must recover on its own.

> **`depends_on` is a startup-ordering hint. The network is unreliable forever.**

A service that cannot reconnect on its own is fragile no matter how carefully you sequence its boot.
This is also why `depends_on` is ignored entirely in Docker Swarm: at cluster scale, the assumption
that you can order startup is simply abandoned in favour of everything retrying.

---

## 5. Health checks: three probes, three questions

Container healthchecks (above) gate *startup ordering*. Application health **endpoints** answer a
different question: what should an orchestrator or load balancer do with this instance *right now*.

| Probe | Question | On failure |
|---|---|---|
| **Startup** | Is it still booting? | Wait. Suppress the other two meanwhile. |
| **Liveness** | Is this process irrecoverably broken? | **Kill and restart the container.** |
| **Readiness** | Can this instance serve traffic right now? | **Remove from the load balancer**, keep it running, re-add on recovery. |

The distinction is the **remedy**. Liveness means "restarting might help." Readiness means "don't send
me requests for the moment."

### Liveness must never check dependencies

This is the rule, and the reason is a specific, common outage.

Suppose liveness checks the message broker. The broker crashes. **Every** instance now fails liveness
simultaneously, so the orchestrator kills and restarts all of them. Restarting changes nothing — the
broker is still down — so they fail again and are killed again. You have a **restart storm**: the
entire service is down, nothing is serving, and the restart traffic hammers the broker as it tries to
recover.

A degraded-checkout incident just became a total outage, caused by the health check rather than by
the fault.

So liveness tests the process itself and nothing external: can it respond at all. A liveness endpoint
that returns `200 {status:'ok'}` and touches nothing looks uselessly trivial. It is correct
*precisely because* it's trivial.

### Readiness: only the dependencies this instance needs to serve

The question isn't "is everything up." It's **"can this instance serve the traffic it will receive?"**

- A dependency **every** request needs (the primary database) → include it. Without it the instance
  genuinely cannot serve, and taking it out of rotation is correct.
- A dependency that only makes things **faster** (a cache) → generally exclude it. Losing it means
  slower responses, not wrong ones. Pulling every instance out of the load balancer over a
  performance dependency converts a slowdown into an outage.
- A dependency only **some** endpoints need (a broker used by one flow) → exclude it. Otherwise a
  broker outage stops users from doing the many things that don't involve the broker at all.

**Health probes drive automation; monitoring and alerting drive humans.** Don't overload readiness
with "something is wrong" — it means exactly one thing: don't route requests here. A broker being
down should page someone, not deregister every instance.

### The three ways to get it wrong

| Mistake | What users see |
|---|---|
| Dependencies in **liveness** | Restart storm. Total outage from a partial fault. |
| **Nothing** in readiness | 500s during every rolling deploy, as traffic hits instances whose pool isn't connected yet. |
| **Everything** in readiness | A ten-second cache hiccup deregisters every instance at once. Nothing left to route to. |

---

## 6. Configuration: fail fast, and fail before traffic

**Validate all configuration at process bootstrap, before the HTTP server binds a port.**

The timing is the entire mechanism. An application that validates lazily — checking a key the first
time it's needed — has already bound its port, reported healthy, been added to the load balancer, and
served real traffic before anyone discovers it's misconfigured. And it surfaces as a 500 for whichever
user happens to hit that code path first, not as a clear error at deploy time.

**Exit non-zero.** A crash-looping container stops a rolling deployment: the orchestrator sees the new
version failing and keeps the old one serving. A silently-degraded instance passes its health check
and quietly serves errors — strictly worse, because nothing alerts and the old version is already gone.

### Validate shape, not just presence

Presence checks miss the interesting failures:

- A key that's present but points at the **wrong environment** — a live payment key in development is
  worse than a missing one, because it's a real-money mistake rather than a crash. Validate prefixes.
- A URL that isn't a URL, a port that isn't numeric, a secret that's eight characters long.

### The three homes for configuration

| | What it is | Committed? |
|---|---|---|
| `.env` | Real local values, including secrets | **Never.** Git-ignored from the first commit. |
| `.env.example` | The same keys with placeholder or empty values | **Yes.** It is the contract. |
| Production | Neither file exists | Injected by the platform |

`.env.example` is documentation that can't silently drift: it tells the next person which variables
exist, and it's the first thing you diff against when an app won't boot. Add a key to the validation
schema and to `.env.example` in the same commit.

In production, values come from the platform's secret store — Docker secrets, Kubernetes Secrets,
Railway/Vercel/Fly variables, AWS Secrets Manager. The application code is identical; it reads the
environment either way. Only the *source* differs, which is exactly why the twelve-factor rule is
"config in the environment" rather than "config in a file."

**If a secret reaches a commit: rotate it first.** It is compromised the moment it's pushed — public
repos are scraped within minutes, and a private repo still exposes it to everyone with read access
and every clone already taken. Purging git history is cleanup. Rotation is the fix.

---

## 7. Connection pooling

### Why pools exist

PostgreSQL uses **one operating-system process per connection**. Opening one means forking a backend
process, negotiating TLS, and authenticating — milliseconds, which is enormous next to a 1ms query. A
pool opens N connections once and lends them out, so a request borrows and returns rather than
building and tearing down.

### Sizing, and what people forget

The naive calculation is `instances × poolSize`. What that misses:

- **Reserved superuser connections** (`superuser_reserved_connections`, default 3) — held back so an
  admin can still connect when the server is saturated.
- **Your own tools** — pgAdmin, DBeaver, a forgotten `psql`. GUI clients often open several each.
- **Migration runners** during a deploy.
- **Separate worker processes** with their **own** pools — a queue consumer running as its own service
  is not covered by the API's pool count.
- **Rolling deploys** — old and new instances are alive simultaneously, so peak is transiently
  **double** steady state.

> Size against `(instances × pool) + workers + tools + headroom < max_connections`, computed at
> **peak**, not steady state.

The classic incident: scale the API from 2 instances to 10 to handle load, don't touch the pool,
and now `10 × 10 = 100` equals the entire limit.

### Exhaustion vs refusal — different symptoms, different diagnoses

**Pool exhausted (client-side wait).** The pool is a queue. A request that needs a connection when all
are lent out **waits**. If one frees within the acquire timeout it proceeds, just slower; otherwise
the driver throws a *timeout acquiring a connection* error.

The symptom is **latency climbing across every endpoint at once**, then timeouts — while the database
looks perfectly healthy: low CPU, few active queries, nothing slow in `pg_stat_activity`. That
mismatch is the signature. It is routinely misdiagnosed as "the database is slow" when the database
is idle and the queue is inside the application process.

**Server refusal.** At `max_connections`, PostgreSQL rejects the connection outright:
`FATAL: sorry, too many clients already`. No wait — immediate hard failure, affecting everything,
including your attempt to open a psql session to investigate. That's what the reserved superuser
connections are for.

### The fix is usually not a bigger pool

Counterintuitive but important. Because Postgres is process-per-connection, more concurrent
connections means more context switching and more lock contention — past a point, throughput
*decreases*. In order of actual effectiveness:

1. **Shorter transactions.** A connection is held for the entire transaction, not just the query.
   **Never hold a transaction open across a network call** — an HTTP request inside a transaction pins
   a pooled connection for hundreds of milliseconds and exhausts the pool under load all by itself.
2. **Faster queries** — usually an index.
3. **PgBouncer in transaction mode** — multiplexes hundreds of client connections onto a handful of
   real backends. The standard answer at scale.
4. Only then, a larger pool.

---

## 8. The three services in this topology

Deep dives come with the modules that use them — this is the shape and the reason each is present.

> **In TicketRush specifically:** Redis and RabbitMQ run in Compose; **Postgres runs natively** on the
> development machine and is managed with pgAdmin (`TR-DEC-015`). Everything in §2–§4 above still
> applies to the two containerised services, and the reasoning about `localhost`, published ports and
> healthchecks is unchanged — it simply isn't exercised against Postgres here. The main thing given
> up is a reproducible-from-zero database: `down -v` no longer resets it.

### PostgreSQL — the authority

Relational, ACID, MVCC. Holds every fact the system cannot afford to be wrong about: users, events,
inventory, orders, tickets, and the payment idempotency ledger. **Every correctness decision is made
here, inside a transaction.**

The single most important property for this project: a statement like
`UPDATE … SET n = n + 1 WHERE n + 1 <= limit` is **atomic**. Two concurrent executions cannot both
succeed past the limit, because the row lock serialises them. That is the entire basis of
oversell prevention, and it's why inventory doesn't live in the cache.

### Redis — the fast, forgettable one

Single-threaded, in-memory, data structures as first-class citizens (strings, hashes, lists, sets,
sorted sets, streams). Being single-threaded sounds like a weakness and is actually the source of two
useful properties: **every command is atomic** with no lock-contention cost, and behaviour is
predictable under concurrency.

Three distinct jobs here, only one of which is caching:
- **Cache** for expensive reads, with TTL and explicit invalidation.
- **Expiry timers** — a key with a TTL as a countdown.
- **Pub/sub** — the transport the Socket.IO Redis adapter uses to make broadcasts cross instances.

Critically: **Redis is authoritative for nothing.** Everything in it can be rebuilt from Postgres.
That's a deliberate design property, not a coincidence.

### RabbitMQ — the reliable hand-off

An AMQP broker: **producers** publish to **exchanges**, exchanges route to **queues** by binding rules,
**consumers** read from queues and acknowledge.

The reason it's here rather than a simpler queue is two specific features:

- **Acknowledgements.** A message is delivered but held as *unacked* until the consumer confirms. If
  the consumer dies first, the broker **redelivers**. That's at-least-once delivery, and it's why
  consumers must be idempotent.
- **TTL + dead-letter exchange.** A message with a time-to-live that, on expiry, is routed to another
  exchange instead of being dropped. That's the native way to schedule "do this in ten minutes"
  without a cron job.

Both are load-bearing here — the first for payment fulfilment, the second for releasing expired holds.

### Why not fold the queue into Redis?

A fair question, and the honest answer has three parts.

A Redis **list** (`LPUSH`/`BRPOP`) is not sufficient: `BRPOP` removes the item immediately, so a
consumer that crashes one line later loses the message permanently, with nothing aware it existed. No
acknowledgements, no routing, no dead-lettering.

Redis **Streams** *are* different — consumer groups, explicit `XACK`, a pending-entries list, and
claim-on-timeout for stuck messages. That's a credible queue. So is **BullMQ**, a Redis-backed job
queue very widely used in production Node systems.

So the accurate statement isn't "Redis can't do queues." It's: *a Redis list can't, Redis Streams can,
and RabbitMQ is chosen here because acknowledgement-with-redelivery and TTL-plus-dead-letter-exchange
are native rather than assembled — and those two features are exactly what this system depends on.*

---

## 9. Interview mapping

| Bank Q | Topic | Where above |
|---|---|---|
| Q169 | Dockerfile, multi-stage, `.dockerignore` | §1 (layers) |
| Q170 | Image vs container vs volume; what Compose adds | §1, §3, §4 |
| Q171 | Works locally, fails in the container | §2 — `localhost` is a namespace |
| Q90 | Connection pooling and exhaustion | §7 |
| Q139, Q147 | Why a queue; RabbitMQ vs Redis vs Kafka vs SQS | §8 |
| Q141, Q142 | Consumer crash; at-least-once delivery | §8 (acks) |
| Q174 | How would you know a background job stopped | §5 (probes vs monitoring) |
| Q177 | Secrets across environments; a leaked secret | §6 |
