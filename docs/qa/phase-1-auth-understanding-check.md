# M1 — Understanding Check: Auth

**Date:** 2026-08-15 · **Gate for:** Module 1 (users, password hashing, JWT, guards, NextAuth)

Answers reproduced verbatim, then graded. Misconceptions corrected explicitly.

---

## Score summary

| # | Topic | Grade |
|---|---|---|
| 1 | JWT signed vs encrypted; role staleness | **Correct** — best answer of the round |
| 2 | Rotation's false positive | **Needs more depth** — contains a misconception |
| 3 | Bearer vs cookie: what we traded | Don't know |
| 4 | Argon2id parameters; login as a DoS vector | Don't know |
| 5 | Role vs ownership | **Correct** — incomplete on 403 vs 404 |
| 6 | NextAuth session strategies | **Partially correct** — right answer, wrong reason |
| 7 | `jwt` vs `session` callback | Don't know |
| 8 | `NEXTAUTH_SECRET` | Don't know |
| 9 | The parallel-refresh race | Don't know |
| 10 | Credentials provider | Don't know |

**Two correct, one partial, one misconception, six unknown.** The split is not random: everything
backend-side that gates implementation was answered correctly, and everything unknown is NextAuth,
which has never been used. That is a clean, honest result.

---

## Q1 — What a JWT actually protects

> **Your answer:** jwt make sure the person requesting for the resource is authenticated or not…
> jwt is signed which means anyone can decode it and can see the info it carries in payload, if it
> is encrypted than the one trying to decrypt it must have decryption key. so role will remain
> organiser till the jwt does not get expired naturally ie 15mins. in order to make it immediately
> effective we have to make the old jwt with organiser role blacklist but the bottleneck is that now
> we have made our jwt stateful, we have to look token every time in db and this lookup destroyed
> the reason why we use jwt

**Grade: correct.** Everything here is right, and the last sentence — recognising that a denylist
converts a stateless token back into a stateful session — is the insight most candidates miss. That
alone is a good interview answer.

Three things to add, one of which is a genuine correction.

### Say "tamper-evident", not just "authenticated"

Signing gives you **integrity and authenticity**: anyone can read the payload (it is base64url, not
encryption — decode it in jwt.io or one line of Node), but nobody can *change* it without the
signing key, because the signature would no longer verify.

So the rule for the payload is simply: **anything you would be comfortable publishing.** No
passwords, no PII beyond an identifier, no secrets, no internal notes. Also keep it small — the token
rides on every request header, and a fat payload is a per-request bandwidth tax.

*(If you genuinely need a confidential payload, that is JWE — encrypted rather than signed. NextAuth's
session cookie is a JWE, which is why Q8 matters.)*

### You named one of the two ways. There are four, and the interesting one is the third

| Approach | Immediate? | Cost |
|---|---|---|
| **Short TTL, accept the window** | No — up to 15 min stale | Free. Usually the right answer. |
| **Denylist / revocation list** — yours | Yes | A store lookup per request; the list grows and needs eviction at token expiry. |
| **Token version / session epoch** | Yes | An integer on the user row, embedded as a claim. Bump it to invalidate everything issued earlier. O(1), no growing list. |
| **Don't embed the claim at all** — read role from the DB per request | Yes | A user lookup per request. Simplest to reason about, and honestly fine for most apps. |

The **token version** approach is worth knowing because it is the elegant middle. `users.token_version`
starts at 0 and is embedded in every access token. Change a role, or "log out everywhere," and you
increment it — every previously issued token now carries a stale version and fails validation. One
integer comparison, and the row is cacheable.

### The correction: "the lookup destroys the reason we use JWT" is overstated

This is the part to sharpen, because an interviewer will push on it.

The benefit of a stateless token is **not** "zero database calls." Most authenticated requests load
the user anyway — to check ownership, to render a profile, to write an audit row. If you are already
fetching that row, the marginal cost of also checking `token_version` is approximately zero.

The real benefits are:

- **No shared session store between services.** Any service holding the public key or shared secret
  can validate a token independently. That matters in a distributed system, not in a monolith.
- **No session affinity.** Any instance can serve any request without sticky sessions or a
  replicated session cache.
- **Validation is local and cheap** under load, where a session store becomes a bottleneck and a
  single point of failure.

