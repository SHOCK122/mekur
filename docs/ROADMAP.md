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

- [ ] Account creation/login: passkey (WebAuthn) as the primary flow,
      password + scrypt-derived key as a fallback for devices without
      passkey support
- [ ] Postgres added to the stack; user table (public key, auth
      credential, no plaintext secrets)
- [ ] Event CRUD: create/read/update/delete personal events, stored as
      `EncryptedEnvelope`s, encrypted/decrypted entirely client-side
- [ ] PWA: local calendar view, create/edit event UI, offline local
      cache (IndexedDB) so a user's own calendar works with no network
- [ ] OpenAPI spec published for the API surface that exists so far
- [ ] Revisit the scrypt cost parameter (`N=2^17`) against real low-end
      device timing — currently tuned for security, may need to be
      adaptive per device class

**Exit criteria:** a single user can install the PWA, create an account,
add/edit/delete events, and see them persist across a refresh and across
a server restart — all without the server ever being able to read event
content. `docker compose up` serves this end to end.

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
