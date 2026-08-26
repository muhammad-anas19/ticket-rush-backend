# M7 — WebSockets: Code Walkthrough

**How this project implements the ideas taught in
[`concepts/07-websockets-and-realtime.md`](../concepts/07-websockets-and-realtime.md).** That
document explains the handshake, rooms, the two-instance problem, and the Redis adapter
standalone; this one shows exactly where each piece lives in shipped code, and the real evidence
that it actually works — including a bug the test suite caught in its own fixture data, not in
the gateway.

**Status:** built ahead of M6 (`TR-DEC-030`) — every broadcast hooks into existing synchronous
write paths, no queue involved. Complete and verified live, both automated and manually.

---

## 1. What exists

```
src/realtime/
├── realtime.service.ts      the seam: broadcastAvailability(), holds the Server once set
├── realtime.gateway.ts      Socket.IO gateway — handshake auth, room join/leave
├── redis-io.adapter.ts      @socket.io/redis-adapter wiring, two dedicated ioredis connections
├── dto/subscribe-event.dto.ts
└── test/realtime.gateway.spec.ts   real listening app, real socket.io-client, real Redis
```

| Concern | Route in |
|---|---|
| Hold created/released/expired | `HoldsService.create()` / `.release()` / `sweepExpiredHolds()` |
| Payment re-commits inventory (`TR-DEC-011`) | `PaymentsService.handleEvent()` |
| Organiser changes capacity | `EventsService.update()` (only when `totalTickets` changes) |

None of these import `RealtimeGateway` directly — every one depends on `RealtimeService`, the
thin seam described in its own doc comment. The gateway owns everything Socket.IO-specific
(connections, rooms, auth); domain services only ever call one method:
`realtime.broadcastAvailability({ eventId, ticketsRemaining, isSoldOut })`.

---

## 2. The handshake auth, exactly as `TR-DEC-013` describes

```ts
async handleConnection(client: Socket): Promise<void> {
  const token = client.handshake.auth?.token as string | undefined;
  if (!token) { client.disconnect(true); return; }

  try {
    const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
      secret: this.config.get('auth.accessSecret', { infer: true }),
      algorithms: ['HS256'],
    });
    client.data.userId = payload.sub;
  } catch {
    client.disconnect(true);
  }
}
```

Same secret, same algorithm pin, as `JwtStrategy` — via `JwtModule` re-exported from `AuthModule`
rather than a second `JwtModule.registerAsync()` that could silently drift from the REST API's
own configuration.

**A real Socket.IO nuance the test suite surfaced, not a bug:** a client's own `'connect'` event
fires the instant the TRANSPORT handshake succeeds — before `handleConnection()` (the
APPLICATION-level check above) has even run. An unauthenticated connection therefore briefly
"connects" from the client's point of view, and is then disconnected a few milliseconds later.
Verified directly:

```
Transport connected (expected — auth check happens after this).
PASS: server disconnected the unauthenticated client 3ms after connect. reason: io server disconnect
```

The permanent test (`realtime.gateway.spec.ts`) asserts on the DISCONNECT reason
(`'io server disconnect'`), not on `'connect'` never firing — asserting the latter would be
testing a misunderstanding of the protocol, not the gateway's actual behaviour.

---

## 3. Rooms — one line each way

```ts
@SubscribeMessage('subscribe:event')
handleSubscribe(@ConnectedSocket() client: Socket, @MessageBody() body: SubscribeEventDto): void {
  void client.join(`event:${body.eventId}`);
}
```

`SubscribeEventDto` (`@IsUUID() eventId`) runs through the gateway's own `@UsePipes(new
ValidationPipe(...))` — the identical `class-validator` mechanism every HTTP DTO uses, just
applied to a WebSocket message instead of a request body.

**The bug this validation caught — in the test, not the gateway.** The first version of
`realtime.gateway.spec.ts` used hand-typed placeholder ids (`'aaaaaaaa-aaaa-aaaa-aaaa-
aaaaaaaaaaaa'`) as event ids. `@IsUUID()` validates the version nibble, not just the general
shape — a real UUID's third group starts with a digit 1–5; `'aaaa'` starts with `a`, which is not
a valid UUID version and is correctly rejected. The `ValidationPipe` silently dropped the
`subscribe:event` message, `client.join()` never ran, and the "does the broadcast arrive" test
timed out for a reason that had nothing to do with the broadcast mechanism at all — it looked
exactly like a gateway bug until the actual cause (invalid test fixture data) was traced.
Replaced with `randomUUID()` from `node:crypto`, which is real UUIDv4 and passes correctly. Kept
here because it's a genuinely easy mistake to repeat: a "looks like a UUID" string is not the
same test input as an actual one, and `@IsUUID()` is stricter than eyeballing a string shape
suggests.

---