So the honest framing is: *"a denylist reintroduces shared state, which gives up the distributed-system
benefit. It doesn't 'destroy' JWTs — plenty of production systems run a denylist and are fine. What
it destroys is the claim that your auth is fully stateless."*

### While we are here — how JWTs get broken

Worth having, because "what does a JWT protect against" invites the follow-up "and how is it
attacked":

- **`alg: none`.** Old libraries accepted a token declaring no algorithm and skipped verification
  entirely. Always pin the expected algorithm on the verifying side; never trust the header's `alg`.
- **Algorithm confusion (RS256 → HS256).** A server that accepts either can be tricked into verifying
  an HS256 token using the *public* RSA key as the HMAC secret — and the public key is public. Again:
  pin the algorithm.
- **No expiry, or expiry not checked.** `exp` is only meaningful if the verifier enforces it.
- **Signature not verified at all** — `jwt.decode()` where `jwt.verify()` was meant. This one still
  ships regularly.

---

## Q2 — Rotation's false positive

> **Your answer:** no backend is not wrong it depends how i have configured frontend, if we are
> saving refresh token in cookies than nothing will go wrong, its backend duty to store and manage it

**Grade: needs more depth — and there is a misconception to clear.**

**The misconception: where the token is stored is irrelevant to this failure.** Cookie, localStorage,
NextAuth's encrypted session, a mobile keychain — makes no difference. The scenario is not about
storage. It is about **delivery**.

Walk it through precisely:

```
client                                server
  | -- refresh(token N) ------------->|
  |                                   | validate N  ✓
  |                                   | mark N used
  |                                   | issue N+1
  |            X  response lost       |  <-- laptop sleeps, wifi drops, TCP dies
  |               (never arrives)     |
  |                                   |
  |   client still holds N            |   server has committed to N+1
  |                                   |
  | -- refresh(token N) ------------->|
  |                                   | N is marked used → REUSE DETECTED
  |                                   | revoke entire family
  | <-- 401, session destroyed -------|
```

The `Set-Cookie` carrying N+1 was in the response that never arrived. The cookie still holds N. The
backend "storing and managing it" doesn't help, because the backend's state is already correct — the
problem is that the two ends disagree, and they disagree because a network is involved.

**Is the backend wrong?** No. It did exactly what reuse detection is supposed to do. The design is
right; the situation is genuinely ambiguous.

### The honest core: you cannot reliably distinguish this from theft

Both look identical on the wire: a token that has already been rotated is presented again. This is
the same class of problem as exactly-once delivery — **you can't confirm a state change across an
unreliable network without a window where the two sides disagree.** You will meet this again in M6,
where it is the reason consumers must be idempotent rather than the reason acks are broken.

Since you cannot distinguish them, you choose which error to prefer.

### What to actually do

| Option | Mechanism | Cost |
|---|---|---|
| **Grace window** ← chosen | For N seconds after rotation, accept the old token and **return the same new pair again** — an idempotent refresh | A stolen token works for N seconds. Keep N small. |
| Request idempotency key | Client sends a UUID; the server replays the same response for a repeat | Requires client cooperation; more moving parts |
| Rotate on a schedule, not every use | Fewer rotations, fewer races | Weakens detection — a stolen token stays valid longer |
| Respond proportionally | On reuse, force re-login rather than revoking the family; or only revoke if IP/user-agent differs | Softer, but heuristics are guessable by an attacker |

**Decision for this project: a grace window** (`TR-DEC-017`). It is the standard fix — Auth0 calls it
refresh-token leeway — and, importantly, **the same mechanism also fixes Q9**, which is the more
likely failure in practice.

The trade stated plainly: for N seconds after a rotation the old token still works, so a thief who
races the legitimate client wins. N is small (30s here) precisely to bound that.

---

## Q3 — What Bearer-in-the-body trades away

> **Your answer:** don't know — explain both in detail

Fair; here it is properly. This is the single most valuable auth tradeoff to be able to argue, and
it comes up constantly.

### What P1's httpOnly cookies gave you, that we have now given up

**XSS token theft.** With `httpOnly`, JavaScript literally cannot read the cookie — `document.cookie`
does not include it. So an XSS payload running on your page:

- **can** still make requests as the user, because the browser attaches the cookie automatically;
- **cannot** exfiltrate the credential.

That difference is bigger than it sounds. Without exfiltration, the attack is confined to the
victim's browser, while the page is open, subject to your CORS policy. With exfiltration, the
attacker has a bearer token they can `curl` from their own machine, from any country, for as long as
it is valid — and they can do it while the victim is asleep.

