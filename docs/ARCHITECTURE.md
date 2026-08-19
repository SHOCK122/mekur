# Architecture

## Encryption model

The server is designed to hold as little sensitive information as possible,
while still being able to do the computational work needed for group
scheduling at scale.

### Single-user data (phase 1)

A user's own events are stored as an `EncryptedEnvelope`
(`packages/shared/src/index.ts`): the server sees only an opaque ciphertext
blob, a nonce, and a `keyId`. It never sees titles, times, locations, or
descriptions. The key used is derived client-side from the user's
password via scrypt (`packages/crypto/src/index.ts:deriveAuthAndEncryptionKeys`)
and never transmitted to the server.

### Group scheduling (phase 2+)

Group scheduling needs the server to do *some* computation — matching
people's availability — which is fundamentally incompatible with the
server being fully blind to everything. The design below minimizes what
the server learns to the smallest set of facts needed to run that
computation:

1. An organizer creates an event and proposes a set of candidate time
   slots. Client-side, they generate an opaque `slot_id` for each slot
   (e.g. `slot_1`, `slot_2`, ...) and encrypt the mapping from
   `slot_id -> { startTime, endTime }` (plus the event title/description)
   into the event's `EncryptedEnvelope`.
2. When inviting a participant, the organizer's client wraps the
   information the invitee needs (the slot mapping, event content) to the
   invitee's public key — the same hybrid-encryption pattern used by E2E
   messengers to add a member to a group chat. The server relays this
   wrapped payload but cannot open it.
3. Each invited participant's client decrypts the slot mapping locally (so
   they can see real dates/times), and submits a ranking of `slot_id`s
   back to the server as a plain `(user_id, slot_id, rank)` tuple. This is
   the **only** information about the event that reaches the server as
   plaintext: an opaque event ID, opaque user IDs, opaque slot IDs, and a
   rank number. No date/time, no title, no description.
4. The server runs a selection algorithm over these tuples (see below) and
   returns the winning `slot_id`. Every client already knows what that
   `slot_id` corresponds to from step 2, so they can display the real
   date/time locally — the server never has to know it.

This means the server can do the heavy lifting (which matters at scale —
it means resolving a group event doesn't depend on any one participant's
device being online and powerful enough to compute a match), while never
learning what the event is actually about or when it actually happens.

**What the server *can* infer** despite all this: which opaque user IDs
are being invited to the same opaque event ID, and how many slots were
proposed. Full metadata-hiding (e.g. hiding the social graph of who's
scheduling with whom) is a stronger property that would require anonymous
credentials or mixnet-style routing — out of scope for now, documented
here as a known, accepted limitation rather than something quietly
overlooked.

### Slot selection algorithm

Note on terminology: classic "stable matching" (Gale-Shapley) solves a
two-sided matching problem (e.g. applicants to jobs, where both sides rank
each other). Choosing one time slot that best satisfies a group's
individual rankings is a different, simpler problem: a **preference
aggregation / voting rule**. The implementation will be a pluggable
strategy (a single function of type `(votes) -> winning slot_id`) so the
rule can be swapped without touching the encryption model. Planned default
for phase 2: minimize the sum of ranks (Borda-count style), with a
documented alternative (minimize the worst individual rank, for fairness)
available as a config option.

## Key management summary

| Key | Derived from | Held by | Purpose |
|---|---|---|---|
| Master symmetric key | User's password (scrypt) | Client only | Encrypts the user's own single-user event data |
| X25519 key pair | Generated on account creation | Public key: server + other users. Private key: client only | Wrapping per-event keys to invitees |
| Per-event symmetric key | Generated per event by the organizer | Wrapped to each invitee's public key | Encrypts event content + slot mapping |

## Scaling strategy

