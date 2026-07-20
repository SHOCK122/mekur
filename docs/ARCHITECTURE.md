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
password via scrypt (`packages/crypto/src/index.ts:deriveKeyFromPassword`)
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

- All API instances are stateless; session/auth state lives in
  short-lived, signed tokens or Redis, not in-process memory, so instances
  can be added/removed freely behind a load balancer.
- PostgreSQL is the source of truth. The data model is designed so it can
  be partitioned/sharded by user ID later without a schema rewrite (no
  cross-shard joins required for the common read/write paths).
- Background work (notifications, slot-selection computation for large
  events) goes through a queue (Redis-backed), not inline in the request
  path.
- The Docker Compose setup here is for small deployments (self-hosting,
  up to ~hundreds of users). Scaling to very large deployments is a matter
  of horizontal scaling of the same stateless design (e.g. moving to
  Kubernetes, adding read replicas, sharding Postgres) — not a
  re-architecture. This is deferred to a later phase and will get its own
  scale-testing pass before being claimed as production-ready at scale.

## Client design

- The web client is a Progressive Web App (Vite + React), offline-first
  via a service worker and local storage, so it keeps working on flaky or
  slow connections.
- Native iOS/Android clients are planned to start as the same PWA wrapped
  via Capacitor (cheapest path to "installable app" that shares all
  business logic), with a fully bespoke native rewrite only if that proves
  insufficient later.
