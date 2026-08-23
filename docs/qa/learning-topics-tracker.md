# Learning Topics Tracker

A single running checklist of everything flagged as a gap across every module's understanding check.
Updated at the end of every module — **never delete resolved entries**, mark them done instead, so
this stays a complete record of what was actually studied by the end of the project.

**How to use this before an interview:** read top to bottom. Each item links back to the doc with the
full explanation. If you can't re-explain an item out loud without looking, that's the one to re-read
first.

---

## Legend

- `[ ]` — flagged as a gap, not yet studied beyond this line
- `[x]` — the explanation has been written and read
- `[x] (practiced)` — read **and** exercised in real code. This is the only bar that counts as
  "understood." An item stays un-practiced until you've watched it work — or watched it fail.

---

## Carried in from P1-dashboard — already practiced

Recorded so they aren't re-taught. Full detail is in `../../CLAUDE.md` §6.

- [x] *(practiced)* httpOnly cookies vs localStorage · CSRF mechanism · `SameSite` · CORS with credentials
- [x] *(practiced)* Salt vs pepper · Argon2id vs bcrypt (memory-hard vs CPU-cost-only)
- [x] *(practiced)* RBAC via `JwtAuthGuard` → `RolesGuard` → `Reflector`
- [x] *(practiced)* Migrations vs `synchronize`; what does not belong in a migration
- [x] *(practiced)* UUID vs auto-increment primary keys (IDOR enumeration)
- [x] *(practiced)* TypeORM entities, relations, `migration:generate`, soft delete
- [x] *(practiced)* NestJS module encapsulation, DI, `overrideProvider` for test substitution
- [x] *(practiced)* Fail-fast env validation *(concept — see M0 Q5 for the mechanics that were missing)*
- [x] Cardinality: many-to-one vs many-to-many — "can the *other* side be shared?"
- [x] TOCTOU — why check-then-insert can't prevent duplicates; only a DB constraint closes it
- [ ] **Guard vs Interceptor vs Pipe vs Middleware** — reviewed twice conceptually, still not
      internalised. Needs hands-on repetition. *(practise in M0/M1)*
- [ ] **Unit vs e2e testing** — reviewed conceptually in P1; **has never written either.** The single
      biggest CV gap. *(practise in M8)*

---

## From M0 — Foundation, Docker & Service Topology
[full doc](phase-0-foundation-understanding-check.md) · [concepts](../concepts/00-docker-and-service-topology.md)

### Docker

- [ ] **`localhost` is a network namespace, not a machine** — the single root cause of most "works
      outside Docker" bugs. Each container has its own loopback. *(M0 Q1)*
- [ ] **Service name as hostname** — Compose creates a user-defined bridge network; Docker's embedded
      DNS at `127.0.0.11` resolves service names to container IPs. *(M0 Q1)*
- [ ] **Published ports are a host→container door only** — container-to-container always uses the
      *container* port, regardless of the mapping. `"5433:5432"` still means `5432` internally.
- [ ] **`host.docker.internal`** — reaching the host from inside a container. Needed in M5 for the
      Stripe CLI. *(M0 Q1)*
- [ ] **Two Postgres instances trap** — a local install plus a published container port; know how to
      confirm which one you're connected to. *(M0 Q1)*
- [ ] **`depends_on` orders startup, not readiness** — and the network is unreliable *forever*, so
      app-level retry matters more than the healthcheck. *(M0 Q2)*
- [ ] **Compose healthchecks** — `test`, `interval`, `retries`, `start_period`, and
      `condition: service_healthy` vs `service_completed_successfully`. *(M0 Q2)*
- [ ] **Named volumes vs bind mounts** — data vs code; why bind-mounting Postgres data on Windows is
      a bad idea. *(M0 Q3)*
- [ ] **`down` vs `down -v`** — and *which* of our services can afford to lose its data, which is a
      design property (`TR-DEC-007`) rather than an accident. *(M0 Q3)*
- [ ] **Image layer caching** — why `COPY package.json` + `npm ci` comes before `COPY . .`
- [ ] Multi-stage Dockerfile and `.dockerignore` *(Q169 — not yet covered, needed before M8)*

### Operations

- [ ] **Liveness vs readiness vs startup probes** — the remedy is what distinguishes them: restart vs
      deregister vs wait. *(M0 Q6)* ⚠️ **A misconception was corrected here** — the M0 answer merged
      all three into a single startup check. Re-read this one.