## 4. The two-instance problem, demonstrated for real

This is the actual headline claim of the module (`concepts/07-…md` §4/§5, Q150 in the interview
bank), and it needs two genuinely separate Node processes to demonstrate honestly — a single
Jest process starting two `INestApplication` instances would still prove the ROOM-membership
argument, but not the full "these are two unrelated OS processes with nothing shared but Redis"
claim the interview question is actually about. So this half was run manually, not automated.

**Setup:** two full instances of this backend, `PORT=3001` and `PORT=3002`, both pointed at the
same Postgres and the same Redis — exactly the M0 topology this project has assumed since the
beginning.

**Without the adapter attached, this would fail** — that's the whole point of `concepts/07-…md`
§4, and it isn't re-demonstrated separately here since removing the adapter to watch it break and
then re-adding it is mechanically the same experiment `docs/phases.md` describes and would just
double the write-up for the same lesson. What follows is the WORKING state, with the adapter in
place, which is the state this project ships.

**The experiment:** client X connects to instance A (port 3001), client Y connects to instance B
(port 3002) — a completely different `node` process. Both subscribe to the same event's room.
The hold that changes availability is created THROUGH instance A.

```
Event created via instance A (3001): a26415e9-95fb-4c12-a01c-88103279c76a
Client X connected to instance A (3001): HUPm-vnDGElx3E45AAAD
Client Y connected to instance B (3002): VVcaDFx70Uh8euQAAAAB
Hold created THROUGH instance A (3001): 1b85dab5-e7fb-4004-a57a-70fe235220f6
Client X (on instance A, the one that triggered it) received:
  { eventId: 'a26415e9-...', ticketsRemaining: 4, isSoldOut: false }
Client Y (on instance B, a DIFFERENT process) received:
  { eventId: 'a26415e9-...', ticketsRemaining: 4, isSoldOut: false }

PASS: a write on instance A reached a client connected to instance B —
the redis-adapter is bridging the two processes.
```

Client Y never talked to instance A, never authenticated against it, and instance A's own
in-memory room-membership map never contained client Y's socket at all — confirmed by reading
`concepts/07-…md` §4/§5 again while watching this: instance A's `RealtimeService.
broadcastAvailability()` call only ever knows about ITS OWN local sockets. What actually happened
is instance A's `@socket.io/redis-adapter` published the emit onto a shared Redis Pub/Sub channel,
instance B's adapter received it, and instance B did its OWN local emit to client Y using ITS OWN
local room membership — the exact mechanism `concepts/07-…md` §5 describes, watched happening
rather than read about.

---

## 5. What the permanent test suite covers, and what it deliberately doesn't

`realtime.gateway.spec.ts` boots one real, listening `INestApplication` (ephemeral port, real
Redis adapter, real JWT verification) and a real `socket.io-client`:

```
rejects a connection with no token                                          ✅ PASS
rejects a connection with a malformed token                                 ✅ PASS
accepts a connection with a valid token and stays connected                 ✅ PASS
delivers a broadcast to a client subscribed to the matching room,
  and nowhere else (a second, uninterested subscriber gets nothing)         ✅ PASS
