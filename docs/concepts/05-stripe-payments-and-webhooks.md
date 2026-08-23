# Stripe, payments, and webhooks — from zero to interview-ready

**Standalone concept doc.** No TicketRush code yet — [walkthroughs/m5-stripe-code-walkthrough.md](../walkthroughs/m5-stripe-code-walkthrough.md)
shows exactly where each idea below lives in shipped code. This doc assumes you have never touched
Stripe, so it starts from what a payment even *is* on the internet and builds up to the exact
mechanisms an interviewer will ask about.

Every section ends with the one-sentence version worth having ready in an interview.

---

## 0. The shape of the problem, before any Stripe API at all

A ticket costs money. Somewhere, a browser needs to collect a card number, someone needs to charge
that card, and your server needs to find out whether the charge worked so it can hand over a ticket.

The naive design: your frontend collects the card number, sends it to your backend, your backend
calls a payment processor. **This is illegal and dangerous the instant real customers use it**, for
a reason that has nothing to do with Stripe specifically — it's the reason Stripe (and every
processor) exists in its particular shape. Card numbers are the single most valuable thing to steal
on the internet, and the instant your server touches a raw card number, YOUR server becomes a target
worth breaking into, and you become liable for protecting it to a standard (PCI-DSS) that is
expensive, audited, and unforgiving. Section 5 goes into this properly; for now, just accept the
consequence: **the card number must never reach your backend at all.**

So the actual shape is: the browser talks to Stripe *directly* (via a hosted page or an embedded
widget Stripe controls), Stripe handles the card, and your server finds out the result **without
ever seeing the card**. Everything in this document is really answering one question: *how does your
server find out what happened, safely, given that it was deliberately kept out of the loop for the
one dangerous part?*

---

## 1. Checkout, and why webhooks beat trusting the browser

**Stripe Checkout** is a hosted payment page: your server tells Stripe "here's what's being bought,
here's the price, here's where to send the browser afterward," Stripe returns a URL, you redirect the
browser there, the customer enters card details on a page *Stripe* serves (never yours), and Stripe
redirects back to a `success_url` or `cancel_url` you provided.

**The tempting naive design:** when the browser lands on your `success_url`, have that page call your
API and say "I paid, please give me my ticket."

**Why that's untrustworthy — concretely, not abstractly.** That success page is just a URL. Nothing
stops someone from:
- Navigating to it directly, with no payment ever happening (`https://yoursite.com/checkout/success?orderId=123` typed by hand).
- The browser crashing, losing power, or the user closing the tab *after* Stripe successfully charges
  the card but *before* the success page's JavaScript finishes running and calls your API. The money
  moved; your server never heard about it.
- A flaky connection dropping that one API call silently.

In every one of these, **the actual truth of whether money changed hands lives entirely on Stripe's
servers**, and the success page is just a hint, not a report. Trusting it means either handing out
tickets for payments that never happened, or losing legitimately-paid orders to a dropped request —
and you cannot tell which failure you're having, because the browser-side signal is unreliable in
both directions.

**What a webhook is, and why it fixes this.** A webhook is Stripe's server calling *your* server
directly — no browser involved, no user action required, no tab that can be closed. The instant
Stripe's own systems finish processing a payment, they make an HTTP POST straight to a URL you
configured (`POST /api/webhooks/stripe`), carrying the real outcome. This is server-to-server: the
only way it doesn't happen is if Stripe itself never processed the event, and Stripe **retries**
automatically if your endpoint doesn't acknowledge it (more on this in §4). The webhook is not "a
faster way to find out" — it is the *only* channel your server can actually trust, because it's the
only one that isn't routed through a browser tab that might not exist anymore by the time it matters.

**The analogy:** the success page is like a customer texting you "I think I paid" from the
storefront. A webhook is the bank calling you directly to say "the payment cleared." You'd never run
a real store on the customer's text message alone — not because customers lie, but because the text
might never get sent, sent twice, or sent by someone who never actually paid.

**One-sentence version:** *the client's success callback is unreliable because control of it belongs
to a browser tab that can vanish, be skipped, or be visited without ever paying — a webhook is
Stripe's own server telling yours directly, which is the only channel actually anchored to whether
money moved.*

---

