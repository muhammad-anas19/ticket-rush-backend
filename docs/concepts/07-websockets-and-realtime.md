# WebSockets and real-time — from the handshake to the two-instance problem

**Standalone concept doc.** No TicketRush code yet — [walkthroughs/m7-websockets-code-walkthrough.md](../walkthroughs/m7-websockets-code-walkthrough.md)
(once M7 ships) will show exactly where each idea below lives. This doc exists because the M7 gate
came back with solid instincts on the basics and real gaps on the part this module is actually FOR —
the two-instance problem and the Redis adapter. Q4/Q5 are the ones to have completely solid before an
interview; they're literally Q150 in the bank, described there as "the money question."

---

## 1. The handshake — what you got right, and the piece that was missing

Your answer: *"browser sends http req to server with an additional header which says connection
upgrade to websocket, backend upgrades it to a bidirectional socket, now as soon as any changes are
made in backend, frontend gets notified at the same time."*

The first half is exactly right. Let's make it precise, then fix the second half, which has a real
misconception worth correcting cleanly.

### The exact header exchange

```
Browser → Server:
  GET /socket.io/ HTTP/1.1
  Host: yourserver.com
  Upgrade: websocket
  Connection: Upgrade
  Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
  Sec-WebSocket-Version: 13

Server → Browser:
  HTTP/1.1 101 Switching Protocols
  Upgrade: websocket
  Connection: Upgrade
  Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

`Sec-WebSocket-Key` is a random value the browser generates. `Sec-WebSocket-Accept` is the server
proving it actually understood the request — it takes that key, appends a fixed magic string
(`258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, hardcoded in the WebSocket spec), SHA-1 hashes it, and
base64-encodes the result. Any client can check this to confirm it's talking to a real WebSocket
server, not something that happened to echo a 101 status without actually implementing the protocol.
The status code itself — **101 Switching Protocols** — is the literal, formal meaning: "you asked for
HTTP, I'm telling you this exact same TCP connection is now going to speak a different protocol from
this point forward." After that response, the raw TCP socket stays open, but nothing on it looks like
HTTP anymore — both sides now exchange WebSocket **frames**, a lightweight binary format with none of
the repeated header overhead an HTTP request/response carries.

### Why start as HTTP at all, instead of a protocol built from scratch

Three concrete reasons, not just "tradition":

1. **Port and infrastructure reuse.** Corporate firewalls, proxies, load balancers, and browsers
   already have well-understood rules for what's allowed on port 80/443 speaking HTTP. A brand-new
   protocol starting cold on some other port would be blocked by exactly the infrastructure that
   already trusts HTTP traffic. Starting as an HTTP request means it sails through the exact same
   path a normal page load would.
2. **Reusing HTTP's own security model.** The upgrade request is a normal HTTP request — it carries
   cookies, an `Origin` header, and (in this project) an `Authorization`-equivalent credential in the
   handshake. The server gets to run its NORMAL request-time checks (is this origin allowed? is this
   token valid?) before ever agreeing to the upgrade, using infrastructure that already exists,
   rather than inventing a parallel authentication scheme for a protocol that hasn't started yet.
3. **Graceful fallback.** If a WebSocket upgrade genuinely can't succeed (an old proxy strips the
   `Upgrade` header, for instance), the exchange just looks like a normal HTTP request that got a
   normal HTTP response — nothing crashes, and a library like Socket.IO can fall back to HTTP
   long-polling instead. A protocol that didn't start as HTTP would have no graceful way to fail.

### The misconception to fix: nothing is "automatic"

*"As soon as any changes are made in backend, frontend gets notified at the same time"* — this
overstates what the upgrade actually buys you. The upgrade removes a CONSTRAINT (see §2), it does
not create automatic reactivity. After the handshake, the connection is a raw, open, bidirectional
pipe — but **nothing travels down that pipe unless your application code explicitly sends it.** If a
hold is created in `HoldsService.create()` and nothing in that method calls `socket.emit(...)` or
`server.to('event:123').emit(...)`, no browser hears about it, upgraded connection or not. The
WebSocket connection is the ROAD; your application code still has to decide when to drive something
down it and to whom. This matters directly for M7: the gateway doesn't magically know inventory
changed — `HoldsService`/`PaymentsService`/the sweeper all have to explicitly call something after
they commit, the same way `CacheService.invalidate()` has to be called explicitly rather than Redis
somehow noticing a row changed.

