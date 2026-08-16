# Roadmap

Phases are ordered core-first, complexity-in-the-middle, polish-last, as
agreed. Each phase should leave the repo in a state where all tests pass
and the Docker stack builds and runs before moving to the next.

**Standing process, every phase from here on:** after a phase's features
are built and tested, do a dedicated bughunt pass -- actually exercise
what was built (not just re-read the code), fix what's found, add a
regression test for each fix, then re-run the full suite and both
production builds before calling the phase done. First applied after
Phase 2 (see that section below for what it found).

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
- [x] Offline local cache of event data itself, so a user's calendar is
      viewable with no network, not just the app shell. Implemented via
      `localStorage` rather than IndexedDB (simpler API; a personal
      calendar's data volume doesn't need IndexedDB's query features) --
      a deliberate substitution for the originally-planned tech, not a
      silent scope cut. Falls back to the last-synced copy on network
      failure, with a visible "you're offline" notice.
- [x] Event validation: end time must be after start time (enforced in
      the shared Zod schema, so both client validation and any future
      consumer get it for free)
- [x] Recurrence: RRULE-style rules (arbitrary interval like "every 37
      minutes", daily/weekly, every weekday) stored as part of the
      encrypted event content, expanded client-side for display via
      `rrule`. Simplification: editing/deleting acts on the whole
      series, not a single occurrence -- revisit if that's needed.
- [x] Priority: a plain integer, default 0, adjusted only via relative
      up/down controls (raise self, or raise everyone else instead of
      lowering self -- so priorities only ever increase, never need a
      lower bound). The raw number is never shown to the user. Distinct
      from, and unrelated to, the per-slot ranking used in group
      scheduling -- see docs/ARCHITECTURE.md.
- [x] OpenAPI spec published (`apps/api/src/openapi.ts`, served at
      `GET /openapi.json`) for the API surface that exists so far
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
**Status: Phase 1 core scope is complete.** Backend, PWA UI, offline
event caching, validation, recurrence, priority, and an OpenAPI spec are
all done and tested (73 tests across all 4 packages at last count,
against a real Postgres instance and the exact production Docker build).
The three remaining items above (passkeys, scrypt tuning, localStorage
hardening) are deliberately deferred hardening work, not blockers --
tracked here rather than silently dropped.

## Phase 2 — Multi-user & group scheduling

- [x] Public-key directory: `GET /users/:username` (auth-required, to
      reduce casual enumeration), returns public profile + key for
      inviting contacts
- [x] Event sharing/invites: per-event symmetric key, wrapped
      individually to each participant via X25519 ECDH + HKDF
      (`deriveSharedWrapKey`/`wrapKey`/`unwrapKey` in `packages/crypto`).
      The organizer is a participant of their own event too (self-ECDH),
      so there's no special-casing anywhere in the fetch/decrypt path.
      Required fixing a real gap found mid-phase: registration was
      generating a random identity keypair and discarding the private
      key immediately -- the identity keypair is now derived
      deterministically from the password instead, so it's always
      re-derivable and never needs separate storage.
- [x] Slot-based group scheduling: propose slots, submit/replace ranked
      preferences, resolve via a pluggable strategy (default: minimize
      total rank sum, Borda-count style; alternative: minimize the worst
      individual rank, available but not wired as default). The server
      only ever handles opaque slot IDs and rank numbers -- never real
      times or content.
- [x] API keys for agentic/programmatic clients: mint/list/revoke,
      same `Authorization: Bearer` header as human JWT sessions,
      distinguished by a fixed prefix. Only a hash is stored server-side.
- [x] **Notifications — simplified, not a separate system.** Rather than
      building a dedicated notifications table/delivery mechanism, the
      existing `GET /group-events` response includes each participant's
      own vote status (`myVotes`), and the web UI derives a "N awaiting
      your vote" badge from that directly. This covers the actual need
      (know when something needs your attention) without new
      infrastructure. Push/email notifications remain a Phase 3+ concern
      if ever needed.
- [x] Web UI: create/invite form (candidate time slots + invitee
      usernames), group event list with ranked voting, resolve button
      (organizer only), pending-vote badge. Tab switcher between
      "My Calendar" and "Group Events" (no router library added).

**Simplifications made and documented, not silently cut:**
- Vote submission replaces a voter's entire ranking each time (drops
  stale votes for slots no longer ranked) rather than merging.
- No UI yet for revoking API keys or managing them beyond minting --
  the API supports it (`GET`/`DELETE /api-keys`), just not wired into
  the PWA. Low priority since this is aimed at agentic/programmatic use.
- Minting a new API key is authenticated the same way as any other
  request (JWT or existing API key) -- meaning a leaked API key could
  mint further keys. Noted as a hardening item for Phase 6, not fixed
  now to avoid adding a human-only-auth special case before it's clear
  it's needed.

**Post-Phase-2 bughunt (found by actually using the app, not just
re-reading it):**
- **Real bug:** the personal calendar's display window started at
  exactly `new Date()` at render time, so an event whose start time had
  already ticked into the past by the time the list re-rendered (e.g.
  created for a time a few minutes before submitting) was silently
  excluded -- this was the reported "events added don't show up" issue.
  Fixed by widening the window to include the last 30 days, not just
  the next 90. Regression test added.
- **Real bug, found while fixing the above:** widening that window
  exposed a latent performance problem -- a high-frequency recurrence
  (e.g. "every 1 minute") expanded across a multi-month window could
  generate hundreds of thousands of occurrences and freeze the UI,
  which matters directly for this app's stated low-end-device audience.
  Fixed with an early-stopping iterator (bounds the actual computation,
  not just the returned array size) and a hard cap. Verified the fix
  actually helps: the same test dropped from ~1.4s to a few ms.
- **Real bug:** validation errors from the API (wrong username format,
  etc.) were shown to users as a bare "Invalid request" with the
  specific reason silently dropped, because the client only read
  `body.error` and never `body.details`. Fixed in one place
  (`lib/http.ts`, extracted from two duplicated copies) so every
  validation error everywhere in the app is now readable.
- UX improvement in the same area: added a matching client-side pattern
  hint on the username field, so most people never hit the server
  validation error at all.
- Redesigned the repeat UI per request: removed the preset dropdown,
  replaced with a single "Repeat" toggle button that expands a custom
  interval/unit panel and relabels itself "Repeating" while open.

**Status: Phase 2 is complete.** 133 tests passing across all 4 packages
(crypto 24, shared 27, api 37, web 45) after the bughunt pass above,
including real cross-keypair ECDH tests against actual Postgres (not
mocked), and all migrations verified to apply cleanly to a fresh
database.

## Phase 3 — Scale & offline resilience

- [x] Real offline editing with conflict resolution, not just read caching.
      **Deliberately NOT a CRDT, contrary to this roadmap's original
      plan.** CRDTs (Yjs et al.) solve concurrent editing of a *shared*
      document by multiple simultaneous writers. Personal events here have
      exactly one writer -- their owner -- so there is no multi-writer
      merge to perform. The actual problem is narrower: one user makes
      changes offline, which must replay on reconnect, with a sane answer
      if the same account edited elsewhere meanwhile. That's a mutation
      queue with conflict detection (`lib/mutationQueue.ts`, `lib/sync.ts`),
      not a CRDT. Adding Yjs would have meant a large dependency and
      restructuring the encrypted data model to solve a problem this app
      doesn't have.
      Conflict policy is conservative on purpose: if the server's
      `updatedAt` has moved since the client last saw it, the offline edit
      is **not** applied over it -- the conflict is surfaced to the person
      instead. Last-write-wins would be less code but would silently
      destroy the other device's change, which is exactly the kind of
      quiet data loss people don't forgive in a calendar.
- [x] Push notifications (Web Push/VAPID) -- backend, service worker, and
      opt-in UI. Real end-to-end delivery still needs verification in a
      real browser against a real push service; can't be tested here.
- [ ] Redis-backed queue for background work -- not needed yet (nothing
      is slow enough at current scale to justify it); revisit if
      large-group-event resolution or notification fan-out becomes a
      real bottleneck
- [x] Load testing against realistic concurrency targets; document actual
      tested scale vs. aspirational scale. Real numbers, single instance:
      `GET /health` ~1,300 req/s, `POST /events` ~465 req/s,
      `GET /events` ~212 req/s (p50 93.7ms). See `docs/ARCHITECTURE.md`'s
      Scaling strategy section for the full table and honest caveats
      (single machine, not network-realistic). Built a minimal
      dependency-free load generator (`apps/api/scripts/loadtest.ts`)
      after autocannon pulled in vulnerable transitive dependencies for
      what didn't need a third-party tool.
- [x] Horizontal-scaling hardening: audited for in-process state (none
      found), then *proved* statelessness rather than just asserting it
      -- two independent API instances against one shared database:
      both boot, a JWT from one works on the other, data written via
      one is immediately visible via the other.

**Bugs found and fixed this phase (bughunt cycle, per the standing
process):**
1. **Real crash bug:** two API instances starting *simultaneously*
   against a fresh database raced on migration bookkeeping (`CREATE
   TABLE IF NOT EXISTS schema_migrations`) and one crashed with a
   Postgres duplicate-key error -- a completely realistic scenario in
   any real horizontal rollout. Fixed with a Postgres advisory lock
   serializing concurrent migration runs. Regression test added
   (3 pools racing against a fresh database, concurrently).
2. **Real scalability bug, found by load testing:** `GET /events` and
   `GET /group-events` had no `LIMIT` -- response cost grew unbounded
   with how many events a user had ever created. Measured impact:
   ~34 req/s / 625ms avg latency before the fix, ~212-260 req/s /
   ~80-95ms after (~7x). Capped at 200 most recent; a user with more
   needs real pagination, which isn't built yet -- documented, not
   hidden.
3. Corrected inaccurate documentation: `docs/ARCHITECTURE.md` had
   claimed session state "lives in... Redis" and background work "goes
   through a queue" -- neither was ever actually built. Fixed to
   describe what's actually true today.

**Process note:** partway through this phase, the sandbox environment
fully reset (entire filesystem wiped) between conversation turns,
losing everything committed locally but not yet pushed to origin (two
checkpoints' worth of work). Recovered by re-cloning from GitHub and
redoing the lost work from detailed records of what had been built.
Lesson applied going forward: push after every checkpoint commit
instead of batching several before asking for a token, since
unpushed work has no protection against this kind of environment loss.

## Phase 7 — Timeline rewrite & social UI (specified, in progress)

Requirements gathered from direct feedback. Ticked items are built.

### Done
- [x] Fix the "invalid tag" tagging bug (stale public keys; self-heal on login)
- [x] Social layer **backend**: one-time friend codes, connections/blocks,
      invitation accept/reject, `invited_via_code` tracking
- [x] Event modal base color `hsl(198, 87%, 60%)` (`--event-modal`)

### Header & session
- [ ] Show who's logged in; logout; useful header links
- [ ] Display the user's current one-time friend code, with rotate

### Social UI (backend done, UI pending)
- [ ] Tag users by username **or** one-time code when inviting
- [ ] Invite notifications with accept / reject
- [ ] Add inviter as connection, or block them
- [ ] **Never** offer "add as connection" when the invite came via a
      one-time code — the code existed so no identity was exchanged
- [ ] Invite to events by **event code**, for both group *and* private
      events

### Events
- [ ] Default start time = now, live-updating to the second
- [ ] End time **optional**
- [ ] Click the event name — or a top-left em-square affordance when the
      name is blank or the modal is too narrow to hit — to edit
- [x] Recurring events store one row + RRULE; no duplicate rows. The
      timeline renders *calculated* occurrences.

### Timeline
- [ ] Real time axis; default scale of one day
- [ ] Orientations: horizontal past→future (default), horizontal
      future→past, vertical either direction
- [ ] Present-time indicator
- [ ] Configurable "base" edge: bottom (default) or top for horizontal;
      left (default) or right for vertical
- [ ] Drag modal edges to adjust start / duration / end
- [ ] Drag away from the base to raise priority
- [ ] Group events appear on the timeline alongside personal events
- [ ] Don't block future event-preview work

### Priority model (decided)
- [ ] **Fractional ordering** (Option B): every event holds a unique
      sortable rank. Reordering is one write regardless of list size — no
      renumbering, no O(n) write storms. Ties are impossible, so stacking
      order is never ambiguous between reloads.
- [ ] **"Important" is orthogonal**: a flag that changes styling only,
      never position. Encoded redundantly per WCAG 1.4.1 (colour alone
      must not carry meaning): bold + ★ (U+2605, `aria-hidden`) + deep
      maroon `#5C0F0A` + a visually-hidden "Important:" prefix for screen
      readers.

### Rendering rules (decided)
- [ ] Only the **background** fades toward the base. Text stays at 100%
      opacity and clickable regardless of depth or priority.
- [ ] Text must never overlap other text; overlapping modals are
      separated by ≥ one text-height.
- [ ] Open-ended events (no end time) fade toward the future.
- [ ] Event name anchors to the **start edge, away from the base**, so it
      follows the start in flipped orientations.
- [ ] When more events overlap than fit, **scroll the stack axis**, with a
      clear affordance signalling that it scrolls.

### Measured constraints (don't rediscover these)
- Text composited below ~75% opacity drops under WCAG AA on the modal
  colour (2.92:1 at 60%, 1.42:1 at 25%). Hence background-only fade.
- Red text fails on the modal background: `#B3324E`-family reds score
  ~3.02:1. Only very dark colours clear AA against *both* fade endpoints
  (modal blue and page white). `#5C0F0A` scores 6.34 / 13.75.
- Stack density: at 22px line-height, 100 mutually-overlapping events
  need ~2,200px of stack axis and 500 need ~11,000px. Hence scrolling.

### Infrastructure this depends on
- [ ] **Time-windowed event fetching** (`GET /events?from=&to=`) so the
      client only decrypts what the current view needs. Without it the
      timeline degrades badly on the low-end devices this project
      explicitly targets.

### Open design questions
- Inviting someone to a **private** event: does that convert it into a
  group event, or is there a distinct "shared personal event"? The
  current model has exactly one owner per personal event.
- How should an **unresolved** group event render on the timeline, when
  it has several candidate slots and no agreed time? Options: show every
  candidate faintly, show nothing until resolved, or show a single
  spanning block covering the candidate range.
- Accessibility is now a standing requirement for all new UI, with a
  comprehensive audit planned separately.

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

- [x] Security review pass. Found and fixed four real gaps:
      1. **No rate limiting anywhere** -- `POST /sessions` was directly
         brute-forceable. Now a global backstop (300/min, also useful
         against runaway agent clients) plus a tight 10/min limit on
         login and registration.
      2. **No security headers** -- no CSP, nothing preventing the app
         being framed for clickjacking. Added helmet with a restrictive
         CSP (the PWA only talks to its own origin, so this costs
         nothing).
      3. **JWTs never expired** -- a stolen token was valid forever. Now
         30 days; agent clients should use API keys, which are
         individually revocable.
      4. **Unbounded encrypted payloads** -- `ciphertext` had a minimum
         but no maximum, so a client could store arbitrarily large blobs.
         Now capped at 128KB plus a 256KB request body limit.
- [x] Accessibility audit. Contrast was measured, not eyeballed -- all
      palette pairs pass WCAG AA (lowest was 4.71:1). Real issues found
      and fixed:
      - Event-title inputs relied on `placeholder` alone for their
        accessible name. A placeholder isn't reliably announced and
        vanishes once you type; added explicit `aria-label`s.
      - Loading states swapped content silently with no announcement to
        assistive tech; now `role="status" aria-live="polite"`.
      - `select` elements were missing from the `:focus-visible` rule, so
        keyboard users got no focus indicator on the repeat-unit dropdown.
      - No `prefers-reduced-motion` handling; the repeat panel's reveal
        animation is decorative and now respects that preference.
      Icon-only controls (priority arrows, delete) already had proper
      `aria-label`s -- verified rather than assumed, and now covered by
      regression tests so they can't silently regress.
- [x] Load/performance testing at simulated scale -- done in Phase 3;
      real numbers and honest caveats in `docs/ARCHITECTURE.md`.
- [x] Documentation pass -- README rewritten in Phase 3 (it still
      described the Phase 0 skeleton); ARCHITECTURE.md and this roadmap
      kept current with every decision and known gap.

**Post-Phase-6 bughunt** (probing a live instance, not just re-reading
code):
- **Real bug found and fixed:** a malformed UUID in a path param (e.g.
  `/events/not-a-uuid`) reached Postgres, which throws on the invalid
  uuid cast, surfacing as an unhandled **500** rather than a 404. Wrong
  status code (the resource simply isn't there) and a small leak about
  internals. Now validated at the route boundary across events, group
  events, and API keys, with a regression test.
- Probes that came back **correct**, verified rather than assumed:
  tampered JWTs are rejected (401), SQL-injection-style usernames are
  rejected by the validator (and queries are parameterized regardless --
  the users table was confirmed intact afterward), auth headers without
  the `Bearer` prefix are rejected, oversized payloads are refused, and
  empty group-event participant lists are rejected.

**Still open, deliberately:**
- Real end-to-end push *delivery* has never been verified -- it needs a
  real browser and a real push service. The backend, service worker, and
  UI are tested; the last mile isn't.
- The encryption key still lives in `localStorage`. Documented in the
  README's security notes rather than hidden.
- No pagination: users with more than 200 events see only the most
  recent 200.
- Phases 4 (calendar integrations) and 5 (native shells) are an optional
  backlog, not abandoned work -- deferred deliberately after weighing
  effort against value.