- [ ] **Liveness must never check dependencies** — the restart-storm failure mode, where a broker
      outage becomes a total outage caused by the health check itself. *(M0 Q6)*
- [ ] **Readiness includes only what this instance needs to serve** — not everything that's up.
      Postgres yes, Redis no, RabbitMQ no, for reasons specific to this app. *(M0 Q6)*
- [ ] **Health probes drive automation; monitoring drives humans.** Don't overload readiness with
      "something is wrong."
- [ ] **Config validation at bootstrap, before the port binds** — and exit non-zero so a rolling
      deploy halts. *(M0 Q5)*
- [x] *(practiced)* **Validate shape, not just presence** — a live payment key in dev is worse than
      a missing one. *(M0 Q5)* Implemented in M5: `STRIPE_SECRET_KEY` is regex-validated against
      `/^sk_test_/` at boot — a live key cannot pass validation and reach this codebase at all.
- [ ] **`.env` vs `.env.example` vs platform secret injection**; rotate-first when a secret leaks.
      *(M0 Q5, Q177)*
- [ ] **Connection pool exhaustion vs server refusal** — a client-side *wait* with a healthy-looking
      database, versus `FATAL: sorry, too many clients already`. Different symptom, different fix.
      *(M0 Q7)*
- [ ] **Pool sizing at peak, not steady state** — reserved superuser slots, GUI tools, migration
      runners, worker processes with their own pools, and double-count during rolling deploys.
      *(M0 Q7)*
- [ ] **PgBouncer in transaction mode** — the real answer at scale, because a bigger pool usually
      makes throughput worse. *(M0 Q7)*
- [ ] **Never hold a transaction open across a network call** — feeds directly into M3. *(M0 Q7)*

### Architecture

- [ ] **Redis vs RabbitMQ, argued properly** — acknowledgement-with-redelivery is the dividing line,
      not "different purposes." *(M0 Q4)* ⚠️ Answered at category level, not mechanism level.
- [ ] **Redis Streams ≠ Redis lists** — Streams have consumer groups, `XACK`, pending-entries lists,
      claim-on-timeout. BullMQ is a legitimate production choice. Knowing this makes the RabbitMQ
      choice a decision rather than a default. *(M0 Q4, Q147)*
- [ ] **Redis is a data-structure server, not "the caching thing"** — three distinct jobs in this
      project, only one of which is caching. *(M0 Q4)*
- [x] *(practiced)* **The Stripe webhook can't use the normal request pipeline** — raw body for
      signature verification, breaking at *body parsing*, before the `ValidationPipe` ever runs.
      *(M0 Q8, answered incorrectly at the time — guessed login)* Resolved and shipped in M5: see
      `../concepts/05-stripe-payments-and-webhooks.md` §3 and
      `../walkthroughs/m5-stripe-code-walkthrough.md` §4 for the working `rawBody: true` mechanism,
      confirmed live against the running server with both a tampered and a validly-signed payload.
- [x] *(practiced)* **Global prefix vs external callback URLs** — `/api/webhooks/stripe`, not
      `/webhooks/stripe`. Same class of bug as P1's cookie-`Path` incident. *(M0 Q8)* The real route
      is registered under the global `/api` prefix in M5, exactly as planned.

### PostgreSQL DDL

- [ ] **`ADD COLUMN NOT NULL` on a populated table fails outright** — and the PG11 boundary where
      adding with a `DEFAULT` stopped rewriting the whole table. *(M0 Q9)*
- [ ] **Expand → migrate → contract** — nullable, backfill in batches, then constrain. *(M0 Q9)*
- [ ] **`ACCESS EXCLUSIVE` locks and lock *queuing*** — one slow `SELECT` plus one `ALTER` freezes the
      whole table, because later queries queue behind the waiting ALTER. Always `SET lock_timeout`.
      *(M0 Q9)*
- [ ] **A migration and a deploy are two separate events** — both code versions run against one schema
      during a rolling deploy. *(M0 Q9)*
- [ ] **`VALIDATE CONSTRAINT` takes a weaker lock** than `SET NOT NULL`, which is why the `CHECK …
      NOT VALID` two-step exists. *(M0 Q9)*

---