In our design, `session.accessToken` is plain JavaScript state. One XSS and it is posted to the
attacker's server.

**Two concrete design constraints follow, and they are not optional:**

1. **The access token TTL must be short** — 15 minutes, not hours. The TTL *is* the blast radius.
2. **The refresh token must never be exposed to the client.** It lives in the `jwt` callback's token
   (server-side, inside the encrypted session cookie) and is never surfaced through the `session`
   callback. A stolen 15-minute access token is an incident; a stolen 7-day refresh token is an
   account takeover. Recorded as `TR-DEC-018`.

### What Bearer buys us, that cookies made P1 work for

**CSRF immunity — structurally, not by adding a defence.**

CSRF works on **ambient authority**. `evil.com` renders a form or fires a `fetch` at
`your-api.com/transfer`, and the browser *automatically* attaches your cookies because that is what
cookies do. The attacker never reads anything — they don't need to. They just need the browser to
send the credential on their behalf.

An `Authorization: Bearer` header is never attached automatically. JavaScript has to set it
explicitly, and JavaScript on `evil.com` cannot read a token held in your origin's memory. So a
forged cross-origin request arrives **with no credentials at all** and is simply a 401.

What P1 needed to achieve the same safety with cookies:

- a deliberately non-`httpOnly` `csrf_token` cookie,
- a `CsrfGuard` on every mutating route,
- an axios interceptor reading that cookie and echoing it as a header,
- exemptions for `/auth/login` and for webhooks,
- and it still shipped two real bugs — the CSRF cookie expiring with the access token, and the
  refresh cookie's `Path` not matching after a global prefix was added.

All of that machinery is simply absent here. Not "handled" — absent.

### Which is the better trade, and why it is not obvious

**On pure security, httpOnly cookies win**, and the industry has moved that way. `SameSite=Lax`
became the browser default, which knocked most of the CSRF risk out of cookies for free — so the
cost side of cookies dropped, while XSS is exactly as dangerous as it always was.

But it genuinely is not obvious, for three reasons:

1. **If you have XSS, you are in serious trouble either way.** The attacker can act as the user in
   both designs. The difference is *exfiltration and persistence*, not "safe versus compromised."
   People overstate httpOnly as though it neutralises XSS. It narrows it.
2. **Bearer composes better with a separate API origin**, which is our architecture. Cookies across
   origins mean CORS with credentials, careful `SameSite` handling, and `Path`/`Domain` scoping that
   P1 got wrong twice. Bearer also works unchanged for a mobile app or a CLI, where cookies do not.
3. **The best answer is neither** — it is the hybrid: refresh token in an `httpOnly` cookie, access
   token in memory only (never `localStorage`), short TTL. You get no CSRF on the API (Bearer) and no
   XSS exfiltration of the long-lived credential (httpOnly). That is what a BFF gets you, and it is
   what I would argue for in an interview.

**Our position, stated honestly:** we chose Bearer for architectural simplicity with a separate API
and a learning project, accepted the XSS exposure explicitly in `TR-DEC-002`, and bound it by keeping
the refresh token off the client entirely and the access token short-lived.

---

## Q4 — Password hashing in production

> **Your answer:** Don't know, explain it and use bcrypt in this project

Explanation below, and **bcrypt it is** — recorded as `TR-DEC-016`, superseding the earlier Argon2id
decision. Your call; the reasoning and the cost are written down so it reads as a decision.

### Choosing parameters — the method, not the numbers

Whatever the algorithm, the method is the same: **pick a wall-clock budget, then buy as much
resistance as that budget affords, measured on the hardware you will actually run on.**

A common budget is **200–500ms per hash**. Slower is more secure and worse for users and for your
capacity; faster is the reverse. Measure on the real box — a benchmark from your laptop is not a
benchmark of your server.

**Argon2id** has three knobs:
- `memoryCost` (KiB per hash) — the anti-GPU/ASIC lever, and the one that matters most. Attack
  hardware wins by running thousands of hashes in parallel; each one needing 46 MiB is what stops
  that being cheap.
- `timeCost` — passes over that memory. Linear CPU cost.
- `parallelism` — lanes used per hash.

OWASP's current floor is `m=19456 (19 MiB), t=2, p=1`, or `m=47104 (46 MiB), t=1, p=1`.

