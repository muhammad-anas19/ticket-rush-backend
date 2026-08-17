# M1 — Auth: Code Walkthrough

**How this project implements what `qa/phase-1-auth-understanding-check.md` explains.** Read the Q&A
first — this doc assumes it and talks about real files.

**Status:** backend complete and verified live, including two failure paths that found a real security
bug. Frontend (NextAuth) is next, after `frontend/docs/concepts/01-nextauth.md`.

---

## 1. What exists

```
backend/src/
├── modules/users/
│   ├── entities/user.entity.ts      UserRole enum, @Exclude() on passwordHash
│   ├── users.service.ts             email normalisation, constraint-violation → 409
│   └── users.module.ts              no controller — scope discipline
├── modules/auth/
│   ├── entities/refresh-token.entity.ts   token_hash, family_id, revoked_at, revoked_reason
│   ├── password.service.ts          bcrypt cost 12, plus verifyDummy() for timing parity
│   ├── auth.service.ts              register / login / refresh / logout
│   ├── auth.controller.ts           5 routes
│   ├── strategies/jwt.strategy.ts   Bearer extraction, algorithm pinned
│   ├── dto/                         register, login, refresh, responses
│   └── auth.module.ts
├── common/
│   ├── decorators/{public,roles,current-user}.decorator.ts
│   └── guards/{jwt-auth,roles}.guard.ts
└── database/migrations/
    ├── 1786949624880-CreateUsersAndRefreshTokens.ts
    └── 1786950279388-AddRevokedReason.ts        ← fixes a security bug, not a preference
```

| Route | Auth | Notes |
|---|---|---|
| `POST /api/auth/register` | public | 201. Role self-selected (`TR-DEC-003`) |
| `POST /api/auth/login` | public | 200, not 201 — a session is not a resource with a URL |
| `POST /api/auth/refresh` | public | Public deliberately: the access token is *expected* to be expired |
| `POST /api/auth/logout` | public | Idempotent — unknown token still 200 |
| `GET /api/auth/me` | Bearer | Reads the DB, not the token's claims |

---

## 2. Decisions visible in the code

### Guards are global, so authorisation fails closed

`app.module.ts` registers `JwtAuthGuard` then `RolesGuard` as `APP_GUARD` providers. Every route
requires a valid Bearer token unless it carries `@Public()`.

The direction matters. Per-route `@UseGuards(JwtAuthGuard)` fails **open** — forget it on one new
endpoint and that endpoint is silently unauthenticated, with no failing test and nothing in the logs.
Global-plus-opt-out fails **closed**: forget `@Public()` and it returns 401 to everybody, which you
notice in ten seconds. Every `@Public()` is then a greppable, deliberate declaration —
`git grep '@Public'` is an audit.

Registration **order** is load-bearing: global guards run in the order registered, so authentication
populates `request.user` before authorisation reads it. Swap the two lines and `RolesGuard` sees no
user on every request and reports 403 "Authentication required", sending you hunting for a token bug
that does not exist.

They are `APP_GUARD` providers rather than `app.useGlobalGuards()` because both need `Reflector`
injected, and guards registered from `main.ts` are built outside the DI container.

### Role checks in the guard, ownership in the service

Straight from Q5. `RolesGuard` answers "are you the *kind* of user permitted here" — answerable from
the token alone, no database, which is exactly why a guard can do it.

It cannot answer "is this record yours", because a guard runs before the handler with no resource
loaded. Doing it there means querying the event in the guard and again in the service — two round
trips for one operation — or stashing the entity on the request and coupling them through a mutable
object.

> Role → guard (token is enough). Ownership → service (needs the resource).

M2 is where that second half gets built and tested; there is no owned resource yet.

### 403 versus 404 is decided per resource, not globally

`roles.guard.ts` throws 403, and the comment records why the answer differs elsewhere: events are
**public**, so hiding existence buys nothing. Orders and holds are **private**, so a 403 there would
confirm an ID exists and let someone probe. Return 404 when existence is confidential, 403 when it is
already public.

### Timing parity on login, and the cost of it

`password.service.ts` builds a real bcrypt hash at boot and exposes `verifyDummy()`. When an email
does not exist, `auth.service.ts` calls it before throwing.

