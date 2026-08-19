# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An open-source, end-to-end encrypted scheduling app (personal calendar +
group scheduling), self-hostable via Docker. Encryption happens client-side;
the server is designed to hold as little sensitive information as possible
while still doing the computation group scheduling needs. Read
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before touching anything
related to encryption, capabilities, or the data model — it documents *why*
things are shaped the way they are, including several rejected alternatives
(CRDTs, stable ad-attribution tokens, the old ACL model) and known,
deliberately-accepted leaks. [`docs/ROADMAP.md`](docs/ROADMAP.md) has
phase-by-phase status, every simplification made along the way, and bugs
found by each phase's bughunt pass — check it before assuming something is
unbuilt or before re-discovering a constraint that's already recorded there
(e.g. the Timeline's WCAG contrast numbers, stack-density thresholds).

## Commands

Node.js 22+, npm workspaces (`apps/*`, `packages/*`). `packages/shared` and
`packages/crypto` must be built before the apps typecheck or test against
them — `pretest`/`pretypecheck` hooks handle this automatically at the repo
root, but if you're iterating inside a single package after changing a
dependency package, rebuild it first: `npm run build:libs`.

```bash
npm install
npm run test                          # every package, from repo root
npm run typecheck                     # every package
npm run lint                          # every package (--if-present)

# single workspace
npm run test --workspace=@schedule-app/api
npm run test --workspace=@schedule-app/web

# single test file (vitest) — cd into the package first
cd apps/api && npx vitest run test/eventRoutes... # substring match on filename
cd apps/web && npx vitest run test/Timeline.test.tsx

# dev servers
cd apps/api && npm run dev            # Fastify on :3000
cd apps/web && npm run dev            # Vite PWA, proxies /api to :3000

cd apps/api && npm run loadtest       # BASE_URL=http://localhost:3000, see apps/api/scripts/loadtest.ts
```

**API tests require a real local PostgreSQL** (not mocked):

```bash
createdb scheduleapp_test
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/scheduleapp_test npm run test
```

`apps/api/test/testHelpers.ts` (`setupTestApp`/`truncateAll`) builds a real
app against that database and runs migrations; tests raise the rate limit
far above production defaults so a fast-firing suite doesn't trip it.

Web tests run under vitest + jsdom (`apps/web/vite.config.ts`), setup file
at `apps/web/test/setup.ts`, with `apps/web/test/mockServer.ts` mocking the
API layer rather than hitting a real server.

Docker: `cp .env.example .env`, fill in real secrets (the stack refuses to
start with placeholders), then `docker compose up --build`. The api
container isn't published to the host — nginx (`infra/nginx.conf`) serves
the web build and reverse-proxies `/api/*` internally.

## Architecture

**Monorepo, four packages**, dependency order `shared → crypto → {api, web}`:

- `packages/shared` — Zod schemas and inferred types for every wire/domain
  object (`EncryptedEnvelope`, event records, etc.). Both the API and the
  web client validate against these, so a schema change is a single edit
  that both sides pick up.
- `packages/crypto` — all client-side crypto: X25519 keypairs, scrypt
  password KDF, XChaCha20-Poly1305 encrypt/decrypt, ECDH key wrapping
  (`deriveSharedWrapKey`/`wrapKey`/`unwrapKey`). This is the only package
  that should ever touch key material directly.
- `apps/api` — Fastify + PostgreSQL. Layered as
  `routes/ → repositories/ → db/pool`, with `services/notificationService.ts`
  for push. `app.ts` wires everything (`buildApp`); `server.ts` is the thin
  entrypoint that calls it with real config. Auth is a Fastify plugin
  (`plugins/auth.ts`) accepting either a JWT or an API key
  (`lib/apiKey.ts`) via the same `Authorization: Bearer` header.
- `apps/web` — Vite + React PWA. UI in `components/`, all business logic
  (crypto orchestration, HTTP, offline sync, timeline math) in `lib/` —
  components should stay thin. Service worker at `sw.ts` (injectManifest
  strategy, precaches the app shell).

### The capability model (read this before touching events/auth)

The server does **not** store which user owns which event. This
supersedes an earlier ACL-style design (`group_event_participants` rows)
that leaked the social graph even with content encrypted — see
`docs/ARCHITECTURE.md`'s "Architecture decision" section for the full
reasoning. Consequences that shape the code:

- Events are standalone rows (`repositories/eventRepository.ts`,
  `lib/capability.ts`). Access is `event_id` + a **view token** (read) or
  **edit token** (write) — capability tokens, not ownership checks.
- `GET /events` is unanswerable server-side by design. The client holds
  `(eventId, viewToken, editToken, eventKey)` per event in an encrypted
  **keyring**, synced as one opaque blob (`repositories/keyringRepository.ts`,
  `apps/web/src/lib/keyring.ts`). Losing the keyring makes events
  permanently unreachable — nothing else records that access existed.
- Invites travel through an **inbox** (`repositories/inboxRepository.ts`,
  `routes/inboxRoutes.ts`): a blob encrypted to the invitee's public key.
  Writes authenticate as *some* valid account, not as a specific sender —
  authenticating the writer against the recipient would rebuild the social
  graph server-side.
- Group-event votes are per-event pseudonyms, not global user IDs, so the
  server can't link the same voter across two events.
- If you're adding a feature that needs the server to answer "which events
  does this user have," stop and re-read the ARCHITECTURE.md section first
  — that question is unanswerable by design, and working around it usually
  means quietly reintroducing the leak the capability model exists to
  prevent.

### Slot selection is pluggable

Group-event resolution picks a winning slot via a swappable strategy
(`(votes) -> winning slot_id`), not hardcoded — default minimizes summed
rank (Borda-count style), with a worst-rank-minimizing alternative
available. Don't hardcode a specific rule where the strategy function
should be called instead.

### Offline sync (web client)

Three layers: app shell (service worker precache), event data
(`lib/eventCache.ts`), and edits (`lib/mutationQueue.ts` +  `lib/sync.ts`).
Deliberately **not** a CRDT — personal events have exactly one writer, so
there's no concurrent-multi-writer merge to solve, just replay-on-reconnect
with conflict detection. Conflict policy is conservative by design: if the
server's `updatedAt` moved since the client last saw it, the offline edit
is surfaced as a conflict rather than applied (no last-write-wins, which
would silently destroy the other device's change). Queued mutations are
collapsed before replay (repeated edits → one write, delete supersedes
earlier edits, create+delete while offline → dropped entirely).

### Statelessness

The API has no server-side session store, in-process cache, or singleton —
audited and *proven* (two independent instances against one database:
both boot, a JWT from one is accepted by the other, writes via one are
immediately visible via the other), not just asserted. If you add anything
that holds state in the process (a cache, an in-memory map keyed by
user/session), it breaks horizontal scaling and the proof above — think
twice and prefer Postgres.

### Migrations

Plain SQL files in `apps/api/src/db/migrations/`, applied in order by
`db/migrate.ts` under a Postgres advisory lock (added after two instances
starting simultaneously against a fresh database raced on migration
bookkeeping and crashed — see `migrationConcurrency.test.ts`). New
migrations: add a new numbered `.sql` file, don't edit an existing one.

### Timeline (apps/web/src/components/Timeline.tsx, lib/timeline*.ts)

Actively being rewritten per `docs/ROADMAP.md`'s Phase 7 — check there for
current spec/status before changing rendering or interaction behavior.
Notable constraints already measured and recorded (don't re-derive):
background-only opacity fade (text below ~75% opacity fails WCAG AA on the
modal color), specific colors chosen because most reds fail AA on the
modal background, and stack-axis scrolling because dense overlapping
events need thousands of px of stack space at readable line-height.

## Conventions

- Repository functions are created via factory functions taking a
  `Database`/pool (`createEventRepository(db)`, etc.) rather than classes —
  follow that pattern for new repositories.
- Route registration functions (`registerEventRoutes(instance, ...)`) take
  the Fastify instance plus already-constructed repositories/services as
  args — wiring happens once in `app.ts`, not inside route files.
- Validation lives in `packages/shared`'s Zod schemas; route handlers
  should validate against those rather than hand-rolling checks, so the
  API and any future consumer share the same rules.
- Tests are TDD'd against a real Postgres instance, not mocks, on the API
  side (`docs/ROADMAP.md` calls this out repeatedly as deliberate). Don't
  introduce a mocked-DB test path.
- Every phase in the roadmap ends with a bughunt pass — actually exercising
  the feature, not just re-reading the code — with a regression test added
  per bug found. Follow that pattern for non-trivial changes: test the
  actual behavior, not just that the code compiles.
- Known, accepted gaps (localStorage-held encryption key, no pagination
  past 200 events, no real end-to-end push delivery verification) are
  intentional and documented in the README/roadmap — don't "fix" them as a
  side effect of unrelated work without flagging it, and don't treat them
  as bugs to silently patch.