**bcrypt** has one knob: the **cost factor**, a power of two. Cost 12 means 2¹² iterations, roughly
250ms on modern hardware. **Use 12.** Cost 10 is the old default and is on the low side now.

### What breaks when memory is set too high

Each *concurrent* hash allocates its full memory. At 46 MiB, fifty simultaneous logins want 2.3 GB —
on a box that is also running your API and its connection pool. You OOM, or worse you start swapping,
which makes hashing slower, which raises concurrency, which allocates more memory. That spiral is
self-reinforcing.

There is a Node-specific trap on top: native hashing runs in **libuv's threadpool, which defaults to
4 threads**. More concurrent hashes than threads simply queue — and because that same pool serves
file I/O and DNS, saturating it slows down parts of your app that have nothing to do with logging in.

This is one reason bcrypt at cost 12 is an easier operational fit: fixed ~4 KiB memory, so
concurrency costs CPU and nothing else.

### Why `POST /auth/login` is a denial-of-service vector

Here is the shape of it:

- The endpoint is **unauthenticated** — anyone can call it.
- It performs **deliberately expensive** work by design.
- The expense is paid **before** you can reject the request, because you cannot know the password is
  wrong until you have hashed it.

So it is an amplification attack: the attacker spends one cheap HTTP POST, you spend 250ms of CPU.
A few hundred concurrent garbage logins can saturate a small server. **The security property is the
vulnerability** — you cannot fix it by making hashing fast, because that is the thing protecting your
password database.

**Mitigations, roughly in order:**

1. **Rate limiting**, per IP *and* per account. Per-IP alone is defeated by a botnet; per-account
   alone lets one IP spray many accounts. This is exactly the layer `TR-DEC-004` cut from scope —
   named again here so its absence stays a decision rather than a gap.
2. **Cap concurrent hashes** with a semaphore, so a burst queues instead of exhausting memory.
3. **Progressive delays or CAPTCHA** after N failures on an account.
4. **Edge rate limiting** — a WAF or CDN rule, so the traffic never reaches your process.

### The tension worth knowing — it is a favourite follow-up

To prevent **user enumeration**, you should hash even when the email does not exist, so a wrong email
and a wrong password take the same time. Otherwise an attacker measures response times and learns
which addresses are registered.

But that directly worsens the DoS: now every garbage request costs you a full hash, and the attacker
does not even need valid emails.

There is no clean resolution — you accept both and put rate limiting in front, which is the layer
that actually addresses it. Being able to *name* the tension is the answer; pretending one side
disappears is not.

### bcrypt specifically — three things that bite

Since we are using it, these matter:

1. **The 72-byte truncation.** bcrypt silently ignores everything past 72 bytes. A 100-character
   passphrase is no stronger than its first 72 bytes, and users are never told.
2. **Peppering needs care because of that.** The common pattern —
   `bcrypt(HMAC-SHA256(password, pepper))` — is fine only because hex SHA-256 is 64 characters, which
   fits. Naively concatenating a long pepper onto a long password can push the real password past the
   boundary and *silently weaken it*. Given the sharp edge and no real benefit at this scale,
   **this project skips the pepper** — recorded in `TR-DEC-016`.
3. **Null bytes.** Some older bcrypt implementations truncate at a `\0`. Not an issue with the
   maintained Node libraries, but it is why "just concatenate things" is a bad habit here.

**Where bcrypt is genuinely weaker:** it uses about 4 KiB of memory regardless of cost factor, so it
is far more amenable to GPU and ASIC attack than Argon2id. It remains an OWASP-acceptable choice at
cost ≥ 10, and it is not a mistake — but "I know bcrypt is CPU-hard only, Argon2id is memory-hard,
and here's when I'd insist on the latter" is the answer that earns credit, and you can give it.

---

## Q5 — Role is not ownership

> **Your answer:** its validation will be based on user id who created the event, only he can update
> it, and it will be checked in service because jwt guard gets the user id who is requesting, then
> role guard verifies role, then in service we check user id against the userid of person who
> created it

**Grade: correct.** The layering is exactly right — `JwtAuthGuard` (who are you) → `RolesGuard` (are
you the kind of user who may do this) → service (is this specific record yours). That is the correct
answer and it is what we will build.

Two things you did not cover.

### 403 versus 404

