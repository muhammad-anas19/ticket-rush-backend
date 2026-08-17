# M0 — Foundation: Code Walkthrough

**How *this project* uses what `concepts/00-docker-and-service-topology.md` explains.** For the
technology itself, read that first — this doc assumes it and talks about real files.

**Status:** complete and verified live. Three containers healthy, API booting and connecting to all
three, both health probes behaving correctly under a deliberately induced dependency failure,
frontend rendering and reaching the API across a CORS boundary. Lint and typecheck clean on both sides.

---

## 1. What exists now

> **Two things changed after this module was first built.**
>
> 1. **Topology.** Postgres now runs natively (PostgreSQL 18, pgAdmin, connecting as the `postgres`
>    superuser); only Redis and RabbitMQ are containerised, and Compose moved into `backend/`. See
>    `TR-DEC-015`. The `--profile full` container-networking demo no longer exists.
> 2. **Ports swapped.** The **backend is now on 3001** and the **frontend on 3000**.
>
> The verification transcripts below were recorded before both changes, so they show the old ports —
> API on 3000, UI on 3001. The behaviours they prove are unchanged. "Running it" at the bottom is
> current.

```
ticket-rush/
├── backend/
│   ├── docker-compose.yml        Redis + RabbitMQ only (Postgres is native)
│   ├── Dockerfile                4-stage: deps → development → build → production (currently unused)
│   ├── .dockerignore
│   ├── .env / .env.example
│   └── src/
│       ├── main.ts               bootstrap: rawBody, prefix, CORS, pipe, interceptor, filter, Swagger
│       ├── app.module.ts
│       ├── config/
│       │   ├── env.validation.ts     fail-fast schema — throws before the port binds
│       │   └── configuration.ts      typed, grouped view of the environment
│       ├── database/
│       │   ├── data-source.ts        shared by the TypeORM CLI and the app
│       │   ├── database.module.ts    pool sizing + connection retry
│       │   └── migrations/           empty until M2
│       ├── redis/redis.module.ts     one shared ioredis client, injected by token
│       ├── common/
│       │   ├── types/api-envelope.ts
│       │   ├── decorators/skip-envelope.decorator.ts
│       │   ├── interceptors/response-envelope.interceptor.ts
│       │   └── filters/all-exceptions.filter.ts
│       └── modules/health/
│           ├── health.controller.ts       the liveness/readiness asymmetry, with reasoning
│           ├── health-exception.filter.ts preserves Terminus's shape on failure
│           └── indicators/redis.health.ts
└── frontend/
    └── src/
        ├── app/{layout,page,providers}.tsx
        └── shared/
            ├── styles/     7-1: abstracts / base / themes
            ├── ui/         Button, Skeleton, Badge (+ barrel)
            └── api/        axiosClient, ApiError, types
```

---

## 2. Decisions made while building, and why

### Postgres is native; Redis and RabbitMQ are containers

Originally all three were containerised, with Postgres published on 5433 to avoid the local install
the M0 Q&A surfaced. That is now resolved differently and more simply: there is only **one** Postgres,
the native PostgreSQL 18 service, so the port shift is unnecessary and `.env` uses the ordinary 5432.

The tradeoff is real and recorded in `TR-DEC-015` — chiefly that `docker compose down -v` no longer
resets the database, so proving migrations run from empty is now a manual drop-and-recreate in
pgAdmin rather than one flag. Manual steps get skipped; M2 should be deliberate about it.

Setup is a single manual step: create the `ticketrush` database in pgAdmin. TypeORM creates *tables*
via migrations but cannot create the *database* — it has to connect to one that already exists.

The app connects as the `postgres` superuser. A dedicated least-privilege role was written and then
dropped as unnecessary ceremony, which is a fair call for local development — a superuser already
holds every privilege the app needs, including the `GRANT ALL ON SCHEMA public` that Postgres 15+
would otherwise require before the first migration could create a table. The cost is that the app
can reach every database on the server, so it is recorded in `TR-DEC-015` and carried into the M8
security review rather than left implicit.

### The Compose project name is set explicitly

`name: ticketrush`. Without it, Compose derives the project name from the containing **directory** —
here `backend` — so every volume would be `backend_redis_data`. Rename or move the folder and Compose
silently creates a fresh set of volumes while orphaning the old ones, which presents as a datastore
having wiped itself.

### Every healthcheck uses a real command, and `depends_on` uses `condition: service_healthy`

`pg_isready`, `redis-cli ping`, `rabbitmq-diagnostics ping`. RabbitMQ gets `start_period: 30s`
because it genuinely is slow to boot and would otherwise fail its own check before it finished
starting.

