# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An open-source, end-to-end encrypted scheduling app, self-hostable via
Docker. Single-user scheduling, sharing and the timeline work today; group
scheduling (candidate slots + voting) is planned for `docs/ROADMAP.md`
Phase 10 and is not currently built. Encryption happens client-side; the
server is designed to hold as little sensitive information as possible. Read
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before touching anything
related to encryption, capabilities, or the data model — it documents *why*
things are shaped the way they are, including several rejected alternatives
(CRDTs, stable ad-attribution tokens, the old ACL model) and known,
deliberately-accepted leaks. [`docs/ROADMAP.md`](docs/ROADMAP.md) has
phase-by-phase status, every simplification made along the way, and bugs
found by each phase's bughunt pass — check it before assuming something is
unbuilt or before re-discovering a constraint that's already recorded there
(e.g. the Timeline's WCAG contrast numbers, stack-density thresholds).
[`docs/HANDOFF.md`](docs/HANDOFF.md) has the current state, history that
isn't visible in the code, and the next tasks.

The stack is TypeScript. A port of the API to Rust was tried and fully
reverted (PRs #13–#21); don't propose another language migration without
asking.

## Commands

Node.js **22** (CI and the Docker images use it; newer Node versions can
break the web tests, see `docs/HANDOFF.md`), npm workspaces (`apps/*`,
`packages/*`). `packages/shared` and `packages/crypto` must be built before
the apps typecheck or test against them — `pretest`/`pretypecheck` hooks
handle this automatically at the repo root, but if you're iterating inside a
single package after changing a dependency package, rebuild it first:
`npm run build:libs`.

To change dependencies, use npm 11 (`npx npm@11 update`,
`npx npm@11 install <pkg>`): npm 10, bundled with Node 22, crashes
resolving `vitest`'s optional peer dependencies. `npm ci` with npm 10 is
fine, and is what CI and the Docker images run.

```bash
npm ci
npm run test                          # every package, from repo root
npm run typecheck                     # every package
npm run build                         # production builds (api + web)

# single workspace
npm run test --workspace=@schedule-app/api
npm run test --workspace=@schedule-app/web

# single test file (vitest) — cd into the package first
cd apps/api && npx vitest run test/capabilities.test.ts
cd apps/web && npx vitest run test/Timeline.test.tsx

# dev servers
cd apps/api && npm run dev            # Fastify on :3000
cd apps/web && npm run dev            # Vite PWA on :5173, proxies /api to :3000

cd apps/api && npm run loadtest       # BASE_URL=http://localhost:3000, see apps/api/scripts/loadtest.ts
```

**API tests require a real local PostgreSQL** (not mocked):

```bash
createdb scheduleapp_test
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/scheduleapp_test npm run test
```

In the dev container (`.devcontainer/`) this is already done: PostgreSQL 16
runs at `localhost:5432` (user/password `postgres`), the `scheduleapp` and
`scheduleapp_test` databases exist, and `TEST_DATABASE_URL` is set, so
`npm run test` works as-is.

The dev container has an outbound firewall (`.devcontainer/init-firewall.sh`):
only npm's registry, GitHub, Anthropic and VS Code's servers are reachable,
and sudo is limited to re-running that script. If a task needs another host
or a system package, say so and stop: you can't change the firewall or
install packages, and you mustn't edit `.devcontainer/` to grant yourself
access. The owner reviews and rebuilds.

**Before calling a change done**, run `npm run typecheck`, `npm run test`
and `npm run build` — every roadmap phase must leave all tests passing and
both production builds working.

`apps/api/test/testHelpers.ts` (`setupTestApp`/`truncateAll`) builds a real
app against that database and runs migrations; tests raise the rate limit
far above production defaults so a fast-firing suite doesn't trip it. API
test files run **serially** (`apps/api/vitest.config.ts`) because they share
one database and truncate it between tests — re-enabling file parallelism
brings back intermittent 401s.

Web tests run under vitest + jsdom (`apps/web/vite.config.ts`), setup file
at `apps/web/test/setup.ts`, with `apps/web/test/mockServer.ts` mocking the
API layer rather than hitting a real server.

Tests avoid real scrypt (~2s per derivation) except one end-to-end login
test: use `registerUser` from `apps/api/test/testHelpers.ts` and
`apps/web/test/testSession.ts` instead of deriving keys from a password.

Docker: `cp .env.example .env`, fill in real secrets (the stack refuses to
start with placeholders), then `docker compose up --build`. The api
container isn't published to the host — nginx (`infra/nginx.conf`) serves
the web build and reverse-proxies `/api/*` internally. Docker isn't
available inside the dev container; run the full stack from the host.

## Architecture

**Monorepo, four packages**, dependency order `shared → crypto → {api, web}`:

- `packages/shared` — Zod schemas and inferred types for every wire/domain
  object (`EncryptedEnvelope`, `SealedEnvelope`, `EventContent`,
  `RecurrenceRule`, etc.). Both the API and the web client validate against
  these, so a schema change is a single edit that both sides pick up.
- `packages/crypto` — all client-side crypto: X25519 keypairs, scrypt
  password KDF, XChaCha20-Poly1305 envelopes (`encryptEnvelope`/
  `decryptEnvelope`), and sealed boxes to a recipient's public key with an
  optional sender proof (`sealToRecipient`/`openSealed`). This is the only
  package that should ever touch key material directly.
- `apps/api` — Fastify + PostgreSQL. Layered as
  `routes/ → repositories/ → db/pool`, with `services/notificationService.ts`
  for push. `app.ts` wires everything (`buildApp`); `server.ts` is the thin
  entrypoint that calls it with real config. Auth is a Fastify plugin
  (`plugins/auth.ts`) accepting either a JWT or an API key
  (`lib/apiKey.ts`) via the same `Authorization: Bearer` header; only a
  session JWT may mint new API keys. `openapi.ts` is hand-written, and
  `test/health.test.ts` fails if it drifts from the registered routes.
- `apps/web` — Vite + React PWA. UI in `components/`, business logic
  (crypto orchestration, HTTP via `apiFetch` in `lib/http.ts`, keyring,
  sharing, recurrence and time zones, timeline math) in `lib/`, and loading
  plus every event mutation in `hooks/useEvents.ts` — components should
  stay thin. The timeline is the only view; per-event actions live in
  `EventEditPanel`. Service worker at `sw.ts` (injectManifest strategy,
  precaches the app shell).

### The capability model (read this before touching events/auth)

The server does **not** store which user owns which event. This
supersedes an earlier ACL-style design (`group_event_participants` rows)
that leaked the social graph even with content encrypted — see
`docs/ARCHITECTURE.md`'s "Architecture decision" section for the full
reasoning. Consequences that shape the code:

- Events are standalone rows (`repositories/eventRepository.ts`,
  `lib/capability.ts`). Access is `event_id` + a **view token** (read) or
  **edit token** (write) — capability tokens, not ownership checks. A
  wrong or missing capability returns **404, never 403**, so ids can't be
  probed.
- `GET /events` is unanswerable server-side by design. The client holds
  `(eventId, viewToken, editToken, eventKey)` per event in an encrypted
  **keyring**, synced as one opaque blob (`repositories/keyringRepository.ts`,
  `apps/web/src/lib/keyring.ts`). Losing the keyring makes events
  permanently unreachable — nothing else records that access existed.
- Invites travel through an **inbox** (`repositories/inboxRepository.ts`,
  `routes/inboxRoutes.ts`): a sealed box to the invitee's public key, using
  a fresh ephemeral key per message, with an optional sender proof inside
  the ciphertext. Writes authenticate as *some* valid account, not as a
  specific sender — authenticating the writer against the recipient would
  rebuild the social graph server-side. There is no sender column.
- Connections and blocks live on the client, keyed by the sender's verified
  public key (not their friend code, which rotates on use).
- Planned group-event votes (Phase 10) use per-event pseudonyms
  (`lib/capability.ts` `derivePseudonym`), not global user IDs, so the
  server can't link the same voter across two events.
- If you're adding a feature that needs the server to answer "which events
  does this user have," stop and re-read the ARCHITECTURE.md section first
  — that question is unanswerable by design, and working around it usually
  means quietly reintroducing the leak the capability model exists to
  prevent. The same goes for anything that records user-to-user links in
  plaintext (tables, columns, logs).

### Slot selection will be pluggable (Phase 10, not built yet)

When group scheduling is rebuilt, resolution should pick a winning slot via
a swappable strategy (`(votes) -> winning slot_id`), not hardcoded —
default minimizing summed rank (Borda-count style), with a
worst-rank-minimizing alternative. Don't hardcode a specific rule where a
strategy function should be called instead.

### Offline (web client)

Today offline is **read-only**: the app shell (service worker precache) and
the last-synced events (`lib/eventCache.ts`) load with no network. Offline
**writes do not exist** — an earlier `mutationQueue.ts`/`sync.ts` was lost
and is rescheduled for Phase 9 (see the correction in `docs/ROADMAP.md`).
When it's rebuilt, the design is deliberately **not** a CRDT — personal
events have exactly one writer, so there's no concurrent-multi-writer merge
to solve, just replay-on-reconnect with conflict detection. Conflict policy
is conservative by design: if the server's `updatedAt` moved since the
client last saw it, the offline edit is surfaced as a conflict rather than
applied (no last-write-wins, which would silently destroy the other
device's change). Queued mutations are collapsed before replay (repeated
edits → one write, delete supersedes earlier edits, create+delete while
offline → dropped entirely).

### Statelessness and limits

The API has no server-side session store, in-process cache, or singleton —
audited and *proven* (two independent instances against one database:
both boot, a JWT from one is accepted by the other, writes via one are
immediately visible via the other), not just asserted. If you add anything
that holds state in the process (a cache, an in-memory map keyed by
user/session), it breaks horizontal scaling and the proof above — think
twice and prefer Postgres.

Every list endpoint stays bounded (batch read 500, inbox 200). Rate limits
key on the client IP, so `TRUST_PROXY` must list the addresses or ranges of
the reverse proxies in front of the API (`uniquelocal`, the private ranges,
behind the bundled nginx) — otherwise every user shares one rate-limit
bucket. Hop counts are rejected at startup: Fastify 5.12+ treats a numeric
`trustProxy` as trusting nothing.

### Migrations

Plain SQL files in `apps/api/src/db/migrations/`, applied in order by
`db/migrate.ts` under a Postgres advisory lock (added after two instances
starting simultaneously against a fresh database raced on migration
bookkeeping and crashed — see `migrationConcurrency.test.ts`). New
migrations: add a new numbered `.sql` file, don't edit an existing one.

### Timeline (apps/web/src/components/Timeline.tsx, lib/timeline*.ts)

Phase 8 (timeline completion & accessibility) is done except deciding how
view-only events look — check `docs/ROADMAP.md` for the spec and status
before changing rendering or interaction behavior. Every drag has a
keyboard alternative (WCAG 2.5.7), announced via a live region; keep it
that way for new interactions.
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
- Validate request bodies with Zod: reuse `packages/shared`'s schemas for
  anything that is also part of the client's data model, and keep
  route-only shapes in `apps/api/src/schemas.ts` or the route file.
- Tests are TDD'd against a real Postgres instance, not mocks, on the API
  side (`docs/ROADMAP.md` calls this out repeatedly as deliberate). Don't
  introduce a mocked-DB test path.
- Every phase in the roadmap ends with a bughunt pass — actually exercising
  the feature, not just re-reading the code — with a regression test added
  per bug found that fails without the fix. Follow that pattern for
  non-trivial changes: test the actual behavior, not just that the code
  compiles.
- One roadmap item per branch and PR; review fixes go in a follow-up commit
  on the same branch, and PRs are squash-merged once CI is green. Keep
  `docs/ROADMAP.md`, `docs/ARCHITECTURE.md` and `README.md` truthful in the
  same change that would make them wrong.
- All new UI must be accessible by keyboard and screen reader, with
  contrast measured rather than eyeballed and colour never the only carrier
  of meaning (the roadmap's standing requirement).
- Known, accepted gaps (localStorage-held encryption key, server-supplied
  public keys, batch reads capped at 500 events per request, no offline
  writes, no real end-to-end push delivery verification) are intentional
  and documented in the README/roadmap — don't "fix" them as a side effect
  of unrelated work without flagging it, and don't treat them as bugs to
  silently patch.