**403 says:** "this exists, and you may not touch it." Honest, and the correct literal meaning.

**404 says:** "there is nothing here." It hides *existence*, which stops an attacker enumerating
valid IDs by probing and reading the difference between 403 and 404. GitHub does this — a private
repo you cannot see returns 404, not 403.

**For this endpoint, 403 is right** — and the reasoning is the point, not the code. Events are
**public**: there is a public `GET /api/events` and a public `GET /api/events/:id`. The ID's existence
is already known to everyone. Hiding it on the PATCH buys nothing and costs clarity.

**But the answer flips for other resources in this same project.** `GET /api/orders/:id` and
`/api/holds/:id` are private — someone else's order ID should not be confirmable by probing. Those
should 404.

So the rule is: **return 404 when existence itself is confidential; 403 when it is already public.**
Deciding per-resource rather than picking one globally is the senior answer.

### The tension you did not name

Why does the ownership check go in the service rather than a guard, when the role check goes in a
guard?

Because **a guard runs before the handler and has no resource loaded.** A role check only needs the
token, which the guard already has — free. An ownership check needs the *event row*. To do it in a
guard you would have to query the event inside the guard, and then the service queries it again:
**two round trips for one operation.** You could stash the entity on `request` to avoid that, but now
the guard knows what the service needs and they are coupled through a mutable request object.

Hence the clean rule:

> **Role checks belong in guards — they need only the token.
> Ownership checks belong in the service — they need the resource.**

The alternative is defensible and worth knowing: a dedicated `EventOwnerGuard` that loads the event
and attaches it, paying one extra query to get declarative, auditable, greppable protection
(`@UseGuards(EventOwnerGuard)` is visible at the route; a check buried in a service method is not).
Large teams often prefer that for exactly the auditability reason. We are using the service approach.

### One habit to carry into M3

Prefer `UPDATE … WHERE id = :id AND organiser_id = :userId` over load-then-compare-then-update. For
ownership it barely matters — ownership does not change under you — but it is the same shape as the
atomic conditional UPDATE that M3 is built on, and the habit is worth forming early.

And: **never trust an `organiserId` in the request body.** It comes from the token, always.

---

## Q6 — NextAuth session strategies

> **Your answer:** we will use jwt because if we store session in db we have to lookup in db for
> every req due to which the response will take more time

**Grade: partially correct.** Right conclusion. The performance reasoning is real but it is not the
forcing reason, and the "what do we lose" half is unanswered.

### Where the state physically lives

- **`jwt` strategy** — the entire session lives in an **encrypted cookie** in the user's browser (a
  JWE, encrypted with `NEXTAUTH_SECRET`). Nothing is stored server-side. Reading a session means
  decrypting a cookie.
- **`database` strategy** — the cookie holds only an opaque session ID; the real session row lives in
  your database through an **Adapter**. Every session read is a lookup.

### The actual forcing reason

**The Credentials provider does not support the `database` strategy at all.** NextAuth only supports
`jwt` sessions with Credentials. It is not a preference we are optimising — it is the only option
available.

The reason is structural: with an OAuth provider, NextAuth owns user creation and can link a session
row to an adapter-managed user record. With Credentials, NextAuth does not manage users at all — ours
live in Postgres behind NestJS — so there is no adapter-managed user for a session row to point at.

Your performance argument is a real consideration in general; here it is moot.

### What we lose

**Server-side session revocation.** With database sessions, "log this user out everywhere" is a
`DELETE`. With `jwt` sessions the cookie is self-contained and valid until it expires; you cannot
invalidate it from the server without building your own denylist.

Which is **exactly the Q1 problem, one layer up.** Notice what we now have: two independent stateless
credentials with the same staleness property — NextAuth's session cookie, and our backend's access
token. Revoking a user's access properly means dealing with both. That is worth being able to state
out loud, because it is the kind of thing an interviewer draws out of you rather than asks directly.

Also lost: any "your active sessions" listing, and you are constrained by the ~4 KB cookie limit for
anything you stash in the session.

---

## Q7 — The two callbacks

> **Your answer:** don't know

Central to the M1 frontend, so worth having precisely.

### `jwt({ token, user, account, trigger })`

Runs **whenever the JWT is created or updated**, on the **server only**:

- at sign-in, with `user` and `account` populated (the only time they are);
- on every subsequent session read, when the cookie is decoded and re-encoded.