**And the app retries anyway** (`database.module.ts`, `retryAttempts: 10`). The healthcheck solves
the boot race once; the retry solves the one that never goes away.

### `rawBody: true` is set in M0, five modules before anything needs it

`main.ts`. Stripe arrives in M5, but this is a bootstrap-level flag, and retrofitting it means
editing the application's entry point in the middle of a payments module — exactly when a surprise is
least welcome. The comment explains the mechanism so it isn't cargo-culted.

### The global prefix is set now, not later

`app.setGlobalPrefix('api', { exclude: ['health', 'health/{*path}'] })`. P1 added its prefix at phase
9 and lost an evening to cookie `Path`s scoped against the pre-prefix URL structure. The equivalent
trap here is M5: the real webhook URL is `/api/webhooks/stripe`, so `stripe listen --forward-to` must
point there rather than at the build spec's `/webhooks/stripe`.

Note the `{*path}` syntax. Nest 11 moved to `path-to-regexp` v8, which requires named wildcards; the
old `(.*)` still works through a shim but logs a deprecation warning on every boot.

### `redis/` sits beside `database/`, not inside `common/`

Both are infrastructure wiring, and `common/` is for cross-cutting request-pipeline concerns with no
business logic. The Redis module is `@Global` for the same reason `ConfigModule` is: from M4 onward
several modules need the client, and threading an import through all of them adds noise without
adding safety.

### Readiness checks Postgres and Redis, deliberately not RabbitMQ

`health.controller.ts`, with the full reasoning in a comment because the asymmetry looks like an
oversight. Summary: browsing events never touches the broker, so failing readiness on RabbitMQ would
deregister every instance and stop users from doing the many things that work fine. Health probes
drive automation; monitoring drives humans.

Redis is included and that one is a judgement call, flagged as such — if a Redis blip ever
deregisters the whole fleet, that line is the cause and removing it is the fix.

---

## 3. What surprised me

### A health check that silently stopped checking

Readiness returned `200` with only Postgres in the response. Redis was simply **absent** — not
failing, not reported down, just gone.

The cause was mine. Terminus's `getStatus(key, isHealthy, data)` builds
`{ [key]: { status: isHealthy ? 'up' : 'down', ...data } }`, and I passed
`{ status: this.client.status }` as `data`. The spread overwrote the verdict, producing
`{ redis: { status: 'ready' } }` — ioredis's connection state, not Terminus's up/down. Terminus then
buckets results by `status === 'up'` or `'down'`; `'ready'` matched neither, so the entry was dropped
from `info`, `error`, and `details` alike, and the overall result stayed `ok`.

Reproduced in isolation before fixing it:

```
with data.status      -> {"redis":{"status":"ready"}}
with data.connection  -> {"redis":{"status":"up","connection":"ready"}}
```

**The generalisable lesson:** a health check that quietly stops checking is worse than no health
check, because it reports confidence it has not earned. It would have passed CI, passed a code
review, and reported green through a total Redis outage. Found by *reading* a passing response rather
than by anything failing — which is the only way this class of bug ever gets found.

Fix: rename the data key to `connection`. `indicators/redis.health.ts` carries the explanation.

### `@SkipEnvelope()` only covered half the route

With Redis stopped, readiness correctly returned 503 — wrapped in the error envelope, while the 200
returned Terminus's raw shape. One endpoint, two response shapes.

`@SkipEnvelope()` is read by `ResponseEnvelopeInterceptor`, and **an interceptor only wraps the
success path**. When a handler throws, the interceptor's `map` never runs, the exception sails past
it, and `AllExceptionsFilter` produces the error body. Opting out of the interceptor says nothing
about the filter.

That is the request lifecycle being load-bearing rather than trivia:

```
Guards → Interceptors (pre) → Pipes → Handler → Interceptors (post) → Filters
```

Fixed with `HealthExceptionFilter`, scoped to the controller via `@UseFilters` rather than added to
`AllExceptionsFilter` — `common/` must not learn a specific module's response format.

In practice orchestrators read the status code and ignore the body, so this was harmless. It was
fixed anyway because the stated reason for `@SkipEnvelope()` on that controller is "external tooling
parses Terminus's documented structure," and that reasoning applies *most* when the check fails.

### CORS does not reject anything

Testing the negative case produced this:

```
$ curl -i http://localhost:3000/health/ready -H "Origin: http://evil.example"
HTTP/1.1 200 OK
Access-Control-Allow-Origin: http://localhost:3001
```