## 2. Signature verification — proving a webhook is really from Stripe

Your webhook endpoint is a public URL. Anyone on the internet can POST to it. If your handler reads
the JSON body and acts on `type: "checkout.session.completed"` without checking anything else,
**anyone who knows or guesses your endpoint can fabricate a fake "payment succeeded" event and get a
free ticket** — just by sending a POST with the right shape.

**The mechanism.** Stripe signs every webhook payload with an **HMAC** (a keyed cryptographic hash)
using a secret only you and Stripe know (`STRIPE_WEBHOOK_SECRET`, unique per endpoint). The signature
travels in a `Stripe-Signature` header, alongside a timestamp:

```
Stripe-Signature: t=1614556800,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
```

Your server computes the SAME HMAC independently, over the timestamp and the raw request body,
using its own copy of the secret — then compares. If they match, only someone who possesses the
shared secret could have produced that signature, and the only two parties who have it are you and
Stripe. `stripe.webhooks.constructEvent(rawBody, signature, secret)` does exactly this — compute,
compare, and either return the parsed event (match) or throw (no match).

**The attack without it, made concrete.** Without verification, an attacker sends:

```
POST /api/webhooks/stripe
{ "type": "checkout.session.completed", "data": { "object": { "metadata": { "orderId": "<any order id>" } } } }
```

and your handler — which only checks `event.type` and `event.data.object` — marks that order paid
and issues a ticket. No card was charged. No money moved. The attacker paid nothing and got the
product. This is not a hypothetical: it is the single most common real-world Stripe integration bug,
and it is Q157 in the interview bank for exactly that reason.

**Why the timestamp matters too, briefly.** `constructEvent` also rejects a signature whose
timestamp is too old (a configurable tolerance, 5 minutes by default) — this defends against a
**replay attack**: someone who genuinely intercepted a real, validly-signed webhook at some point
(e.g., from an insecure network) trying to resend the exact same bytes later. The signature alone
being valid isn't enough if it could be replayed indefinitely; the timestamp bounds how long a
captured signature stays useful.

**One-sentence version:** *without signature verification, "verify a webhook came from Stripe"
degrades to "trust any POST request," and the attack is trivial — fabricate the JSON your handler
expects and get whatever action that event type triggers, for free.*

---

## 3. The raw body requirement — the detail that breaks people's first attempt

This is the single most common *implementation* mistake (as opposed to conceptual mistake) in a
Stripe integration, and it's worth understanding exactly why, not just following the fix as a ritual.

**The HMAC in §2 is computed over the EXACT BYTES Stripe sent** — not "the JSON payload" as an
abstract idea, the literal sequence of bytes that left Stripe's servers, whitespace and all.

Every other route in a typical Express/NestJS app runs through a JSON body-parsing middleware early
in the request pipeline: it reads the raw bytes, calls `JSON.parse()`, and hands your route handler a
parsed JavaScript object. **That parsing is lossy for this purpose.** `JSON.parse` followed by
`JSON.stringify` does not reliably reproduce the original bytes — key order can differ, whitespace is
normalized away, and numeric/unicode formatting can shift. If your webhook route goes through the
normal body parser, by the time your handler tries to verify the signature, the *original* bytes are
already gone — only a re-serialized approximation remains, and that approximation almost never
hashes to the same HMAC as the original.

**The failure mode this produces is maximally confusing.** Every signature check fails — including
on completely legitimate webhooks Stripe is genuinely sending. Your code looks correct. Stripe's
dashboard shows the event was delivered with a 200 response expected. The bug isn't in your
verification logic at all; it's that the bytes being verified were never the bytes Stripe signed in
the first place.