**Its return value is what gets encrypted into the cookie.** This is *storage*.

### `session({ session, token })`

Runs whenever the session is **read** — `useSession()`, `getSession()`, `auth()`. It receives the
decoded token and returns the object your application sees.

**Its return value is what the client gets.** This is a *view*.

### Why they are separate — and why it is load-bearing for us

Because you frequently want to **store something you do not want to expose.**

That is not hypothetical here; it is precisely our design. The refresh token must be persisted so the
`jwt` callback can use it — and must **never** reach the browser (`TR-DEC-018`):

```ts
async jwt({ token, user }) {
  if (user) {
    token.accessToken = user.accessToken;
    token.refreshToken = user.refreshToken;   // stored, encrypted in the cookie
  }
  return token;
}

async session({ session, token }) {
  session.accessToken = token.accessToken;    // exposed to the browser
  // refreshToken deliberately NOT copied — it stays server-side
  return session;
}
```

One object is what you keep; the other is what you show. Collapsing them into one function would make
that distinction impossible to express.

### If you only touched `session`

`session` has no source of data other than `token`. If `jwt` never put the access token on the token,
there is nothing for `session` to read — so `session.accessToken` is `undefined`, always.

The failure is nastily misleading: **sign-in appears to succeed.** The user is redirected, the UI
shows them as logged in, `useSession()` returns a session object. Then every API call goes out with
no `Authorization` header and comes back 401 — so it looks like a backend problem, or a token
expiry problem, or a CORS problem. It is none of those.

---

## Q8 — `NEXTAUTH_SECRET`

> **Your answer:** don't know

**What it does:** it encrypts and signs **NextAuth's own session cookie** (a JWE, AES-256-GCM, with
the key derived via HKDF). It also protects NextAuth's built-in CSRF token and any email
verification tokens.

**What it is not:** the secret your NestJS backend uses to sign its access tokens. Those are two
different secrets belonging to two different systems, and conflating them is a common error.

```
NEXTAUTH_SECRET   → encrypts the NextAuth session cookie          (Next.js owns this)
JWT_ACCESS_SECRET → signs the access token NestJS issues          (NestJS owns this)
```

**If it changes while users are logged in:** every existing session cookie becomes undecryptable, so
everyone is silently logged out. An availability problem rather than a security one — but rotate it
deliberately, not by accident during a deploy.

**If it leaks:** an attacker can **forge a session cookie for any user** — mint a token claiming
`sub: <victim>`, encrypt it with the secret, and NextAuth accepts it. No password needed. It is as
sensitive as a signing key.

**A nice consequence of the two-secret split, worth noticing:** a forged NextAuth cookie would log
the attacker into the Next.js UI, but it would not contain a *valid backend access token* — because
minting one of those requires `JWT_ACCESS_SECRET`, which lives only in NestJS. So every actual API
call would 401. Leaking `NEXTAUTH_SECRET` alone gets you a convincing but hollow session. That is
real defence in depth, and it exists because the two systems do not share a secret.

---

## Q9 — The parallel-refresh race

> **Your answer:** don't know

This is the one that would have bitten us in production, so it shapes the implementation.

### What happens to the user

Five server components read the session at once. The access token has just expired, so refresh logic
in the `jwt` callback fires in each:

1. All five read refresh token **N** from the session and `POST /auth/refresh`.
2. One wins. The backend validates N, marks it used, issues **N+1**.
3. The other four arrive with **N**, which is now marked used.
4. **Reuse detection fires.** The entire token family is revoked.
5. The user is hard-logged-out mid-page-load, and your logs record a suspected token theft that never
   happened.

Worse, it is intermittent — it only triggers when several components read the session in the narrow
window after expiry — so it presents as "users randomly get logged out sometimes."

### Why P1's fix does not transfer

P1 used a module-level in-flight promise in its axios interceptor:

```ts
let refreshPromise: Promise<boolean> | null = null;
```

That worked because everything ran in **one browser tab, in one JavaScript module instance**, sharing
one heap. Every caller saw the same variable.

The `jwt` callback runs **on the server**, and that breaks the assumption three ways:

1. Multiple server components in a single render can each trigger it.
2. In a serverless or multi-instance deployment, concurrent requests may execute in **different
   processes** — separate heaps, so a module-level promise dedupes within a process but not across
   them.
3. You do not control when NextAuth invokes the callback; it is driven by session reads you did not
   write.