Without it, login is a **user-enumeration oracle**: unknown addresses return in ~2ms, known ones in
~250ms, so an attacker with a wordlist maps registered users without guessing a single password. A
generic error *message* does not close that — the timing is the leak.

Measured, three runs:

```
run 1: known=0.467s  unknown=0.471s
run 2: known=0.445s  unknown=0.459s
run 3: known=0.439s  unknown=0.482s
```

**The cost is real and unresolved.** Every login now pays for a bcrypt comparison whether the email
exists or not, which makes the DoS on that unauthenticated endpoint strictly worse. Rate limiting is
the layer that actually addresses it, and `TR-DEC-004` cut it from scope. Recorded as an open M8
finding, not quietly ignored.

### The refresh token is not a JWT

32 bytes from `randomBytes`, stored as a **SHA-256** hash. A fast hash, deliberately: the value is
already high-entropy, so there is nothing for a slow hash to slow down, and bcrypt would burn 250ms of
CPU per refresh for nothing. Slow hashes exist for *guessable* secrets.

Opaque rather than signed means the server is the sole authority on validity — which is what makes
revocation possible at all.

### Algorithm pinning in the strategy

`jwt.strategy.ts` sets `algorithms: ['HS256']`. Without it, a library may trust the `alg` in the token
it is validating, which is the root of two classic breaks: `alg: none`, and RS256→HS256 confusion where
the attacker re-signs using the public key as the HMAC secret. Both verified rejected below.

### `/me` reads the database

The token carries `email` and `role` for cheap authorisation, but `/me` is the one endpoint where a
client legitimately asks "what is true now". Answering from a token issued up to 15 minutes ago would
report stale data as fact.

---

## 3. What surprised me

### A revoked session could resurrect itself

**The bug.** Reuse detection fired correctly and returned 401 — and then the *current* refresh token
still worked:

```
reuse the spent token, 33s later  → 401 "Session revoked"    ✅ correct
the CURRENT token, immediately    → 200 + a fresh token pair ❌ should be dead
```

`revokeFamily()` had marked every live token in the family revoked, exactly as intended. But
`revokedAt` was doing **two jobs**: "spent by a normal rotation" and "killed because we suspect
theft". The grace window (`TR-DEC-017`) only looked at *how recently* the timestamp was set — so a
family killed for cause had a fresh `revokedAt`, landed in the grace branch, and was handed a new pair.

**Logout had the identical hole**, and worse: refreshing immediately after logging out returned 200
and revived the session.

**The fix** is a `revoked_reason` enum (`rotated` | `reuse_detected` | `logout`). Grace applies only to
`rotated`; anything revoked for cause is permanently dead.

**Why it is worth remembering:** one column answering two semantically different questions. Every
individual piece was correct — the revocation wrote to every row, the grace window did what it was
told — and the composition was wrong. That is the kind of defect tests of the happy path never find.
Reuse detection *appeared* to work: it returned the right status code with the right message. Only
checking what happened to the *other* tokens exposed it.

The migration comment records one more thing: existing rows keep `revoked_reason = NULL`, and unknown
reasons are treated as revoked-for-cause. **Fail closed on ambiguous data.** Backfilling them to
`'rotated'` would have been *less* safe — it would make every historically revoked token grace-eligible,
which is the bug itself.

### `uuid_generate_v4()` was a latent "works on my machine"

The generated migration used `uuid_generate_v4()`, which lives in the `uuid-ossp` extension and is not
installed by default. It ran here only because something had already enabled it on this server.

Added `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"` by hand. Two things fall out:

- It requires **superuser**, which we have only because `TR-DEC-015` connects as `postgres`. With the
  least-privilege role that was considered and dropped, this line fails — a concrete instance of that
  tradeoff rather than an abstract one.
- Postgres 13+ has `gen_random_uuid()` in core and needs no extension. Not used because TypeORM would
  then see the default as drifted and try to "fix" it in every future generated migration.

**This is exactly why M2's checkpoint insists on running the full migration set against an empty
database.** A migration that has only ever run against a database you evolved by hand is not known to
work.

### `ClassSerializerInterceptor` ordering is a trap

`@Exclude()` on `passwordHash` only does anything if `ClassSerializerInterceptor` sees the handler's
**raw** return value. Interceptors registered first are outermost, so on the response path the *last*
one runs first:

```ts
app.useGlobalInterceptors(
  new ResponseEnvelopeInterceptor(...),   // outer — wraps second
  new ClassSerializerInterceptor(...),    // inner — strips first
);
```

Reversed, `ClassSerializer` would be handed the envelope — a plain object with nothing to strip — and
`passwordHash` would sail through. Same lesson as M0's `@SkipEnvelope()`: knowing the pipeline order
is not trivia.

---

## 4. Verified live

| Check | Result |
|---|---|
| Register | ✅ 201, email lowercased, no hash in response |
| Duplicate email | ✅ 409 from the DB constraint, not a pre-check |
| Login, correct password | ✅ 200 + token pair |
| Login, wrong password | ✅ 401 `Invalid email or password` |
| Login, unknown email | ✅ 401, **identical message** |
| **Timing parity** | ✅ 0.44–0.48s both branches — enumeration oracle closed |
| `/me` with token | ✅ 200 |
| `/me` no token | ✅ 401 — global guard fails closed |
| `/me` tampered signature | ✅ 401 |
| **`/me` forged token, wrong secret** | ✅ 401 |
| **`/me` `alg: none` token** | ✅ 401 — algorithm pinning works |
| `forbidNonWhitelisted` | ✅ 400 `property role should not exist` on login |
| Password < 8 chars | ✅ 400 |
| `role: "admin"` | ✅ 400 `role must be organiser or attendee` |
| Refresh rotates | ✅ new token differs |
| **Grace window replay** | ✅ 200 within 30s |
| **5 parallel refreshes** | ✅ **all 200** — the NextAuth race, pre-empted |
| **Reuse past grace** | ✅ 401, family revoked |
| **Family stays dead** | ✅ 401 — *was 200 before the fix* |
| **Refresh after logout** | ✅ 401 — *was 200 before the fix* |
| Logout twice / garbage token | ✅ 200, idempotent |
| `passwordHash` in any response | ✅ never |
| JWT payload readable | ✅ decodes to plain JSON — signed, not encrypted |
| Swagger | ✅ all 5 routes at `/docs` |
| Health still public | ✅ 200 with no token |
| Lint + typecheck | ✅ clean |

The three worth remembering: **five parallel refreshes all succeeding** is `TR-DEC-017` earning its
place; **the family staying dead** is the bug above; and **`alg: none` rejected** is algorithm pinning
doing its job.

---

## 5. Known gaps, named as decisions

- **No rate limiting** (`TR-DEC-004`). The most significant one. `POST /auth/login` is unauthenticated
  and spends ~250ms of CPU per request *by design*, and timing parity means it does so even for
  addresses that do not exist. M8 security review.
- **Rotation is not transactional.** Marking a token spent and inserting its replacement are two
  statements. A crash between them leaves the family with no live token, so the user logs in again —
  annoying, not incorrect. Wrapping both in one transaction is the right fix, and it is exactly the
  discipline M3 makes non-negotiable, where the failure mode is oversold tickets rather than a re-login.
- **No `token_version` column.** A role change is invisible until the access token expires (15 min).
  Correct trade for two roles that never change; the upgrade path is one integer claim if that stops
  being true.
- **Expired refresh tokens are never pruned.** `refresh_tokens` grows forever. A periodic delete is
  the fix; noted for M8.
- **`RolesGuard`'s deny branch is untested.** No route carries `@Roles()` yet — nothing is
  role-restricted in M1. M2's organiser-only event creation is the first, and it gets tested there.
- **No tests.** M8, as planned. Everything above was verified by hand over real HTTP, which is not the
  same thing and is why M8 is non-negotiable.

---

## 6. Running it

```bash
cd backend
docker compose up -d          # Redis + RabbitMQ (Postgres is native)
npm run migration:run         # two migrations
npm run start:dev             # :3001
```

```bash
# register → token pair
curl -s -X POST localhost:3001/api/auth/register -H "Content-Type: application/json" \
  -d '{"email":"me@example.com","password":"correct-horse-battery","role":"organiser"}'

# the payload is readable by anyone — signed, not encrypted
echo "<accessToken>" | cut -d. -f2 | base64 -d
```

The failure paths are the interesting part, and the verification script for them lives in the
scratchpad (`m1-verify.sh`). Worth re-running after any change to `auth.service.ts` — the revocation
bug was invisible to every happy-path check.
