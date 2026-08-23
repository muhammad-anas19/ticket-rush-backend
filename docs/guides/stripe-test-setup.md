# Setting up a Stripe test account and sandbox for TicketRush

A practical setup guide, not a concept doc — see
[concepts/05-stripe-payments-and-webhooks.md](../concepts/05-stripe-payments-and-webhooks.md) for
*why* each of these pieces exists. This is *how*, on this machine, for this project.

Everything here is **test mode**. No business verification, no bank account, no real card, no real
money, at any point. `env.validation.ts` refuses to boot with anything but a `sk_test_…` key, so a
live key literally cannot reach this codebase even by accident.

---

## 1. Create a Stripe account

1. Go to [stripe.com](https://stripe.com) and sign up (email + password is enough to start).
2. You land in the Dashboard **already in test mode** — there's a toggle labeled "Test mode" near
   the top of the dashboard (Stripe has moved this control around across redesigns; look for a
   switch or a "Test mode" badge). **Confirm it's ON before doing anything else.** Every key, every
   Checkout Session, every webhook event you create while it's on is test-mode-only and cannot touch
   real money regardless of what you do with it.
3. You do NOT need to add business details, a bank account, or complete any verification to use test
   mode fully — that's only required before you could ever go live, which this project never does.

---

## 2. Get your API keys

1. Dashboard → **Developers** → **API keys**.
2. You'll see two keys:
   - **Publishable key** (`pk_test_…`) — safe to expose to a browser. This project's backend
     doesn't need it (Checkout Sessions are created server-side with the secret key alone), but
     you'd need it if a later module ever adds Stripe.js/Elements directly in the frontend.
   - **Secret key** (`sk_test_…`) — server-side only, never sent to a browser, never committed to
     git. This is `STRIPE_SECRET_KEY`.
3. Copy the secret key into `backend/.env`:
   ```
   STRIPE_SECRET_KEY=sk_test_...your real key...
   ```
   Replacing the placeholder that's there by default (`sk_test_REPLACE_WITH_YOUR_OWN_TEST_KEY`) —
   the placeholder is shape-valid so the app *boots*, but every real Stripe API call (creating a
   Checkout Session) will fail with an authentication error until this is a real key.

---

## 3. Install the Stripe CLI

The CLI is what makes testing **webhooks** possible without deploying anything publicly reachable —
see `concepts/05-…md` §8 for why a webhook specifically needs this and a plain API key doesn't.

**Windows:**
```powershell
# via winget (built into modern Windows)
winget install stripe.stripe-cli

# or via Scoop, if you already use it
scoop install stripe
```
(Or download the binary directly from
[github.com/stripe/stripe-cli/releases](https://github.com/stripe/stripe-cli/releases) and put it on
your PATH, if neither package manager is set up.)

Verify it installed:
```bash
stripe --version
```

---

## 4. Log the CLI into your account

```bash
stripe login
```

This opens your browser, asks you to confirm a pairing code, and links the CLI to your Stripe
account (test mode). You only need to do this once per machine — the CLI remembers the pairing.

---

## 5. Start forwarding webhooks to your local server

With the backend running (`npm run start:dev`, port 3001):

```bash
stripe listen --forward-to localhost:3001/api/webhooks/stripe
```

This prints something like:

```
> Ready! Your webhook signing secret is whsec_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX (^C to quit)
```

**Copy that `whsec_…` value into `backend/.env`:**
```
STRIPE_WEBHOOK_SECRET=whsec_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

**The gotcha worth knowing before it confuses you later:** this secret is generated **fresh every
time you start `stripe listen`** in local development. If you stop and restart the CLI, you get a
DIFFERENT `whsec_…` value, and your `.env` will have the stale one — every webhook will then fail
signature verification with a perfectly correct-looking setup, because the secret genuinely changed
out from under you. Keep `stripe listen` running in its own terminal for the whole session, and
re-copy the secret (then restart the backend to pick up the new `.env` value) any time you restart
it. A real, deployed webhook endpoint (production) gets ONE fixed secret from the Dashboard instead —
this rotating-secret behavior is specific to the local CLI tunnel.

Leave this terminal running for everything below — it's your tunnel.

---

## 6. Run the real end-to-end flow

With `stripe listen` running and the backend restarted (to pick up the real `STRIPE_WEBHOOK_SECRET`):

1. **Create an event and a hold**, either via Swagger (`http://localhost:3001/docs`) or the frontend.
   You'll need a hold id (`POST /events/:eventId/holds` as an authenticated user).
2. **Start checkout:**
   ```
   POST /api/holds/{holdId}/checkout
   ```
   The response has a `checkoutUrl`. Open it in a real browser.
3. **Pay with a test card:**

   | Number | Behavior |
   |---|---|
   | `4242 4242 4242 4242` | Succeeds — the one to use for the happy path |
   | `4000 0000 0000 0002` | Card declined |
   | `4000 0025 0000 3155` | Requires authentication (3D Secure) — tests the extra-step flow |

   Any future expiry date, any 3-digit CVC, any postal code — Stripe's test cards don't validate
   these beyond basic shape.
4. **Watch three things happen, in order:**
   - The `stripe listen` terminal logs the event being forwarded
     (`checkout.session.completed [evt_...] -> localhost:3001/api/webhooks/stripe [200]`).
   - The backend's own logs show the fulfilment: `Order <id> paid — hold <id> converted`.
   - `GET /api/orders/{orderId}` now returns `"status": "paid"`.

If step 4's log line doesn't appear, check the backend's console for a 400 on the webhook route
first — the most common cause at this point is a stale `whsec_…` from restarting `stripe listen`
without updating `.env` (see the gotcha above).

---

## 7. Prove the dedupe mechanism for real

This is `docs/phases.md`'s M5 checkpoint: *"a resent event is a no-op, with the log line to prove
it."*

1. Find the event id from either the `stripe listen` terminal output or:
   ```bash
   stripe events list --limit 5
   ```
2. Resend it:
   ```bash
   stripe events resend evt_...your event id...
   ```
3. Watch the backend logs. You should see:
   ```
   Duplicate webhook evt_... ignored — already processed
   ```
   and nothing else — no second fulfilment, `tickets_committed` unchanged, the order's status
   untouched. This is `TR-DEC-008`'s guarantee, proven against your own real Stripe account rather
   than only the automated test suite (`payments.fulfilment.spec.ts`, which proves the same thing
   with a synthetic event and no live account needed).

---

## 8. Confirm signature tampering is actually rejected

The automated suite doesn't hit the live HTTP route (it calls the service directly), so this is
worth doing once by hand against the real server:

```bash
curl -i -X POST http://localhost:3001/api/webhooks/stripe \
  -H "Content-Type: application/json" \
  -H "stripe-signature: t=1,v1=deliberately-wrong" \
  -d '{"id":"evt_fake","type":"checkout.session.completed"}'
```

Expect `400` with a message naming signature verification failure. If this ever returns 200, stop
and re-check the webhook route immediately — that would mean anyone on the internet could fabricate
a paid order.

---

## 9. When you're done for the session

- `Ctrl+C` the `stripe listen` terminal — it doesn't need to run when you're not actively testing
  webhooks, and each restart rotates the signing secret (see §5).
- The placeholder values in `.env` are safe to leave in place between sessions; nothing breaks by
  having a stale `whsec_…` sitting there, since nothing will exercise the webhook route until
  `stripe listen` is running again anyway.
- Test-mode data (customers, sessions, events) accumulates in your Stripe Dashboard indefinitely
  under the test-mode view. Stripe does not charge for this and there's no need to clean it up.
