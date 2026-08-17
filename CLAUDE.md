# CLAUDE.md — TicketRush backend

NestJS · TypeORM · PostgreSQL · Redis · RabbitMQ · Stripe · Socket.IO · Docker Compose

Shared project context, the working protocol, and the module plan are in
[../CLAUDE.md](../CLAUDE.md). Architecture decisions are in [../DECISIONS.md](../DECISIONS.md).
Module detail is in [docs/phases.md](docs/phases.md).

---

## 1. Naming

- **Files:** kebab-case, suffixed by role — `events.controller.ts`, `create-event.dto.ts`,
  `roles.guard.ts`, `event.entity.ts`.
- **Folders:** kebab-case, one per domain module.
- **Classes:** PascalCase suffixed by role (`EventsService`, `CreateEventDto`, `JwtAuthGuard`) —
  matches Nest CLI generators exactly. Don't deviate.
- **Types/interfaces:** PascalCase, no `I` prefix. `UserPayload`, never `IUserPayload`.
- **Env vars:** `SCREAMING_SNAKE_CASE`; the typed config properties reading them are camelCase
  (`DATABASE_URL` → `config.databaseUrl`).
- **Tests:** colocated `<name>.spec.ts` for unit; `test/<flow>.e2e-spec.ts` for e2e.

---

## 2. Structure and layering

```
src/
├── modules/<domain>/     controller, service, entities/, dto/ — owns one domain end-to-end
├── common/               guards, decorators, filters, interceptors, pipes — ZERO business logic
├── config/               env validation schema + typed config
├── database/             DataSource + migrations/
├── app.module.ts
└── main.ts
```

| Layer | May import from | Rule |
|---|---|---|
| `modules/*` | `common/`, `config/`, other modules' **exported** providers only | Never reaches into another module's internals. |
| `common/` | *nothing from `modules/`* | If it needs to know an entity's business rules, it doesn't belong here. |
| `config/` | *nothing* | |
| `database/` | `config/` | Migrations and wiring only. |

**Strict import rule:** dependency arrows point from feature modules *inward* toward shared code,
never outward. Mirrors the frontend's FSD rule exactly.

**Module rules**
- **One responsibility per module** — a business domain end-to-end, never a technical layer. No
  global `controllers/`, `services/`, `repositories/` dumping grounds.
- **Controllers stay thin.** No business logic, no repository access. More than ~10–15 lines is a
  signal that service logic leaked in.
- **Services never touch `Request`/`Response`.** Keeps logic framework-agnostic and unit-testable
  without mocking HTTP internals.
- **Constructor injection only.** Never `new SomeService()` inside another class.

**Request lifecycle** — know this order cold; it decides where a cross-cutting concern belongs:
```
Request → Middleware → Guards (authn, then authz) → Interceptors (pre) → Pipes (ValidationPipe)
        → Handler → Interceptors (post: envelope) → Exception Filters → Response
```

---

## 3. DTOs and validation

- Every request body is a DTO class validated by `class-validator`, enforced by a global
  `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })` — unexpected
  fields are **rejected**, not silently accepted.
- `dto/<action>-<entity>.dto.ts`. **Separate create and update DTOs** — never one all-optional DTO
  for both; that's how an invalid partial payload slips through create. Use `PartialType` from
  `@nestjs/swagger` (not `@nestjs/mapped-types`) so `@ApiProperty` metadata is copied too.
- **Never accept a client-supplied field the server must own.** No `id`, `createdAt`, `organiserId`,
  `status`, or price in a DTO where the client could forge or escalate. In this project the one
  deliberate exception is `role` at registration — see `TR-DEC-003` for why that is safe *here* and
  would not be in most systems.
- Sort and filter params validate against an explicit per-entity allow-list — never interpolated
  into `ORDER BY`.

---

## 4. Entities

- One `@Entity()` class per `<name>.entity.ts`.
- Every entity: UUID `id` (not auto-increment — sequential ints leak record counts and enable IDOR
  enumeration), `createdAt`, `updatedAt`.
- **Money is integer minor units** (`price_cents`, `amount_cents`). Never a float. An interviewer who
  sees `FLOAT` for currency ends the round; `DECIMAL`/`NUMERIC` is also defensible. *(P1 used
  `numeric(10,2)` typed as `string`, because `pg` returns numeric as a string specifically to avoid
  precision loss — fighting that with a `number` reintroduces the bug the column type prevents.)*