**The fix:** this one route must receive the **raw, unparsed request body** (as a `Buffer`) instead
of — or alongside — the normally-parsed JSON. Frameworks differ in mechanism (Express's
`express.raw()` middleware scoped to just this path is the classic approach; NestJS has a built-in
`rawBody: true` bootstrap option that preserves the raw bytes as `request.rawBody` *alongside* normal
parsing, so you don't need a separate middleware at all). Either way, the raw bytes must survive
intact from Stripe's request all the way to `constructEvent()`.

**The analogy:** verifying a signature is like checking a wax seal on a letter. If someone
transcribes the letter's contents into a fresh document before handing it to you, the words might be
identical, but the seal — which was pressed onto the ORIGINAL paper — no longer matches anything.
You need the original letter, not a faithful copy of what it said.

**One-sentence version:** *the signature is computed over the literal bytes Stripe sent, and
JSON-parsing-then-reserializing does not reliably reproduce those bytes — so this one route needs the
raw body preserved, or every legitimate webhook fails verification for a reason that looks nothing
like the actual cause.*

---

## 4. Idempotency — Stripe sends the same webhook more than once, on purpose

**Why duplicates happen at all, mechanically.** Stripe expects your endpoint to respond within a few
seconds with a 2xx status. If it doesn't get one — your server was slow, crashed mid-request, the
network dropped the response on its way back, or your handler threw an error — Stripe **retries**,
on a backoff schedule, for up to several days. This is deliberate and correct behavior on Stripe's
part: a timeout doesn't tell Stripe whether your server actually processed the event before dying, so
retrying is the only safe assumption. Stripe also occasionally just delivers an event twice even
without an apparent failure. **At-least-once delivery is the norm for any real webhook/queue system**
— the same principle M6's RabbitMQ consumers will be built around.

**What goes wrong in a naive handler.** Say your handler does: "check if I've seen this event id
before (a `SELECT`); if not, do the fulfilment (mark the order paid, issue a ticket)." Two ways this
breaks:

1. **Under concurrency:** two deliveries of the same event arrive close together (a real retry racing
   a slow original, or two instances behind a load balancer). Both run the `SELECT`, both see "not
   seen yet" (the first hasn't committed its INSERT yet), both proceed to fulfil — **the seat gets
   sold twice.** This is structurally the exact same race M3 exists to close for concurrent holds:
   read-then-write is a race regardless of what's being decided.

2. **Under a crash:** your handler marks the event as seen (inserts its id) as step one, THEN does
   the fulfilment as step two. If the process dies between those two steps, the event is recorded as
   "seen" but the fulfilment never happened. Stripe's retry — which would otherwise have completed
   it — is now rejected as a duplicate, because your own bookkeeping says it was already handled. The
   order is stuck `pending` forever: **money was taken, and nothing was ever fulfilled, with no error
   anywhere pointing at why.** This is exactly what the build spec's suggested ordering does wrong,
   and it's `TR-DEC-008`'s whole point.

**This project's actual fix.** A dedicated table, `processed_events`, whose only column is the
Stripe event id **as the primary key** — so the database itself enforces "process this once," not an
`if` statement two concurrent requests could both pass. Critically: **the insert into this table and
the fulfilment writes happen inside ONE transaction.** They commit together or roll back together.
A unique-constraint conflict on that insert can therefore only mean one thing: a *committed*
fulfilment already exists for this event, never a half-finished one — because there is no way for the
insert to have committed without the fulfilment also having committed alongside it.

**Idempotency is not a table. It is a table plus a transaction boundary.** That sentence is worth
having ready verbatim — it's the difference between the build spec's broken two-step version and the
correct one-transaction version, and it's Q158 in the interview bank almost word for word ("you
return 200, then your database write fails — what have you lost").

**A real implementation detail, found the hard way while building this.** There are two ways to
detect "was this a duplicate": catch an exception when the insert violates the unique constraint, or
use `INSERT ... ON CONFLICT DO NOTHING` and check whether a row actually landed. These are NOT
interchangeable, for a Postgres-specific reason: **an error raised by any statement inside a
transaction poisons the rest of that transaction** — every subsequent statement fails with "current
transaction is aborted" until a `ROLLBACK`, so catching the error and trying to keep going on the
same connection doesn't work without an explicit `SAVEPOINT`. `ON CONFLICT DO NOTHING` sidesteps this
entirely: it never raises, a duplicate simply inserts zero rows, and the transaction continues
normally. This project uses that approach — see the walkthrough for a second, subtler bug this
surfaced (checking the wrong field to detect "zero rows," caught by a test that asserted real
database state rather than trusting a method's return value looked reasonable).

**One-sentence version:** *Stripe's at-least-once delivery means duplicates are expected, not a bug
on Stripe's side — the fix is a unique constraint on the event id enforced by the database, combined
in ONE transaction with the fulfilment it guards, so a conflict can only mean "already committed,"
never "half done."*

---

## 5. PCI scope — why this NestJS server never sees a card number

**PCI-DSS** (Payment Card Industry Data Security Standard) is the compliance regime covering anyone
who stores, processes, or transmits card data. It is expensive, invasive (regular audits, specific
infrastructure requirements, restrictions on logging), and the scope of what it applies to is
determined by one thing: **does your system ever touch the raw card number (the PAN), even in
transit?**

**How Checkout keeps your server out of scope entirely.** The card number is typed into a page
Stripe serves and controls — never a form field your frontend renders, never a request body your
backend parses. Your server only ever sees Stripe's own *references* to the payment (a session id, a
payment intent id) — opaque tokens that are useless to an attacker who doesn't also have your Stripe
API key, and which reveal nothing about the actual card. This is what "tokenization" means in
practice: the dangerous data is replaced, at the earliest possible point (the customer's own
browser), with a token that only Stripe can turn back into a real charge.

**Why this matters beyond "compliance is good."** Compliance is the visible cost; the deeper reason
is that PCI scope determines your *liability* if something goes wrong. If your server never
possesses card data, a breach of your server cannot leak card numbers, full stop — there's nothing
there to steal. If you built the naive design from §0 instead, every log line, every database
backup, every error-tracking service you use becomes a potential leak of exactly the data thieves
want most, and a breach becomes a very different, much worse conversation.

**One-sentence version:** *Checkout/Elements collect card data on a page Stripe controls, so the
literal bytes of a card number never reach this server — which is what keeps this server almost
entirely out of PCI scope, and means a breach here has no card numbers to leak in the first place.*

---

## 6. Out-of-order delivery — a real risk, sized correctly for this project

Stripe does not guarantee webhooks arrive in the order the underlying events happened. A slow retry
of an earlier event can arrive after a later event's first, successful delivery.

**When this actually bites.** Imagine tracking a *mutable* state machine purely from webhook payloads
— a subscription that can be `active`, `past_due`, `canceled`, and so on. If a `subscription.updated`
event saying "canceled" arrives, then a stale retry of an earlier "past_due" event arrives afterward,
naively applying events in arrival order would regress the subscription back to `past_due` — visibly
wrong state, and confusing to debug because both events were individually "valid."

**Two real fixes, in order of robustness:** compare each event's timestamp against the last one
applied and ignore anything older (works if the field being updated changes monotonically); or, more
robustly, treat the webhook as a mere **notification that something changed**, and re-fetch the
authoritative object from Stripe's API before acting — Stripe's own API response is always current,
so this can never regress state no matter what order notifications arrive in.

**Is this a live risk for TicketRush specifically? Mostly no, and it's worth being able to say why
precisely rather than reflexively defending against it.** This project's only webhook of consequence
is `checkout.session.completed` — a one-shot, one-time event for a one-shot purchase. There is no
ongoing state machine being reconstructed purely from a stream of events the way a subscription
requires; each order's fulfilment is triggered once, by one event type, and `TR-DEC-008`'s dedupe
already makes a REPEAT of that same event a no-op regardless of order. Where this genuinely would
matter for TicketRush: if a `charge.refunded` event is ever handled in addition to the checkout
event (not currently built), and it's processed before the `checkout.session.completed` it logically
follows — that ordering assumption would need the same care described above. **Naming this
correctly** — "not a live risk for the one event type I actually handle, but here's exactly the
shape of integration where it would be" — is a stronger interview answer than either ignoring the
question or over-claiming a defense this codebase doesn't actually need yet.

**One-sentence version:** *out-of-order delivery is a real risk for any Stripe integration that
reconstructs mutable state from a stream of events, but a one-shot purchase flow with idempotent
fulfilment mostly sidesteps it — the general fix, when it does apply, is timestamp comparison or
re-fetching the object from Stripe rather than trusting arrival order.*

---

## 7. Return code discipline — what you tell Stripe, and why it's not just a formality

Your webhook handler's response status code is Stripe's **only** signal for whether to retry.

- **2xx** — "handled, don't send this again." Send this when the event was processed successfully,
  including when it was correctly recognized as a harmless duplicate (§4) — a duplicate that dedupe
  correctly ignored is a SUCCESS from Stripe's point of view, not a failure.
- **400** — used here specifically for **signature verification failure**. This says "this request is
  not a legitimate webhook I can even parse," and Stripe does not retry a 400 — retrying wouldn't
  help, since the payload itself (from Stripe's perspective, an already-correctly-signed one) isn't
  the problem; something in transit or in your verification broke, and resending the identical thing
  won't fix that.
- **5xx (or a thrown, uncaught exception)** — "I recognized this as a real webhook, but something on
  MY side failed while handling it" (the database was down, an unexpected exception). Stripe
  interprets any non-2xx as "try again later" and retries on a backoff schedule.

**The concrete mistake to avoid:** catching every exception in the handler and always returning 200
"to keep Stripe happy." Say your fulfilment write throws because the database is briefly down. If you
swallow that and still return 200, Stripe marks the event **delivered successfully** and never tries
again — meaning a payment that genuinely was never fulfilled now has *zero* remaining mechanism to
ever get fulfilled. You have converted a transient, recoverable failure into a permanent, silent one,
purely by being too eager to return a "nice" status code.

**One-sentence version:** *the response code IS the retry signal — swallowing a real failure into a
200 doesn't calm anything down, it permanently cancels Stripe's only mechanism for giving you another
chance.*

---

## 8. Test mode and the sandbox — what's actually different, and what isn't

**Every Stripe account has two parallel modes, toggled by a switch in the dashboard: test and live.**
Test mode is not a separate, lesser API — it is the *identical* API, the identical Checkout flow,
identical webhooks, identical dashboard, running against a completely separate dataset that can never
touch real money. The only externally visible difference is the key prefix: test keys start
`sk_test_`/`pk_test_`, live keys start `sk_live_`/`pk_live_`. **This project's env validation
literally rejects any key that doesn't start `sk_test_`** (`env.validation.ts`) — not a convention
enforced by discipline, a shape the process refuses to boot without.

**Test cards** are specific, publicly-documented card numbers (`4242 4242 4242 4242` is the canonical
"always succeeds" card) that Stripe's test-mode systems recognize and simulate a realistic response
for — a successful charge, a decline, a card requiring extra authentication — without ever touching a
real card network. This is what makes an end-to-end payment test possible without a real bank
account or real money on either side.

**The Stripe CLI** (a real, local binary) is what makes testing WEBHOOKS specifically possible
without deploying anything publicly reachable. `stripe listen --forward-to
localhost:3001/api/webhooks/stripe` opens an authenticated tunnel to your own Stripe account and
forwards real test-mode events to your local server — so a Checkout Session you create locally, paid
with a test card, produces a REAL webhook delivery to your own machine, signed with a REAL (test-mode)
signing secret the CLI prints when it starts. `stripe trigger checkout.session.completed` can
synthesize a specific event type on demand, and `stripe events resend <id>` re-delivers a real past
event — which is exactly how the dedupe mechanism in §4 gets proven to actually work, rather than
just asserted to.

See [guides/stripe-test-setup.md](../guides/stripe-test-setup.md) for the actual account creation and
CLI setup steps.

**One-sentence version:** *test mode is the real API with fake money — same code path, same
webhooks, same signature verification, gated only by a key prefix — and the Stripe CLI is what lets a
webhook (which needs a real, Stripe-initiated HTTP request) be tested against a laptop with no public
URL at all.*

---

## Recap — the one thread running through all eight sections

Every section above is really the same argument, applied to a different part of the flow: **the
client side of this integration (the browser, the success page, the request body as parsed by a
generic middleware) cannot be trusted as a source of truth, because it is either not authoritative
(§1), not verifiably from Stripe (§2, §3), not guaranteed to arrive once (§4), not safe to expose to
in the first place (§5), or not guaranteed to arrive in order (§6).** The pattern that recurs at every
layer is the same one M3 already taught: **a real database constraint enforced inside a transaction
beats an application-level check every time two things might happen concurrently** — `processed_events`'s
unique primary key is exactly `tickets_committed`'s atomic conditional `UPDATE`, wearing a different
domain's clothes.