A **200, with the full body**, from a disallowed origin. That is correct behaviour and worth
internalising, because it looks like a security hole and isn't:

**CORS is enforced by the browser, not by the server.** The server declares a policy —
`Access-Control-Allow-Origin: http://localhost:3001` — and the *browser* compares it against the
requesting origin, sees a mismatch, and refuses to hand the response to the calling JavaScript. The
response was still sent. curl has no such policy and prints it.

Two consequences that answer Q104 properly:

- **CORS is not a firewall.** It protects *users* from a malicious site making authenticated requests
  on their behalf. It does nothing about a direct request from curl, Postman, or a server. Anything
  that must be genuinely inaccessible needs authentication, not a CORS policy.
- The preflight is the part that actually blocks. `OPTIONS` returned `204` with the allow headers;
  had the method or headers not been permitted, the browser would never have sent the real request.

---

## 4. Verified live

| Check | Result |
|---|---|
| Three containers healthy | ✅ `postgres`, `redis`, `rabbitmq` all `(healthy)` |
| API boots, connects to Postgres + Redis | ✅ |
| `GET /health/live` | ✅ `200 {"status":"ok"}` |
| `GET /health/ready`, all up | ✅ `200`, both `postgres` and `redis` reported `up` |
| **RabbitMQ stopped** → readiness | ✅ **stays `200`** — deliberately unchecked |
| **RabbitMQ stopped** → liveness | ✅ stays `200` — no restart storm |
| **Redis stopped** → readiness | ✅ `503`, `redis: down, Timed out after 1000ms` |
| **Redis stopped** → liveness | ✅ **stays `200`** — the whole point |
| Redis restarted → readiness | ✅ recovers to `200` automatically |
| Error envelope on a normal route | ✅ `404` → `{success:false,data:null,message,statusCode,path,timestamp}` |
| Swagger | ✅ `/docs` |
| CORS preflight from `:3001` | ✅ `204` + correct allow headers |
| Backend lint + typecheck | ✅ clean |
| Frontend production build | ✅ compiled, 4 static pages |
| Frontend renders, reaches API | ✅ readiness rendered live, polling every 10s |

The Redis-stopped run is the one worth remembering — it is the liveness/readiness distinction
observed rather than read, and it is the misconception the M0 Q&A corrected.

---

## 5. Running it

One-time, in pgAdmin: right-click **Databases → Create → Database**, name it `ticketrush`. Then set
`DATABASE_PASSWORD` in `backend/.env` to your `postgres` password.

```bash
cd backend
docker compose up -d      # Redis + RabbitMQ (Postgres is the native service)
npm install && npm run start:dev        # API on :3001

cd ../frontend
npm install && npm run dev              # UI on :3000
```

| | |
|---|---|
| API | http://localhost:3001/api |
| Swagger | http://localhost:3001/docs |
| Liveness / Readiness | http://localhost:3001/health/live · `/health/ready` |
| Frontend | http://localhost:3000 |
| RabbitMQ management | http://localhost:15672 (ticketrush / ticketrush) |
| Postgres | `localhost:5432` — native, pgAdmin |
| Redis | `localhost:6379` |

**Try the failure cases yourself** — they are the point of the module:

```bash
docker compose stop redis      # readiness → 503, liveness → 200
docker compose start redis     # readiness recovers on its own
docker compose stop rabbitmq   # both stay 200 — by design
```

For the Postgres failure case, stop the Windows service (`Stop-Service postgresql-x64-18`) — readiness
should go 503 while liveness stays 200, same as Redis.

`docker compose down` keeps your data. `docker compose down -v` deletes the Redis and RabbitMQ
volumes. Note that neither touches Postgres any more (`TR-DEC-015`): resetting the database for M2's
migration test is a drop-and-recreate in pgAdmin, which is a manual step where it used to be a flag.

---

## 6. Deliberately not built

Named so they read as decisions rather than oversights.

- **Rate limiting** (`TR-DEC-004`). Genuinely load-bearing in a ticketing domain — an unlimited hold
  endpoint lets one script hold all inventory and never pay. Recorded as a known finding for the M8
  security review.
- **Structured logging.** Nest's console logger only. Enough to observe the M6 redelivery and the M4
  hit ratio live; scrollback is lost on restart. Adding Winston later is one transport, not a
  restructure.
- **Tests.** M8. Nothing in M0 has branching logic worth a unit test yet, and the e2e suite wants
  real endpoints to hit.
- **A `users` table.** M1. `migrations/` is deliberately empty — the tooling is wired, the schema
  isn't.