- **`TIMESTAMPTZ`, always.** Never bare `TIMESTAMP`.
- Sensitive fields excluded **by construction** — `@Exclude()` on `passwordHash` plus a global
  `ClassSerializerInterceptor`, never a manual `delete user.passwordHash` per method.
- Derived values are getters with `@Expose()`, not columns — storing a pure function of another
  column gives you two sources of truth that drift.

---

## 5. API contract

Enforced globally by `ResponseEnvelopeInterceptor` (wraps returns) + `AllExceptionsFilter` (wraps
throws). **Controllers never hand-build the envelope** — they return raw data or throw a plain
`HttpException` subclass with a human-readable message.

**No route opts out** (`TR-DEC-019`). Health endpoints included: Terminus's result arrives nested
under `data`, and a probe reads `data.status`. If a future route genuinely cannot be wrapped (file
download, SSE), it needs an interceptor opt-out **and** a matching filter — an interceptor only covers
the success path, and a throw goes to the filter instead.

```ts
interface ApiEnvelope<T> { success: boolean; data: T; message?: string; timestamp: string }

interface ApiErrorEnvelope {
  success: false; data: null;
  message: string;           // always a string — structured payloads go to `details`
  statusCode: number; path: string; timestamp: string;
  errors?: string[];         // field-level messages from the ValidationPipe
  details?: unknown;         // e.g. a Terminus health result
}

interface PaginatedResponse<T> {
  data: T[]; total: number; page: number;
  limit: number;              // "limit", NOT "pageSize" — same name in query and response
  totalPages: number; hasNextPage: boolean; hasPreviousPage: boolean;
}
```

Request shape: `GET /api/events?page=1&limit=25&search=x&sort=startsAt_asc`. `page` is 1-indexed.
Every list endpoint is server-paginated — never an unbounded array. All `PaginatedResponse` fields
are always present, even when `data` is empty.

**Global prefix** `app.setGlobalPrefix('api', { exclude: ['health/(.*)'] })` — set at M0, not
retrofitted. Health checks live at conventional unprefixed paths because ops tooling expects them
there.

**Error messages**
- **Auth failures are generic** — `"Invalid email or password"`, never distinguishing "user not
  found" from "wrong password". Prevents user enumeration.
- **Validation failures are specific** — `class-validator`'s messages help the legitimate caller and
  leak nothing about system state.
- **5xx never leaks internals** — no stack traces, no SQL text in a response body, in any environment
  reachable by real traffic. Log fully server-side, return a generic message.
- `DELETE` returns `200` + `{ deleted: true }` in the envelope, not `204` — `204` can't carry a body,
  and contract consistency beats REST purism here.

**The one route that breaks this pipeline:** `POST /api/webhooks/stripe`. It needs the **raw request
body** for signature verification, so it must bypass JSON body parsing and the global
`ValidationPipe`. Note this is a *request*-side exemption, not a response one — Stripe reads only the
status code, so the envelope on the way out is harmless. See `docs/concepts/` when M5 lands; this is
the single most common Stripe integration bug.

---

## 6. Migrations

- Every schema change is a reviewed migration file. **`synchronize: false` in every environment,
  including local dev**, so what you test locally is what ships.
- Migrations never contain: bulk or fake data, business logic, secrets, or large inline destructive
  backfills. Small fixed-cardinality reference data is a defensible exception, in a clearly-named
  seed script.
- **Once applied anywhere outside your own machine, a migration is immutable.** Fix mistakes with a
  new migration, never by editing history.
- Review `down()` for ordering: drop FKs before tables, drop enum types only after the table using
  them is gone.
- **A migration and a deploy are two separate events.** During a rolling deploy both code versions
  run against one schema, so every schema change must be backward-compatible with the currently
  running code. Expand → migrate → contract; never drop or rename a column in the same release that
  stops using it.
- Set `lock_timeout` before DDL on a populated table, so a blocked `ALTER` gives up instead of
  building a lock queue that freezes the table.

---

## 7. Security checklist — before any auth-adjacent endpoint is done

- [ ] Argon2id hashing with a pepper; never logged, including in stack traces or error messages.
- [ ] Generic auth failure messages (no user enumeration).
- [ ] No `synchronize: true` anywhere, including local dev.
- [ ] CORS with an explicit origin allow-list — never a wildcard combined with credentials.
- [ ] No stack traces or raw DB errors in any client-reachable response.
- [ ] **Ownership checked separately from role.** `@Roles('organiser')` does not mean "owns this
      event". Role and ownership are independent axes; conflating them is exactly how IDOR ships.
      Every `:id` route that mutates must verify the caller owns the resource.