- **Statelessness: verified, not just claimed.** All API instances are
  stateless -- auth is JWT or API-key verification against Postgres, no
  server-side session store, no in-process caches or singletons (audited
  directly; see `docs/ROADMAP.md`'s Phase 3 bughunt). Proven concretely:
  two independently-started API instances pointed at the same fresh
  database both boot cleanly, a JWT issued by one is accepted by the
  other, and data written via one is immediately visible via the other.
  This also surfaced and fixed a real bug: two instances starting
  *simultaneously* against a fresh database used to race on migration
  bookkeeping and crash (see `apps/api/src/db/migrate.ts`'s advisory
  lock).
- PostgreSQL is the source of truth. The data model is designed so it can
  be partitioned/sharded by user ID later without a schema rewrite (no
  cross-shard joins required for the common read/write paths).
- **Background work is currently synchronous, not queued.** There is no
  Redis or job queue yet, despite earlier drafts of this document
  assuming one -- corrected here. Every request does its own work
  inline (including the slot-selection computation on resolve, and push
  notification delivery). This is fine at today's scale; a queue is a
  real Phase 3+ item if large-group-event resolution or notification
  fan-out ever becomes slow enough to matter, not before.
- **Real load-test numbers** (measured with `apps/api/scripts/loadtest.ts`
  -- a minimal, dependency-free load generator; see that file for why
  autocannon was tried and dropped), single API instance, single
  Postgres instance, both on the same machine as the load generator
  (so treat these as a rough baseline, not a network-realistic
  production number):

  | Endpoint | Throughput | p50 latency | p99 latency |
  |---|---|---|---|
  | `GET /health` | ~1,300 req/s | 12.0ms | 60.5ms |
  | `POST /events` (write) | ~465 req/s | 37.0ms | 127.5ms |
  | `GET /events` (read) | ~212 req/s | 93.7ms | 173.5ms |

  These numbers already reflect one real fix the load test caught:
  `GET /events` initially measured ~34 req/s with 625ms average latency,
  because the query had no `LIMIT` -- response cost grew unbounded with
  how many events a user had ever created. Adding a bound (200 most
  recent) brought it to the numbers above, a ~7x improvement. A user
  with more than 200 events only sees their most recent 200 until real
  pagination is built -- a known, documented gap, not a silent one.

- The Docker Compose setup here is for small deployments (self-hosting,
  up to ~hundreds of users) on a single machine. Scaling further is
  horizontal scaling of the same stateless design (multiple API
  containers behind a load balancer, Postgres read replicas, eventually
  sharding) -- not a re-architecture, and the statelessness claim above
  is now actually verified rather than assumed. What's *not* yet
  verified: behavior under real multi-machine network latency, Postgres
  connection-pool exhaustion under much higher concurrency than tested
  here, and true multi-region deployment. Those remain open for a later
  scale-testing pass before claiming production-readiness at very large
  scale.

## Implementation status (Phase 2)

The group-scheduling design above is implemented as described: a
per-event symmetric key wrapped via X25519 ECDH to each participant
(organizer included, self-wrapped), server only ever seeing opaque slot
IDs and rank numbers. See `docs/ROADMAP.md`'s Phase 2 section for the
full list of what shipped and the simplifications made along the way
(vote-replace semantics, no dedicated notifications system -- derived
from vote status instead, API key minting not yet restricted to
human-only auth).

## Architecture decision: capability-based access (supersedes the ACL model)

**Status:** adopted, replacing the previous design where the server stored
`group_event_participants` rows linking user IDs to events.

### The problem with the previous model
Event *content* was encrypted, but the **social graph was not**. The server
could see who shared an event with whom, when, and how often. For the
motivating case -- a source handing a journalist a code to arrange a
meeting -- a breach would not reveal what the meeting was, but would
reveal that those two accounts met. That defeats the point.

### The model
Events are standalone rows with no owner column and no participant table.
Access is by capability:

- `event_id` + **view token** -> may read the row
- `event_id` + **edit token** -> may modify it

The server stores no user->event association whatsoever. A database breach
yields encrypted blobs and capability token *hashes*, with nothing
connecting them to accounts.

### Consequences (all necessary, not optional)

**Users need an encrypted keyring.** With no server-side association,
`GET /events` is unanswerable -- the server cannot know which events are
yours. The client holds `(eventId, viewToken, editToken, eventKey)` per
event, synced as a single opaque encrypted blob per account. The server
learns only the approximate *size* of that blob, i.e. roughly how many
events an account has. That is the one leak accepted by design.

*Risk:* the keyring is a single point of failure. Lose it and the events
remain on the server, intact and permanently unreachable, because nothing
else records that access existed. Mitigated by versioning and append-safe
writes, not eliminated.

**Invites need an inbox.** Granting a capability means delivering it. The
inviter writes a blob encrypted to the invitee's public key containing the
event id and tokens. The server sees that an account received something,
not from whom or about what. Writes must authenticate as *some valid
account* rather than as a specific sender -- authenticating the writer
against the recipient would rebuild the graph in the logs. Abuse is
handled by rate limiting and requiring a valid friend code, not by
identifying senders.

**Blocking is client-side.** The server cannot filter on someone's behalf
without knowing who contacts whom. Sender identity travels inside the
encrypted invite; the recipient's client filters. The server never learns
a block list.

**Votes become per-event pseudonyms.** Group scheduling no longer needs
global user IDs -- a voter is identified by a pseudonym derived from their
capability for that event. The server sees N pseudonymous voters, and
cannot link the same person across two events. Strictly better than the
previous design.

**Revocation requires re-keying.** A capability that has been copied
cannot be retracted. Revoking a token stops *new* access; existing holders
keep it until the event is re-keyed and redistributed to remaining
participants. Join codes must therefore be treated as sensitive as
passwords, and the UI should say so.

### Unified event model
Group and personal events collapse into one type. A personal event is one
whose capability has been granted to exactly one person; a shared event
has more. Candidate slots and voting are optional fields present only when
scheduling is wanted. Start and end times are both optional. This removes
the "convert a private event into a group event" operation entirely --
sharing is just granting a capability.

### What the server can still infer
Honest accounting of the residual leak: row counts and timestamps
(creation and modification times of events and keyrings), approximate
keyring size, encrypted payload sizes, and traffic patterns. Timing
correlation between two accounts' requests remains possible for an
observer with full database *and* log access. Defeating that needs mixnet
or private-information-retrieval techniques and is out of scope; it is
documented here rather than implied to be solved.

## Future: advertising (separate project, constraints recorded here)

Not built, and intended to live in its own project talking to this one
through a narrow interface. Recorded here because the requirements collide
with the capability model, and the collision is far cheaper to resolve on
paper than in a schema.

### The collision
Two requirements reintroduce what the capability model exists to remove:
"users earn revenue from ads they receive" implies counting impressions per
user, and "save a user's brand associations" implies a server-side
user->preference link. Both are the server knowing things about
identifiable people.

### Constraints any implementation must satisfy
1. **No server-side user->content association.** The server cannot read
   schedules -- that property must not be weakened to enable targeting.
2. **Matching happens client-side.** The server publishes an ad catalogue;
   the client, which holds the only decrypted copy of the schedule, matches
   locally. This falls out of the existing design rather than being bolted
   on.
3. **Attribution via anonymous tokens, not user records.** See below.
4. **Opt-out by default**, with the second tier a separate, explicit opt-in.

### Attribution: why single-use blind tokens over stable per-user tokens
A tempting simplification is one stable token per (user, ad), counting
requests from it. It does produce the two aggregates needed -- per-ad
totals to bill advertisers, per-user totals to pay users -- without any
per-impression user record.

It is nonetheless weaker than it appears, and the weakness is the one that
matters. A stable token is a **long-term pseudonym**. Requests carry IP
addresses, timing and TLS fingerprints, so two tokens used in one session
can be correlated and the profile reassembled. And deanonymisation is
retroactive: identify the person behind a token once and every past and
future request under it becomes theirs. This is close to how third-party
cookies worked, which the industry has spent a decade moving away from.

**Preferred: single-use blind-signed tokens** (Privacy Pass; used by Brave
Ads, alongside Apple's Private Click Measurement and Google's Attribution
Reporting API, which add aggregation and noise). The client receives a
batch of blind-signed tokens; at redemption the server verifies
authenticity but **cannot link a token to its issuance**. The same two
aggregates fall out, and unlinkability survives correlation. Cost is one
additional crypto primitive with mature libraries available.

The stable-token scheme is recorded as an acceptable fallback if
simplicity ever has to win, with its limitation understood rather than
forgotten.

### Tier two, and a tension worth naming
Higher-value targeting works precisely because those users are more
identifiable. The privacy guarantee therefore stands against a real and
persistent economic incentive to erode it, and whoever operates the server
will always have a reason to weaken it a little further.

That makes it worth deciding deliberately whether anonymity is
**architecturally enforced** (the server *cannot* deanonymise) or **policy**
(the server *promises* not to). Only the former survives a change of
ownership, an acquisition, or a subpoena. Tier-two associations should
therefore be stored under a user-controlled, resettable pseudonym that the
server cannot join to an account -- not under a user id with an access rule
in front of it.

### Why a separate project
Keeping this out of the scheduling codebase protects the core privacy
property from being gradually compromised by commercial requirements, and
keeps this project's threat model small enough to reason about. The
interface should stay narrow: a read-only ad catalogue out, anonymous
redemption tokens in.

## Offline editing and sync

The web client is offline-capable in three layers:

1. **App shell** -- precached by the service worker, so the app loads with
   no network at all.
2. **Event data** -- the last synced, decrypted event list is cached
   locally, so the calendar is readable offline.
3. **Edits** -- creates and deletes made offline are recorded in a
   mutation queue (`apps/web/src/lib/mutationQueue.ts`) and replayed on
   reconnect (`apps/web/src/lib/sync.ts`).

**Why not a CRDT.** An earlier plan called for Yjs. CRDTs solve concurrent
editing of a *shared* document by multiple simultaneous writers; personal
events here have exactly one writer, so there's no multi-writer merge to
perform. The real problem is a single user's offline changes replaying
later, possibly against an account that was also edited on another
device -- a mutation queue with conflict detection, not a CRDT. Yjs would
have added a large dependency and forced a restructuring of the encrypted
data model to solve a problem this app doesn't have.

**Conflict policy.** On replay, an update compares the `updatedAt` the
client last saw against what the server currently reports. If they differ,
another device changed that event while this one was offline, and the
offline edit is **not** applied over it -- the conflict is surfaced in the
UI showing both versions. Last-write-wins would be simpler but would
silently destroy the other device's change. Similarly, an update to an
event that was deleted elsewhere is reported as a conflict rather than
silently resurrecting it, and deleting an already-deleted event is treated
as success (the desired end state already holds).

Queued mutations are collapsed before replay: repeated edits to one event
become a single write, a delete supersedes earlier edits to that event,
and an event created *and* deleted while offline is dropped entirely
(the server never knew it existed).

## Client design

- The web client is a Progressive Web App (Vite + React), offline-first
  via a service worker and local storage, so it keeps working on flaky or
  slow connections.
- Native iOS/Android clients are planned to start as the same PWA wrapped
  via Capacitor (cheapest path to "installable app" that shares all
  business logic), with a fully bespoke native rewrite only if that proves
  insufficient later.