**One-sentence version:** *the HTTP-to-WebSocket handshake is a normal HTTP request carrying an
`Upgrade` header, answered with `101 Switching Protocols` and a cryptographic proof the server really
understood the request — after that, the same TCP connection carries lightweight frames instead of
HTTP messages, but delivering an update is still something application code has to do explicitly,
not something the open connection does on its own.*

---

## 2. WebSocket vs. polling vs. SSE — the actual tradeoffs, not just "WS wins"

Your answer correctly identified polling's core waste (asking repeatedly, mostly getting "nothing
changed," burning bandwidth and requests) and correctly guessed that polling becomes reasonable again
once the interval is long. Let's fill in the missing piece — SSE — and be precise about when each
is actually the right engineering choice, not just the "modern" one.

### HTTP polling

The browser asks "anything new?" every N seconds, always over a brand-new HTTP request/response.

- **Cost:** every single poll pays full HTTP overhead (headers, a new TCP handshake unless
  keep-alive is reused, TLS negotiation cost if that's cold) for what is usually a "no" answer.
- **Latency:** an update that happens right after a poll waits up to N seconds to be seen — the
  interval IS the worst-case staleness, unavoidably.
- **Where it's still the right choice:** when updates are genuinely infrequent, when "real-time"
  is a nice-to-have rather than a requirement, or — the case your instinct landed on — when the
  acceptable staleness window is large enough that the request overhead barely matters relative to
  how rarely you're paying it. It's also trivially simple: no persistent connection state to manage
  anywhere, works through literally any proxy or cache without special configuration, and scales
  down to zero infrastructure complexity. A dashboard that's fine refreshing every 30 seconds has no
  real reason to reach for WebSockets.

### Server-Sent Events (SSE)

A single, long-lived HTTP connection (`Content-Type: text/event-stream`) that the SERVER keeps open
and writes to whenever it has something to say — no repeated requests, the browser just listens.

- **What it gives you over polling:** push, not pull — the server sends the instant it has an
  update, with none of the wasted "anything new? no." round trips. Built natively into the browser
  (`EventSource`), including **automatic reconnection** if the connection drops — you don't write
  reconnect logic yourself.
- **What it does NOT give you, and why that matters here:** SSE is **one-directional, server to
  client only.** The browser cannot send anything back over that same channel — if the client needs
  to tell the server something (which TicketRush needs constantly: "I'm holding a ticket," "I'm
  releasing one"), that still has to be a normal, separate HTTP request. SSE would work for the
  "push availability updates" half of this module, but not for a client-initiated action, and this
  app already has plenty of those.
- It's also HTTP/1.1-limited in an easy-to-forget way: browsers cap concurrent connections **per
  origin** (historically six for HTTP/1.1), so several SSE streams to the same host can eat into that
  budget in a way a single WebSocket connection doesn't (WebSocket connections aren't counted against
  that same per-origin HTTP limit).

### WebSocket

Full duplex — either side can send at any time, over one connection, with minimal per-message
overhead (no headers repeated per frame the way HTTP repeats them per request).

- **What it gives you over polling:** the same push benefit SSE gives you, PLUS the client can send
  back over the identical connection — "hold a ticket" and "here's your new availability count" both
  travel the same pipe.
- **What it gives you over SSE specifically:** bidirectionality. For an app where the client needs to
  both *receive* live updates and *send* real actions, SSE would need to be paired with ordinary HTTP
  requests for the send direction anyway — at which point a single WebSocket connection is simply
  doing the same job with less protocol variety to maintain.
- **The cost, honestly stated:** more moving parts. A WebSocket connection is *stateful* — the server
  has to hold an object in memory representing each open connection, for as long as it's open, which
  is a genuinely different operational model than a REST API's disconnected request/response pairs
  (this is exactly why Q4's two-instance problem exists at all — a stateless REST API scaled across
  instances doesn't have this failure mode, because there's no long-lived state pinned to one
  process to begin with).

**One-sentence version:** *polling is the simplest and is genuinely correct when staleness of
seconds-to-minutes is fine; SSE gives you server push with zero client-side reconnect logic but is
one-directional; WebSocket gives you full bidirectional push at the cost of the server having to hold
open, stateful, per-connection resources for as long as the app is running.*

---

## 3. Rooms — why not just broadcast everything to everyone

Socket.IO's rooms are a server-side grouping mechanism: `socket.join('event:123')` adds one
connection to a named group; `io.to('event:123').emit(...)` sends only to sockets currently in that
group. Nothing exotic under the hood — Socket.IO just keeps, per room, a set of socket ids, and
"emit to a room" is "look up that set, write the frame to each of those specific sockets."

**Why this project needs it, concretely.** Picture the alternative: every inventory change, for
every event in the whole system, gets emitted to every single connected browser, and each browser's
JavaScript checks "is this the event I'm currently looking at?" and throws the message away if not.

Two real costs, not hypothetical ones:

1. **Wasted work, multiplying badly.** If there are 50 events live and 2,000 people connected across
   all of them, broadcasting without rooms means every one of those 50 events' updates gets sent to
   all 2,000 sockets — most of whom aren't looking at that event at all. That's `events × connections`
   messages sent, when the actual USEFUL work is only `connections that care about this specific
   event`. Rooms make the server do the second, smaller amount of work directly, instead of doing the
   larger amount and relying on every client to discard what it didn't need.
2. **It doesn't scale with the thing that's actually growing.** As the number of *events* grows, a
   no-rooms design means every existing connection's inbound traffic grows too, even though that
   person is still only looking at one page. Rooms keep each connection's traffic proportional to
   what it actually subscribed to, not to how many unrelated things exist in the system.

There's a secondary, smaller argument too: it also keeps the SERVER's own emit call simple and
correct — `io.to('event:123').emit('availability', data)` is one line that can never accidentally
leak to the wrong room, versus manually tracking "which socket ids care about event 123" as an
application-level data structure the room feature already gives you for free.

**One-sentence version:** *without rooms, every update goes to every connection and every client has
to filter out what it doesn't want — rooms make the SERVER do the targeted, small amount of work
directly, so traffic scales with how many people actually care about a given event, not with how
many events exist system-wide.*

---

## 4. The two-instance problem — Q150, the one to know cold

This is worth reading twice. Your instinct ("something about WS running differently across
instances, we can't connect to all WS") is reaching toward the right shape but not quite it — let's
make the actual mechanism precise, because this is the single most commonly asked WebSocket-scaling
question in interviews.

### The setup

Two API instances, A and B, sit behind a load balancer. Both connect to the same Postgres and the
same Redis — that part is normal and fine, and it's exactly the multi-instance setup this whole
project has been designed around since M0. A browser connects; the load balancer sends it to
instance A. A second browser connects a moment later; the load balancer sends IT to instance B —
purely based on load-balancing logic (round robin, least connections, whatever), with no awareness
that both browsers are looking at the same event.

### What actually happens when instance A tries to broadcast

Say the browser on instance A holds a ticket. `HoldsService.create()` runs — **inside process A** —
commits the atomic UPDATE, and then calls something like `server.to('event:123').emit('availability',
{ ticketsRemaining: 4 })`.

Here is the exact thing your answer was reaching for: **Socket.IO's room membership (`io.sockets.
adapter.rooms`) is an in-memory JavaScript data structure that lives inside ONE Node process.**
Process A's copy of that data structure only ever learned about sockets that connected TO PROCESS A
— because process A is the only process that ever ran the code handling those connections' handshakes
and `join()` calls. Process A has genuinely never heard of the browser sitting on process B; there is
no shared list of "everyone in room event:123 across the whole fleet," only "everyone in room
event:123 that happened to land on THIS machine."

So when `server.to('event:123').emit(...)` runs inside process A, it looks up ITS OWN local room
membership, finds the one browser that connected to A, and sends the frame to that one socket. It has
no mechanism to even become aware that process B exists, let alone that process B has a browser
sitting in a room with the identical name. **The browser on instance B sees nothing. Not because of a
bug, not because of a missing config flag — because the information "someone changed event 123's
inventory" never left process A's memory in the first place.**

This is NOT about WebSocket running on a different port, and it's not that "we cannot connect to all
WS" — every individual connection works completely fine; the problem is entirely that **the broadcast
call only reaches sockets the CALLING process personally knows about**, and knowledge of connected
sockets does not cross process boundaries by default.

**One-sentence version:** *each Node process keeps its own in-memory list of which sockets are in
which rooms, so a broadcast issued from one process can only ever reach sockets that connected to
THAT process — the browser on a different instance is invisible to it, not blocked, just genuinely
never told.*

---

## 5. What `@socket.io/redis-adapter` actually changes

You correctly flagged "it's used to scale WS" without yet having the mechanism — here it is,
specifically, because "Redis stores the connections" is the wrong mental model and worth ruling out
explicitly.

**What Redis does NOT do:** it does not become a shared registry of "which socket ids are connected
to which process." Each instance still only knows about its own local sockets, exactly as in §4 —
that part never changes.

**What Redis DOES do:** every instance, once the adapter is installed, additionally **subscribes to a
shared Redis Pub/Sub channel.** When `server.to('event:123').emit(...)` runs on instance A, the
adapter intercepts the call and does two things instead of one:

1. Emits to instance A's own local sockets in that room (unchanged from before).
2. **Publishes a message to Redis** describing the emit — which room, which event name, what payload
   — onto a channel every instance is listening to.

Every OTHER instance (B, and any others) receives that Pub/Sub message, and — this is the key part —
**each instance then does its OWN local emit**, using its OWN local room membership, exactly the way
it would have handled a request that originated locally. Instance B never learns "instance A has a
socket in this room" — it learns "someone, somewhere, wants room event:123 to receive this payload,"
and then checks its own local bookkeeping for who that means on ITS machine.

So: **Redis is the message bus that lets "please broadcast this" cross the process boundary — it is
never the list of who's connected.** This is the exact same Redis primitive `concepts/04-redis.md`
§7 already introduced for the hold-countdown key's future consumer: push-not-poll, one process
telling every other process about an event the instant it happens, with no polling anywhere in the
path. The redis-adapter is that same Pub/Sub mechanism, applied specifically to "re-broadcast this
Socket.IO emit on every instance" instead of "notify a TTL key expired."

**The analogy:** without the adapter, each instance is a radio station broadcasting only to
listeners tuned into ITS tower, with no idea any other tower exists. The Redis adapter doesn't give
one tower a list of every listener on every other tower — it gives every tower a shared newswire: the
moment one tower has an announcement, it wires it to every other tower, and each tower re-broadcasts
it to its own local listeners in its own coverage area.

**Why you need to scale WebSockets at all, stated plainly:** a single Node process can hold a lot of
concurrent connections (see §8), but "a lot" is still finite, and running more than one instance is
the standard way to serve more simultaneous users than one process/machine can. The moment there's
more than one instance, the "one shared list of everyone connected" assumption silently breaks unless
something bridges the instances — which is exactly what §4 demonstrated going wrong, and exactly what
this adapter exists to fix.

**One-sentence version:** *the Redis adapter doesn't centralize connection knowledge — it gives every
instance a shared Pub/Sub channel so an emit issued anywhere gets re-broadcast to every instance's
OWN local sockets, turning N independent local broadcasts back into one logical, fleet-wide one.*

---

## 6. Handshake auth vs. per-message auth

**Why checking once, at connect time, is the normal model.** A REST API is fundamentally
*stateless*: each request is independent, might land on a different server instance than the last
one, and carries nothing the server remembers between calls — so every single request has to prove
who it is, because there's no continuity to lean on. A WebSocket connection is the opposite: once the
handshake succeeds, the server holds a live, continuously-open TCP connection (encrypted, if it's
WSS) with an in-memory object representing "this specific, already-verified user's socket." Nobody
else can inject themselves into an already-established, encrypted connection mid-stream — the
identity of who's on the other end of that specific socket cannot silently change without a whole new
TCP/TLS handshake happening, which would be a NEW connection, re-triggering auth from scratch anyway.
Re-checking identity on every message would be spending CPU re-verifying something that structurally
cannot have changed since the last message on the same connection — there's no new information to
learn.

**The gap this leaves open, and why it's bigger than it first looks.** If the access token
expires, or the session gets revoked, mid-connection — does the open socket find out? The naive
answer, "it'll notice on reconnect," undersells the problem: a socket that never drops never
reconnects, so "it'll notice eventually" can mean *never*, not *within 15 minutes*. Compare this
to REST: every single request re-checks `exp`, so a REST client's exposure is bounded by how
often it happens to call the API, capped at the token's own lifetime. A WebSocket that's simply
never re-asked has **no** such cap — it's not "as stale as REST," it's potentially staler by an
unbounded amount.

**This project closes it — `TR-DEC-031` — with two mechanisms, one per way a session goes bad:**

1. **Ordinary expiry:** the gateway decodes the verified token's `exp` claim at connect time and
   schedules a timer to force-disconnect the socket at that EXACT moment — the same instant a
   REST call presenting that token would start getting 401s. This alone caps a WebSocket's
   exposure at exactly what REST already accepts: the token's own stated lifetime, never longer.
2. **Real revocation** (a user logs out; reuse-detected theft revokes a whole refresh-token
   family): every socket joins a private `user:{id}` room at connect time, and the auth service
   tells the gateway to close that room's sockets THE INSTANT the revocation happens — not up to
   15 minutes later, immediately, propagated over the same Redis Pub/Sub channel the
   cross-instance broadcast (§5) already uses.

Neither mechanism alone would be enough: the timer doesn't help a session that's revoked *before*
its natural expiry, and the revocation push doesn't help a token that simply runs out with no
revocation event to hook into. Together, a WebSocket's trust window is never wider than a REST
client's would be for the identical token.

**One-sentence version:** *WebSocket auth checks identity once because the connection is
continuity a stateless REST request doesn't have — but "checked once" must not mean "trusted
forever": bounding the connection to the token's own expiry, plus pushing real revocation
immediately, keeps a socket's exposure no wider than a REST client's ever is.*

---

## 7. Presence — why "127 people are watching" is genuinely hard

**Why one instance can't honestly answer it.** `io.sockets.adapter.rooms.get('event:123')?.size`
inside a single process only counts sockets THAT PROCESS knows about — exactly §4's problem again,
just read as a count instead of used as a broadcast target. With three instances behind a load
balancer, the true number of people watching event 123 is split across three separate, mutually
unaware in-memory counts, and none of them alone is the right answer.

**What has to change.** The count needs to live somewhere every instance can both update and read —
a shared registry, not a local variable. The natural fit is Redis again, but as a different data
structure than the Pub/Sub channel in §5: a **Set** per event (`SADD presence:event:123
<socketId>` on join, `SREM` on leave/disconnect), with the true count read via `SCARD` from ANY
instance, since they're all reading the same shared Redis key rather than their own local memory.

**The harder part, worth naming even though it's beyond this project's scope right now:**
disconnects aren't always clean. A laptop lid closing, a phone losing signal, a network partition —
none of these politely fire a `disconnect` event before vanishing. Socket.IO's own ping/pong
heartbeat eventually notices (a socket that stops responding to pings times out and gets disconnected
server-side), but there's a lag — a presence count driven purely by join/leave events can run stale
for however long that timeout takes to fire. A fully correct implementation needs either that timeout
tuned short enough to be acceptable, or a TTL-based approach (each connection's presence entry
expires automatically unless refreshed, similar in spirit to the hold countdown key) so a vanished
connection ages out on its own rather than staying counted forever.

**One-sentence version:** *presence is hard because "who's connected" is scattered across every
instance's own memory — the fix is a shared store every instance updates and reads instead of a local
variable, and the remaining hard part is that disconnects aren't always clean, so the count needs a
timeout-based self-correction, not just join/leave bookkeeping.*

---

## 8. Connection limits — what actually runs out first

**The three candidate resources, and which one bites first in practice:**

1. **OS file descriptors.** Every open socket (WebSocket or otherwise) consumes one file descriptor
   under the hood — the OS has a per-process limit (`ulimit -n` on Linux, often defaulting to 1024,
   commonly raised to tens of thousands for a server workload). This is a real, hard ceiling, but
   it's also just a config number — raising it is often trivial, so it's rarely the FIRST thing that
   actually constrains a real deployment.
2. **Memory per connection.** Each open connection costs some memory — kernel-side socket buffers,
   plus whatever Socket.IO/your own app keeps per connection (room membership bookkeeping, any
   per-user state). This adds up at scale, but a single idle connection's footprint is small (tens of
   KB range, not megabytes), so this scales to a genuinely large number of connections before it's
   the binding constraint on typical hardware.
3. **CPU, via the single-threaded event loop — this is the one that actually matters most for a
   Node process specifically.** An IDLE WebSocket connection costs almost nothing in CPU terms — it's
   just a socket sitting in the kernel's buffers waiting for data, and Node's event loop doesn't spend
   cycles on a connection that has nothing happening. But the MOMENT there's real work per connection
   or per message — parsing a payload, running business logic, broadcasting to a room with many
   members — **all of that work runs on the SAME single thread**, regardless of how many CPU cores
   the machine has. Ten thousand idle connections cost you almost nothing; ten thousand connections
   all needing CPU-bound work done on their behalf at the same moment serializes onto that one thread
   and becomes the real ceiling, well before file descriptors or memory typically run out.

**Why this is different from a thread-per-connection server (contrast worth having ready).** A
traditional blocking-IO server (classic Apache's prefork model, or a naive thread-per-connection
design) spins up a full OS thread per connection — each with its own stack, typically megabytes in
size by default, plus real OS scheduling/context-switch overhead as the thread count climbs. THAT
model hits a memory and context-switching wall at a MUCH lower connection count than an event-loop
design, specifically because idle threads still cost real, non-trivial resources just by existing.
Node's (and Nginx's) non-blocking, single-threaded event loop is specifically good at holding large
numbers of MOSTLY-IDLE connections cheaply — which is exactly the shape of a typical WebSocket
workload (long-lived, silent most of the time, occasionally receiving a small message) — which is why
event-loop architectures became the standard choice for this exact use case, and why "how many
connections can Node hold" has a very different, much larger answer than "how many threads can this
machine usefully run."

**One-sentence version:** *idle WebSocket connections are cheap under Node's event loop — file
descriptors and memory scale to large numbers before they bind — but any CPU-bound work per
connection or per message serializes onto the single thread regardless of connection count, which is
the ceiling that actually matters, and it's the opposite failure mode from a thread-per-connection
server, where merely EXISTING costs real memory and scheduling overhead per connection.*

---

## Recap — the one thread running through §4, §5, and §7

All three of the hardest questions in this gate are the same fact, asked three different ways:
**a Node process's in-memory state (room membership, connection counts) is scoped to that process
alone, and does not cross to another instance by any mechanism except one you build.** A broadcast
without the adapter only reaches local sockets (§4). The adapter fixes that specific case by piping
emits through Redis Pub/Sub so every instance re-broadcasts locally (§5). A presence count has the
identical problem in a different shape, and needs the identical fix in a different shape — a shared
Redis Set instead of a shared Pub/Sub channel (§7). Once that pattern is visible, all three questions
collapse into one thing to actually understand, not three unrelated facts to memorize separately.
