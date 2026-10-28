# Architecture

## Goals and threat model

The server should be able to store, relay and (eventually) compute on
scheduling data while learning as little as possible: not event content,
not event times, and not who schedules with whom. A full database dump
should yield ciphertext, token hashes and public keys -- nothing that
connects an account to an event.

What is **not** defended against: a malicious server substituting public
keys (Phase 11: fingerprint verification), traffic analysis by an observer
with full database *and* request-log access, and script injection into
the web page (the keys are in `localStorage`; Phase 11).

## Keys

| Key | Derived from | Held by | Purpose |
|---|---|---|---|
| Auth key | Password (scrypt -> HKDF) | Sent at login; server stores `sha256` of it | Proves the password without revealing it |
| Encryption key | Password (scrypt -> HKDF) | Client only | Encrypts the account's keyring |
| Identity keypair (X25519) | Password (scrypt -> HKDF) | Public: server. Secret: client only | Address that invitations are sealed to |
| Event key | Random, per event | Every holder's keyring | Encrypts that event's content |
| Capability tokens | Random, per grant | Holders' keyrings; server stores hashes | Authorise reading (view) or writing (edit) one event |
| Ephemeral keypair | Random, per invitation | Sender only, then discarded | Seals one invitation without identifying the sender |

All three password-derived values come from **one** scrypt run (cheap on
low-end devices to pay that cost once), split by HKDF with distinct
labels. Deriving the identity keypair rather than generating it means the
private key never needs separate backup; it is re-derived at every login.

## Architecture decision: capability-based access (supersedes the ACL model)

**Status:** adopted (migration 006), replacing the previous design where
the server stored `group_event_participants` rows linking user IDs to
events. Leftovers of the old model were removed in migration 007.

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
inviter writes a blob sealed to the invitee's public key containing the
event id, tokens and key (see "Invitations" below). The server sees that an
account received something, not from whom or about what. Writes must
authenticate as *some valid account* rather than as a specific sender --
authenticating the writer against the recipient would rebuild the graph in
the logs. Abuse is handled by rate limiting, not by identifying senders.
(Inviting needs the recipient's account id, which comes from resolving a
username or a one-time friend code; usernames are therefore not secret.)

**Blocking is client-side.** The server cannot filter on someone's behalf
without knowing who contacts whom. Sender identity travels inside the
encrypted invite; the recipient's client filters. The server never learns
a block list.

**Votes become per-event pseudonyms** (when group scheduling returns --
roadmap Phase 10). A voter is identified by a pseudonym derived from their
capability for that event, not a global user id. The server sees N
pseudonymous voters and cannot link the same person across two events.

**Revocation requires re-keying.** A capability that has been copied
cannot be retracted. Revoking a token stops *new* access; existing holders
keep it until the event is re-keyed and redistributed to remaining
participants. Join codes must therefore be treated as sensitive as
passwords, and the UI should say so.

### Unified event model
Group and personal events collapse into one type. A personal event is one
whose capability has been granted to exactly one person; a shared event
has more. End time is optional (open-ended events). This removes the
"convert a private event into a group event" operation entirely -- sharing
is just granting a capability. Candidate slots and voting will be optional
additions to the same type (Phase 10), not a second type.

### What the server can still infer
Honest accounting of the residual leak: row counts and timestamps
(creation and modification times of events and keyrings), approximate
keyring size, encrypted payload sizes, and traffic patterns. Timing
correlation between two accounts' requests remains possible for an
observer with full database *and* log access. Defeating that needs mixnet
or private-information-retrieval techniques and is out of scope; it is
documented here rather than implied to be solved.

## Invitations (sealed envelopes)

An invitation carries an event's id, a view token and the event key,
sealed to the recipient's identity public key
(`packages/crypto`: `sealToRecipient` / `openSealed`):

1. The sender generates a fresh **ephemeral** X25519 keypair.
2. The content key is HKDF(ECDH(ephemeral, recipient), salt = both public
   keys). The ephemeral public key travels in the clear as `epk`; it is
   linked to no account, so the envelope identifies nobody.
3. For a **named** invite, the sender adds, *inside* the ciphertext, their
   static public key plus an HMAC keyed by ECDH(sender, recipient) over
   `epk` and the payload. Only the real sender (or the recipient) can
   compute it, so the recipient gets a verifiable sender identity and the
   server gets nothing. A proof that doesn't verify makes the whole
   envelope fail to open.
4. For an invite to someone reached by **one-time friend code**, step 3 is
   skipped: the code exists so that no identity is exchanged, in either
   direction.