### Practiced during M0 implementation

Marked separately from the read-only items above, because these were exercised in real code or
observed failing — the only bar that counts.

- [x] *(practiced)* **Compose healthchecks + `condition: service_healthy`** — written for all three
      services; RabbitMQ needed `start_period: 30s` or it fails its own check while still booting.
- [x] *(practiced)* **Published vs container ports** — Postgres published on 5433 to avoid the local
      install, while the containerised API still connects on 5432. Both values visible in one file.
- [x] *(practiced)* **Named volumes** — declared for all three services; `down` vs `down -v` now has
      real data behind it.
- [x] *(practiced)* **Liveness vs readiness, observed.** Stopped Redis: readiness → 503, liveness →
      200. Stopped RabbitMQ: both stayed 200. Restarted Redis: readiness recovered unaided. This is
      the M0 Q6 misconception corrected by watching it, not by reading about it.
- [x] *(practiced)* **Fail-fast config validation** — `env.validation.ts` throws before the port binds.
- [x] *(practiced)* **App-level connection retry** — `retryAttempts` alongside the healthcheck,
      because the healthcheck only solves the boot race once.
- [x] *(practiced)* **Guard vs Interceptor vs Pipe vs Filter** — the long-standing gap, finally
      exercised. `@SkipEnvelope()` opted a route out of the *interceptor* and the 503 still came back
      enveloped, because **an interceptor only wraps the success path** and a throw goes to the
      filter instead. Fixed with a controller-scoped `@UseFilters`. Re-read
      `health-exception.filter.ts` — that comment is the clearest version of the lifecycle.
- [x] *(practiced)* **CORS is browser-enforced, not server-enforced.** A request from a disallowed
      origin still returned **200 with the full body** — the server declares a policy and the
      *browser* refuses to hand the response to JS. CORS is not a firewall; curl ignores it entirely.
      *(Q104)*
- [x] *(practiced)* **Nest 11 / path-to-regexp v8** — `{*path}`, not `(.*)`, for wildcard route
      exclusions.
- [x] **A health check can silently stop checking.** Terminus's `getStatus(key, healthy, data)`
      spreads `data` over the up/down verdict, so a `status` key in `data` overwrites it and the
      entry is dropped from the result entirely. Readiness returned 200 while not checking Redis at
      all. Found by reading a *passing* response.

---

## From M1 — Auth
[full doc](phase-1-auth-understanding-check.md) · [walkthrough](../walkthroughs/m1-auth-code-walkthrough.md)

### Answered correctly — reinforce, don't re-study

- [x] *(practiced)* **JWT signed vs encrypted** — payload readable by anyone; signing gives integrity,
      not confidentiality. Verified by decoding a real token in the M1 checks.
- [x] *(practiced)* **Role staleness and the denylist tradeoff** — correct answer given. ⚠️ One
      correction: "the lookup destroys the reason we use JWT" is overstated. The benefit is no shared
      session store and no session affinity, not zero DB calls. Also learn the **token_version**
      approach — immediate revocation for one integer compare, no growing denylist. *(M1 Q1)*
- [x] *(practiced)* **Role vs ownership layering** — JwtAuthGuard → RolesGuard → service ownership
      check, answered correctly and built exactly that way. *(M1 Q5)*

### Corrected misconceptions — re-read these

- [x] ⚠️ **Rotation's false positive is about DELIVERY, not storage.** Cookie vs body vs keychain is
      irrelevant: the response carrying the replacement never arrived, so the client still holds the
      old token while the server has moved on. You cannot reliably distinguish this from theft — you
      choose which error to prefer. *(M1 Q2, `TR-DEC-017`)*
- [x] **403 vs 404 is decided per resource.** 404 hides existence; 403 is honest. Events are public
      so 403 is right; orders and holds are private so 404 is right. *(M1 Q5)*
- [x] **The forcing reason for NextAuth's `jwt` strategy is not performance** — the Credentials
      provider *cannot use* the database strategy at all. *(M1 Q6)*

### New ground — all of it NextAuth, none previously known

- [ ] **XSS vs CSRF, argued rather than recited** — what httpOnly closes (token *exfiltration*, not
      the attack), what Bearer closes structurally (ambient authority), and why the best answer is
      neither but the hybrid. **The single most valuable auth tradeoff to be able to argue.** *(M1 Q3)*
