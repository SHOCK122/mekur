# Roadmap

Phases are ordered core-first, complexity-in-the-middle, polish-last, as
agreed. Each phase should leave the repo in a state where all tests pass
and the Docker stack builds and runs before moving to the next.

## Phase 0 — Scaffolding ✅ (this session)

- [x] Monorepo structure (`apps/`, `packages/`, npm workspaces)
- [x] `packages/shared`: domain types + Zod schemas (encrypted envelope,
      user, event record/content) — tested
- [x] `packages/crypto`: X25519 keypairs, scrypt password KDF,
      XChaCha20-Poly1305 encrypt/decrypt — tested
- [x] `apps/api`: Fastify skeleton with a `/health` endpoint — tested,
      and smoke-tested as an actual compiled running server
- [x] `apps/web`: Vite + React PWA shell (manifest, service worker,
      offline caching), live API health check — tested
- [x] Dockerfiles for api (multi-stage, pruned prod deps) and web
      (nginx), docker-compose.yml — build/runtime logic manually verified
      by reproducing each Docker stage's steps directly (no Docker daemon
      available in the build environment); **actual `docker build`/
      `docker compose up` still needs verification on a machine with
      Docker**
- [x] CI workflow (GitHub Actions): typecheck + test each workspace, then
      build both Docker images
- [x] README, ARCHITECTURE.md, this ROADMAP.md

## Phase 1 — Core single-user scheduling

- [x] Account creation/login: password-based auth implemented (client derives
      `authKey`/`encryptionKey` via domain-separated HKDF from one scrypt
      run; server hashes the submitted `authKey` itself rather than trusting
      a client-supplied hash, so a DB leak alone isn't a replayable
      credential). Passkey/WebAuthn as an additional login method is
      deferred — tracked below, not blocking.
- [x] Postgres added to the stack; `users` table (public key, auth salt,
      auth hash — no plaintext secrets, no encryption keys)
- [x] Event CRUD: create/read/update/delete personal events, stored as
      `EncryptedEnvelope`s, encrypted/decrypted entirely client-side.
      Verified with a dedicated cross-user isolation test.
- [x] All of the above TDD'd against a real local Postgres instance (not
      mocks) and smoke-tested against the exact pruned production
      Docker build/runtime (compiled output + production-only deps)
- [x] PWA: login/register forms, calendar view (list/create/delete
      events), session persisted across refresh. App-shell offline
      caching (from Phase 0's service worker) still applies, but event
      *data* itself is fetched live and is NOT yet cached for offline
      viewing/editing — that's still open, see below.
- [ ] Offline local cache of event data itself (IndexedDB), so a user's
      calendar is viewable/editable with no network, not just the app
      shell
- [ ] OpenAPI spec published for the API surface that exists so far
- [ ] Passkey/WebAuthn as an additional (preferred) login method
- [ ] Revisit the scrypt cost parameter (`N=2^17`) against real low-end
      device timing — currently tuned for security, may need to be
      adaptive per device class
- [ ] **Known trade-off to revisit:** the encryption key currently lives
      in `localStorage` (plaintext, for simplicity) so a page refresh
      doesn't log the user out. This is readable by any script that gets
      injected via XSS. Hardening options for a later pass: keep the key
      only in memory (require re-entering the password each session), or
      wrap it with a non-extractable WebCrypto key tied to the origin.
      Not fixed now to avoid adding complexity before the core flow is
      proven out, but flagged rather than silently accepted.

**Exit criteria:** a single user can install the PWA, create an account,
add/edit/delete events, and see them persist across a refresh and across
a server restart — all without the server ever being able to read event
content. `docker compose up` serves this end to end.
**Status:** Backend and the core PWA UI are both done and tested
(register, login, create/list/delete events, session persisted across
refresh, against a real Postgres instance and the exact production
Docker build). Still open before this phase is fully "done": offline
caching of event data itself, an OpenAPI spec, and the two deliberately
deferred items above (passkeys, localStorage hardening).

## Phase 2 — Multi-user & group scheduling

- [ ] Public-key directory (so users can look up contacts to invite)
- [ ] Event sharing/invites: per-event key generation + wrapping to
      invitee public keys (see `docs/ARCHITECTURE.md`)
- [ ] Slot-based group scheduling: propose slots, submit rankings, server
      selection algorithm (pluggable strategy, Borda-count default)
- [ ] In-app notifications (invite received, event resolved)
- [ ] API keys / OAuth client-credentials flow for agentic AI clients,
      with the same OpenAPI contract

## Phase 3 — Scale & offline resilience

- [ ] CRDT-based local edit sync (e.g. Yjs) for real offline editing with
      conflict resolution, not just read caching
- [ ] Push notifications (Web Push/VAPID)
- [ ] Redis-backed queue for background work (notifications, large-event
      slot selection)
- [ ] Load testing against realistic concurrency targets; document actual
      tested scale vs. aspirational scale
- [ ] Horizontal-scaling hardening: confirm no in-process state blocks
      running multiple API replicas

## Phase 4 — Integrations & richness

- [ ] CalDAV import/export
- [ ] Google Calendar / Microsoft Graph sync (optional, off by default)
- [ ] Recurring events, timezone edge cases (DST transitions, etc.)
- [ ] Localization / i18n

## Phase 5 — Native shells

- [ ] Capacitor wrapper for iOS/Android as installable apps
- [ ] Native push notification integration
- [ ] Evaluate whether a fully native rewrite is warranted based on real
      usage/performance data, rather than assuming it up front

## Phase 6 — Polish & rigorous testing

- [ ] Security review pass (dependency audit, key-handling review,
      penetration-test-style pass on auth flows)
- [ ] Accessibility audit
- [ ] Load/performance testing at simulated scale
- [ ] Documentation pass for external contributors