This replaced an earlier scheme that encrypted with ECDH(sender static,
recipient static). Since the server records no sender, recipients had no
way to know whose public key to use, and only self-addressed invites ever
opened.

**Connections and blocks** live on the recipient's device, keyed by the
sender's verified public key. The display name in an invite is
self-described; a saved connection's name takes precedence. The server
never learns a block list.

**Friend codes** are single-use: resolving one replaces it in place, and
nothing records who used whose code (migration 007 removed a
`consumed_by` column that did).

## Group scheduling (planned -- roadmap Phase 10)

Not currently built. The design carried over from the ACL era, adapted to
capabilities:

1. Candidate time slots live inside the encrypted event content, keyed by
   opaque slot ids. The server stores only the ids.
2. Each holder ranks slot ids under a per-event pseudonym derived from
   their capability, so the server sees `(pseudonym, slot_id, rank)` and
   nothing else -- no times, no titles, no account ids.
3. The server resolves with a pluggable aggregation rule (default: lowest
   rank sum, Borda-style; alternative: minimise the worst individual rank)
   and returns a slot id that every client can already map to a time.

Terminology note: this is preference aggregation (a voting rule), not
stable matching -- Gale-Shapley solves two-sided matching, a different
problem.

## Scaling

- **Stateless API, verified.** Auth is a JWT or an API-key hash lookup; no
  session store or in-process caches. Two instances against one database
  interoperate (tokens and data). Concurrent startup is safe: migrations
  take a Postgres advisory lock (`apps/api/src/db/migrate.ts`).
- **No background queue.** Everything, including push delivery, happens
  inline. Nothing is slow enough to justify one yet.
- **Every list is bounded.** Batch reads take at most 500 capabilities;
  the inbox returns the newest 200.
- **Behind a proxy**, `TRUST_PROXY` must be set (docker-compose sets it to
  1), or every request appears to come from nginx and all users share a
  single rate-limit bucket.

**Measured** with `apps/api/scripts/loadtest.ts` (dependency-free; see the
file for why autocannon was dropped): one API instance, Postgres and the
load generator on one machine, concurrency 20, rate limits raised. A
rough baseline, not a network-realistic production number.

| Endpoint | Throughput | p50 | p99 |
|---|---|---|---|
| `GET /health` | ~3,370 req/s | 4.5ms | 16.9ms |
| `POST /events` | ~1,000 req/s | 17.9ms | 48.4ms |
| `POST /events/batch-read`, 100 capabilities | ~430 req/s | 44.9ms | 83.7ms |

Batch read was rewritten from two queries per presented capability to one
query per request. Same machine, same 100-capability batch: **48 req/s,
p50 398ms before; 432 req/s, p50 45ms after** (~9x).

Not yet verified: multi-machine latency, connection-pool exhaustion far
beyond the tested concurrency, multi-region deployment.

The Docker Compose stack targets small self-hosted deployments on one
machine. Scaling further is more instances of the same stateless API
behind a load balancer, then Postgres read replicas -- not a
re-architecture.

## Offline behaviour

What exists today:

1. **App shell** -- precached by the service worker; the app loads with no
   network.
2. **Event data, read-only** -- the last synced, decrypted event list is
   cached in `localStorage`. If loading fails, the cached copy is shown
   with an offline notice.

What does **not** exist: offline *edits*. An earlier version of this
document described a mutation queue (`mutationQueue.ts`, `sync.ts`); that
code was lost in a sandbox reset and never rebuilt. Rebuilding it is
roadmap Phase 9, to this design:

- Queue creates/updates/deletes while offline; collapse before replay
  (repeated edits become one write, a delete supersedes earlier edits, a
  create+delete pair vanishes).
- On replay, compare the `updatedAt` last seen with the server's. If it
  moved, another device changed the event: surface the conflict rather
  than overwrite it. Last-write-wins is less code but silently destroys
  the other change.
- Not a CRDT: an event has one logical writer at a time, so there is no
  concurrent multi-writer merge to perform.

Note that the offline cache holds **decrypted** content. Encrypting it
would add nothing while the encryption key sits beside it in the same
storage; that is fixed together with key storage in Phase 11.

## Client

- A Progressive Web App (Vite + React), structured as: `lib/` for
  network, crypto and pure logic (timeline geometry, recurrence,
  fractional ranks); `hooks/useEvents` for loading and mutations;
  components that only decide what to show.
- The timeline is the only view. Every event action -- edit, repeat,
  skip/restore an occurrence, share, delete, or remove a view-only event
  from your own schedule -- is reachable from the event's edit panel.
- Native iOS/Android would start as the same PWA in Capacitor, with a
  native rewrite only if real usage shows it's needed.

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