- [ ] **bcrypt vs Argon2id parameters** — pick a wall-clock budget, then buy resistance within it.
      bcrypt's 72-byte truncation and why that makes peppering a sharp edge. *(M1 Q4, `TR-DEC-016`)*
- [ ] **Login as a DoS vector** — unauthenticated, deliberately expensive, and the cost is paid
      *before* rejection. The security property *is* the vulnerability. *(M1 Q4)*
- [ ] **The enumeration/DoS tension** — hashing unknown users prevents timing enumeration and makes
      the DoS worse. Rate limiting is the layer that resolves it, and it is cut from scope. *(M1 Q4)*
- [ ] **`jwt` vs `session` callback** — storage vs view; why they are separate; what breaks if you
      only touch `session` (sign-in appears to work, then every API call 401s). *(M1 Q7)*
- [ ] **`NEXTAUTH_SECRET`** — encrypts NextAuth's session cookie, *not* the backend's JWT. Two
      secrets, two systems, and that split is real defence in depth: leaking it forges a session but
      not a valid access token. *(M1 Q8)*
- [ ] **The parallel-refresh race** — and why a module-level in-flight promise does not transfer from
      a browser interceptor to a server-side callback that may run in separate processes. *(M1 Q9)*
- [ ] **Credentials provider** — the warning is about owning passwords, which we do not do inside
      NextAuth. We use roughly 20% of the library, deliberately. *(M1 Q10)*

### Practiced during M1 implementation

- [x] *(practiced)* **Global guards fail closed; per-route guards fail open.** Plus registration
      order — authentication must populate `request.user` before authorisation reads it.
- [x] *(practiced)* **Algorithm pinning** — `algorithms: ['HS256']`. Verified that a forged token and
      an `alg: none` token are both rejected.
- [x] *(practiced)* **Timing-parity defence** — a dummy bcrypt comparison for unknown emails,
      measured at 0.44–0.48s across both branches.
- [x] *(practiced)* **Fast hash for high-entropy secrets** — SHA-256 for refresh tokens, bcrypt for
      passwords, and being able to say why.
- [x] *(practiced)* **DB constraint over pre-check** — catching `23505` rather than SELECT-then-INSERT,
      because the pre-check cannot win the race anyway.
- [x] *(practiced)* **Interceptor ordering** — `ClassSerializerInterceptor` must run *inner* to the
      envelope, or `@Exclude()` is silently useless. Same class of trap as M0's `@SkipEnvelope()`.
- [x] *(practiced)* ⚠️ **One column, two meanings, one security bug.** `revoked_at` meant both
      "rotated" and "killed for cause", so the grace window resurrected revoked families and logout
      did nothing for 30 seconds. Every piece was individually correct; the composition was not.
      **Found only by checking the other tokens after a revocation.** *(walkthrough §3)*
- [x] *(practiced)* **Nullable column adds are instant; NOT NULL on a populated table is not** —
      the M0 Q9 lesson met in real code.
- [x] *(practiced)* **Fail closed on ambiguous legacy data** — unknown `revoked_reason` is treated as
      revoked-for-cause, and backfilling to `rotated` would have re-introduced the bug.
- [ ] **Extensions and least privilege** — `uuid_generate_v4()` needs `uuid-ossp`, and
      `CREATE EXTENSION` needs superuser. Worked only because `TR-DEC-015` connects as `postgres`.

---

## Study queue before M3 (the concurrency gate)

M0's gate was passed on the reasoning that its failures are immediate and cheap. **M3's are not** — a
misconception about isolation produces code that passes tests and oversells under load. These are
prerequisites, not suggestions:

- [ ] Isolation levels and the anomaly each prevents — read committed (Postgres default), repeatable
      read, serializable; dirty read, non-repeatable read, phantom read *(Q82)*
- [ ] Lost update — two transactions read 100, both subtract 10, result is 90. Then the three fixes:
      `SELECT … FOR UPDATE`, atomic `SET x = x - 10`, optimistic version column *(Q83)*
- [ ] MVCC — why an `UPDATE` writes a new row version, and why that makes `VACUUM` necessary *(Q86)*
- [ ] Deadlocks — consistent lock ordering, short transactions *(Q84)*
- [ ] Optimistic vs pessimistic locking, and when each is right *(Q85)*