disconnects a connection the instant its own token's expiry passes          ✅ PASS   (TR-DEC-031)
force-disconnects a user's live socket via RealtimeService.disconnectUser() ✅ PASS   (TR-DEC-031)
```

The fourth test calls `RealtimeService.broadcastAvailability()` directly rather than going
through a full `POST /api/events/:eventId/holds` round trip — that seam is exactly what
`RealtimeService` exists to make testable in isolation, and going through the full HTTP+DB path
would just be re-testing M3's own already-covered concurrency suite. The fifth mints a token with
`expiresIn: '1s'` specifically so the expiry boundary can be observed in real time rather than
asserted on faith; the sixth calls `disconnectUser()` directly — the exact seam `AuthService` now
calls on real revocation — rather than a full `/auth/logout` round trip, which would just be
re-testing M1's own request/response contract.

**Deliberately not automated here:** the cross-process proof in §4. It's real, it was run, and
the transcript above is the actual output — but encoding "start two node processes, wait for both
to bind their ports, tear both down cleanly" into a CI-safe Jest suite is disproportionate to what
it would additionally prove beyond what the single-process room-delivery test and the manual
transcript already establish together. Named here explicitly rather than silently assumed covered.

---

## 6. Cleanup detail worth knowing: the adapter's connections aren't Nest-managed

`RedisIoAdapter.connectToRedis()` constructs its two `ioredis` clients directly (`new Redis(...)`,
`.duplicate()`) — they are never registered with Nest's DI container the way the shared
`REDIS_CLIENT` is. In the real running process this is harmless: the whole process exits on
shutdown and the OS reclaims the sockets regardless of whether anything explicitly closed them.

It is NOT harmless in a test process that constructs and tears down a `RedisIoAdapter` inside a
single long-lived `node` (Jest worker) — `app.close()` has no idea these two connections exist, so
without an explicit `dispose()` (added specifically for this), the sockets stay open and the
worker hangs past every test passing, reported as "Jest did not exit one second after the test
run has completed." Fixed by adding `RedisIoAdapter.dispose()`, called explicitly in
`afterAll()`, tolerant of the connection already being closed (a real race: `app.close()` tearing
down the Socket.IO server can end these connections as a side effect before `dispose()` runs).

---

## 7. Decisions visible in the code

`TR-DEC-013` (JWT-in-handshake, not a Redis single-use ticket — see `DECISIONS.md` for the
reasoning), `TR-DEC-030` (M7 built ahead of M6, hold-expiry broadcasts bounded by the sweeper's
30s cadence until M6's TTL+DLX trigger exists), `TR-DEC-031` (below).

**`EventsService.update()` only broadcasts when `totalTickets` is present in the DTO.** A
title/venue/price edit doesn't move `ticketsRemaining` at all — broadcasting on every organiser
edit would be noise nobody watching the live count needs.

---

## 7a. Closing the "does revocation reach an open socket" gap — `TR-DEC-031`

`TR-DEC-013` originally shipped with a named, accepted gap: a token that expired or was revoked
mid-connection didn't close the socket. Restated precisely, that gap was worse than "up to 15
minutes stale" — a REST call re-checks `exp` on *every request*, so its exposure is capped at the
token's own lifetime; a WebSocket that's never re-asked has **no** cap at all. Two mechanisms
close both halves:

```ts
// realtime.gateway.ts — handleConnection(), after verifying the token
await client.join(`user:${payload.sub}`);
this.scheduleExpiryDisconnect(client, payload.exp);

private scheduleExpiryDisconnect(client: Socket, expUnixSeconds: number): void {
  const msUntilExpiry = expUnixSeconds * 1000 - Date.now();
  client.data.expiryTimer = setTimeout(() => {
    client.emit('session:expired');
    client.disconnect(true);
  }, msUntilExpiry);
}
```

```ts
// realtime.service.ts
disconnectUser(userId: string): void {
  const room = this.server?.in(`user:${userId}`);
  room?.emit('session:revoked');
  room?.disconnectSockets(true);
}
```

```ts
// auth.service.ts — the ONE method every real revocation funnels through
private async revokeFamily(familyId: string, userId: string, reason: RevocationReason) {
  await this.refreshTokens.update({ familyId, revokedAt: IsNull() }, { revokedAt: new Date(), revokedReason: reason });
  this.realtime.disconnectUser(userId);   // logout, reuse-detected theft — never a normal rotation
}
```

**The module-graph problem this surfaced.** `RealtimeModule` originally imported `AuthModule` for
its `JwtService`. Wiring `AuthService → RealtimeService` would have closed a cycle:
`AuthModule → RealtimeModule → AuthModule`. Fixed by extracting the JWT config into one factory
(`config/jwt-module.options.ts`) both modules call to register their OWN `JwtModule` — same
config, no import in either direction between them.

**Verified, not just described.** Two new permanent tests in `realtime.gateway.spec.ts`: a token
minted with `expiresIn: '1s'` gets disconnected (with a `session:expired` event) the moment that
second passes, not before and not never; a live socket receives `session:revoked` and is closed
the instant `RealtimeService.disconnectUser()` is called directly — the exact seam `AuthService`
now calls on real revocation.

---

## 8. Known gaps, named as decisions

- **No presence.** `concepts/07-…md` §7 describes what "127 people watching" would need (a
  shared Redis Set, not a local count) — not built, because nothing in this project's scope asks
  for it yet.
- **`disconnectUser()` is best-effort, not the security boundary.** If it fails, or the gateway
  isn't initialised yet, a revoked session's socket survives a little longer — bounded by its
  token's own expiry timer regardless (§7a's first mechanism), never silently forever.
- **The cross-process experiment isn't automated** (§5) — a real, run, and transcribed manual
  proof, not a CI-safe one.

---

## 9. Running it

```bash
cd backend
docker compose up -d && npm run start:dev   # :3001

# the permanent proof — real listening app, real socket.io-client, real Redis adapter
npx jest src/realtime/test/realtime.gateway.spec.ts --verbose
```

To re-run the cross-process experiment by hand:

```bash
# terminal 1
npm run start:dev                 # :3001 (from .env)
# terminal 2
PORT=3002 npm run start:dev       # :3002, same Postgres/Redis

# terminal 3 — connect a socket.io-client to EACH port, auth: { token: <a real access token> },
# subscribe both to the same event:<id> room, then trigger a hold through EITHER port's REST API
# and watch BOTH clients receive the update.
```