- [ ] No client-supplied field the server must own accepted in a DTO.

**No CSRF layer in this project** — and that is a consequence, not an omission. CSRF exploits
*ambient authority*: a cookie the browser attaches automatically to a cross-site request. An
`Authorization` header is never attached automatically, so a forged cross-origin request carries no
credentials at all. Token auth is CSRF-immune; cookie auth is not. See `TR-DEC-001`.

---

## 8. Testing

- **Unit:** business and security logic in isolation, dependencies mocked via
  `overrideProvider().useValue()`. No real DB, no real HTTP.
- **E2E:** full HTTP contract against a **separate test database** — real status codes through the
  real guard/pipe/filter chain, not service-level assertions. Never against the dev database.
- An endpoint isn't done until it has one unit test (happy path + a failure branch) and one e2e test.
- **The user has never written either kind.** M8 is the first time; treat it as a teaching module,
  not a formality.

---

## 9. Hard-won lessons from P1

Real bugs from the previous project. Each generalises, and each is an interview answer.

**Changing URL structure means auditing every cookie `Path`.** A refresh cookie scoped `Path=/auth`
was set before a global `/api` prefix was added and never updated. The browser correctly refused to
send a cookie whose path didn't match `/api/auth/refresh` — so every refresh failed, and silently,
**logout never revoked anything server-side** because the handler read `undefined`. Logout *appeared*
to work since the cookie was cleared client-side. A "logged out" token stayed valid for its full
7 days. *(Not directly applicable now that auth is Bearer-based, but the class of bug — global config
change invalidating a scoped assumption made earlier — absolutely is. The `/api` prefix vs the Stripe
CLI's `--forward-to` path is the same trap in M5.)*

**A credential's lifetime must outlive whatever needs to present it.** A CSRF cookie was given the
access token's 15-minute lifetime, but `/auth/refresh` is called *precisely when the access token has
expired* — so the CSRF cookie had expired too, and every silent refresh failed.

**Narrowing scope can silently disable a sibling.** `Path=/auth/refresh` looked tighter than
`/auth`, but excluded `/auth/logout`, whose revocation step then no-op'd forever.

**Parallel refreshes look like token theft.** Several requests 401 at once, all call refresh; the
first rotates the token and the rest present an already-consumed one — which reuse-detection
correctly reads as theft and answers by killing the session family. Needs a single in-flight refresh.
Now the frontend's problem (NextAuth's `jwt` callback), but the backend half — reuse detection — is
what makes the race fatal rather than merely wasteful.

**TypeORM's `eager: true` does not apply to `save()`.** It affects find-family queries only.
`create()` returned an entity with the relation entirely missing; `update()` returned a *stale*
relation — correct FK column, wrong nested object — which surfaces in the UI immediately after a
change and self-corrects on the next refetch, making it maddening to reproduce. Assign the fetched
relation explicitly onto the saved entity before returning it.

**Cardinality test: "can the *other* side be shared?"** — not "does this record have only one X".
`User→Role` is many-to-one (a plain FK column). `Role→Permission` is many-to-many (needs a join
table; a plain FK literally cannot express it). This was P1's biggest single miss.

**Hash choice depends on entropy, not on which is newer.** Argon2id for passwords, because they are
guessable and it is **memory-hard** (bcrypt is CPU-cost-only). Plain SHA-256 for refresh tokens,
because those are already high-entropy random values — nothing to slow down, and a slow hash just
burns CPU on every refresh.

**Rotation means inserting a new row and marking the old one revoked**, never updating a token in
place. Update-in-place destroys exactly the history reuse detection needs.

**TOCTOU: "check then insert" cannot prevent duplicates under concurrency.** Only a database-level
unique constraint closes the window atomically. **This is the same insight M3 is built on** —
read-then-write is a race in every form it takes, and the atomic conditional `UPDATE` is that lesson
applied to inventory.

**Audit trails must not have foreign keys to what they audit.** An FK either blocks deleting a user
who ever did something logged, or deletes their history along with them. Both are wrong.

**Testing with curl never renders anything.** An API returned a nested object where the UI expected a
flat string; TypeScript's structural typing didn't catch it and months of curl testing didn't either.
Verify through the real consumer, not only the HTTP layer.