So the deduplication has to live somewhere shared, or the problem has to be solved elsewhere entirely.

### The fix we are using

**The grace window from Q2** — and this is why it is the right choice rather than merely *a* choice:
one mechanism solves both problems.

For 30 seconds after a rotation, the backend accepts the previous refresh token and **returns the
same new pair** rather than rotating again. All five callers get a valid response. Nobody trips reuse
detection. The refresh becomes idempotent within the window.

Other options, for completeness:

| Option | Verdict |
|---|---|
| Module-level promise | Helps the single-instance case, free, incomplete. Worth adding on top. |
| **Redis lock keyed on the token family** | Correct across instances, and we *will* have Redis from M4. Heavier. The right answer at scale. |
| Stop rotating refresh tokens | Solves it by removing the security property. No. |
| Refresh only in one route handler | Narrows the call sites, does not remove concurrency. |

`TR-DEC-017` records the grace window.

---

## Q10 — The Credentials provider

> **Your answer:** don't know

**The warning is about password ownership.** NextAuth's authors discourage Credentials because using
it means *you* are storing and verifying passwords — and their view is that most teams get that wrong:
weak hashing, no rate limiting, no reset flow, no MFA, no breach detection. NextAuth's whole pitch is
delegating identity to a provider that has already solved those. Credentials opts out of the pitch.

There is a technical limitation bundled in too: Credentials **cannot use the database session
strategy** (Q6) and cannot participate in account linking.

**Does it apply to us? Partly, and the distinction matters.**

The "you will get password handling wrong" concern is aimed at people implementing password checks
*inside* NextAuth's `authorize()` callback, in a Next.js app with no other backend. **That is not us.**
Password verification happens in NestJS, which already has a hashing service, DTO validation, and a
users table. Our `authorize()` is a thin client that POSTs to `/api/auth/login` and returns what came
back. **NextAuth never sees a password hash.**

The session-strategy limitation does apply, and we accepted it in Q6.

The deeper point that genuinely applies: **we are using about 20% of NextAuth.** It is not doing
identity for us — it is managing an encrypted session cookie, giving us `useSession()`, and providing
somewhere sensible to put refresh logic. Worth being clear-eyed about, because an interviewer may
well ask why NextAuth is there at all.

The honest framing: *"Auth is owned by a separate NestJS API, so NextAuth is doing session management
rather than identity. The Credentials provider is a thin adapter over our own login endpoint. If we'd
wanted Google sign-in it would be earning a lot more of its keep."*

---

## Verdict

**Backend M1 — ready. Proceeding.**

The two questions that gate backend correctness, Q1 and Q5, were both answered correctly, including
the layering of authentication, authorisation and ownership that the implementation depends on. Q2's
misconception is about a distributed-systems edge case, not about the design — and the resolution
(`TR-DEC-017`) is now decided and explained.

**Frontend NextAuth — not ready to write from memory, and that is fine.**

Six unknowns, all NextAuth. But NextAuth is *configuration*, not algorithm: a wrong answer produces a
login that visibly does not work, not a silent vulnerability. The two places where it could produce a
real security problem — exposing the refresh token, and the refresh race — are both now decided
(`TR-DEC-017`, `TR-DEC-018`) rather than left to be discovered.

**Sequence:** backend and DB first, as always. Then `frontend/docs/concepts/01-nextauth.md` written
before the frontend code, and the walkthrough after it.

### Decisions produced by this round

| ID | Decision |
|---|---|
| `TR-DEC-016` | **bcrypt (cost 12), no pepper** — supersedes the Argon2id decision. Your call; tradeoff recorded. |
| `TR-DEC-017` | **30-second refresh grace window** — one mechanism resolving both Q2 and Q9. |
| `TR-DEC-018` | **The refresh token is never exposed to client JS** — stored in the `jwt` callback, never copied into `session`. |

### Re-read before an interview

- **Q3** in full. The XSS-versus-CSRF trade is the most commonly asked auth question at this level,
  and "the best answer is neither — refresh in an httpOnly cookie, access token in memory" is what
  separates a memorised answer from an argued one.
- **Q4's tension** — hashing unknown users to prevent enumeration makes the DoS worse, and rate
  limiting is the layer that actually resolves it.
- **Q1's correction** — a denylist does not "destroy" JWTs; it gives up the distributed-system
  benefit specifically.
