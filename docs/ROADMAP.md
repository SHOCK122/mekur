# Roadmap

Phases are ordered core-first, complexity-in-the-middle, polish-last. Each
phase leaves the repo with all tests passing and both production builds
working.

**Standing process, every phase:** after a phase's features are built and
tested, do a dedicated bughunt pass -- actually exercise what was built
(not just re-read the code), fix what's found, add a regression test for
each fix, then re-run the full suite and both production builds before
calling the phase done.

**Standing requirement, all new UI:** accessible by keyboard and screen
reader, contrast measured rather than eyeballed, colour never the only
carrier of meaning.

## Where things stand

The project changed shape mid-way. Phases 1-2 were built on an ACL model
(the server stored which user owned or was invited to which event). That
model leaked the social graph, so it was replaced by the **capability
model** described in `docs/ARCHITECTURE.md`: events have no owner column,
access is proven by presenting a token, and each account keeps an
encrypted keyring of the events it can reach.

Phase 7 consolidates the codebase on that model. Everything the old model
needed and the new one doesn't -- group-event tables, participant lists,
integer priorities, a directory lookup, the list view -- has been removed
rather than left lying around, and several features that were broken by
the switch (invitations, sharing from the timeline) have been repaired.

Group scheduling (candidate slots + voting) is **not** currently
available. It was part of the ACL model, and its capability-model
replacement is Phase 10. The schema scaffolding for it was removed in
Phase 7 because nothing used it; it will be re-added with the feature.

## Completed phases (summary)

Kept short on purpose -- `git log` has the detail. What's recorded here is
the decisions and lessons that still matter.

### Phase 0 -- Scaffolding ✅
Monorepo (`apps/`, `packages/`), shared Zod schemas, client-side crypto
package, Fastify API, Vite + React PWA, Dockerfiles, CI.

### Phase 1 -- Core single-user scheduling ✅
- Password auth where the password never leaves the device: one scrypt run
  -> HKDF into an auth key, an encryption key, and an X25519 identity
  keypair. The server hashes the auth key it receives, so a DB leak alone
  is not a replayable credential.
- Encrypted event CRUD; offline **read** cache of decrypted events.
- Recurrence on the iCalendar RRULE model, expanded client-side with an
  early-stopping iterator (a minutely rule over months used to freeze the
  UI).

### Phase 2 -- Multi-user (ACL model, since superseded) ✅
Per-event symmetric keys wrapped to each participant via X25519 ECDH,
API keys for agentic clients, readable validation errors. The group
scheduling built here was removed when the capability model landed.

### Phase 3 -- Scale ✅
- Load-tested; real numbers in `docs/ARCHITECTURE.md`.
- Statelessness proven with two API instances on one database. Found and
  fixed a migration race between simultaneously-starting instances
  (advisory lock).
- Web Push (VAPID) with deliberately generic payloads.
- **Correction:** this phase originally claimed an offline *mutation
  queue* (`mutationQueue.ts` / `sync.ts`). That code was lost in a sandbox
  reset and never rebuilt; the docs kept describing it. Offline **writes
  do not exist today** -- they are rescheduled in Phase 9.

### Phase 6 -- Security & accessibility pass ✅
Rate limiting (global + tight auth limit), helmet/CSP on the API, 30-day
JWT expiry, bounded payloads, UUID validation at route boundaries,
accessible names on icon controls, live regions for loading states,
`prefers-reduced-motion`.

### Capability model & timeline (Phase 7 groundwork) ✅
- Capability-based events, encrypted keyrings with optimistic
  concurrency, inboxes with no sender column (ADR in ARCHITECTURE.md).
- One-time friend codes; event codes (capability + key in one string).
- Timeline: real time axis, four orientations, configurable base edge,
  present indicator, continuous zoom, drag-to-pan, drag edges to resize,
  drag away from the base to raise priority, background-only fade,
  open-ended events, recurring series on a single row.
- **Fractional ordering** for priority (one write per reorder, no ties)
  and an orthogonal **important** flag (bold + ★ + maroon + hidden
  "Important:" prefix, per WCAG 1.4.1).
- Skipping a single occurrence of a series (EXDATE-style, inside the
  encrypted content so everyone holding the key agrees).

## Phase 7 -- Consolidate on the capability model (this pass)

A refactor phase: no big new features, but it removes a whole model's
worth of dead code and fixes what the model switch broke.

### Fixes for things the switch broke
- [x] **Invitations were undecryptable.** An invite was encrypted with
      ECDH(sender, recipient), but the server (correctly) records no
      sender, and the client only tried its *own* public key -- so every
      invite from anyone else failed silently. Replaced with a sealed box:
      an ephemeral X25519 key per message (sent alongside the ciphertext,
      unlinkable to anyone), plus an optional sender proof inside the
      ciphertext so a named invite's sender is verifiable by the recipient
      but invisible to the server.
- [x] Connections and blocks were keyed by the sender's *friend code*,
      which rotates the moment anyone uses it -- so blocks stopped working
      almost immediately. Now keyed by the sender's verified public key.
- [x] Sharing was only reachable from the hidden list view. It now lives
      in the event edit panel, along with recurrence editing and restoring
      skipped occurrences.
- [x] "Repeat until" was collected by the form and silently ignored.
- [x] "Skip this one" from the edit panel skipped the series' *first*
      occurrence rather than the one clicked.
- [x] People holding a view-only capability had no way to remove an event
      from their schedule. "Remove from my schedule" drops the keyring
      entry (the event itself is untouched for everyone else).
- [x] The repeat-interval field couldn't be cleared while typing (it
      snapped back to 1, so "clear, type 2" gave 12).
- [x] Bughunt in a real browser (two accounts: create, share by username,
      accept, view-only removal, anonymous code invite) found two more:
      the event-code "Add event" button had the same accessible name as
      the create form's (now "Join event"), and the create form's
      datetime inputs overflowed the card.
- [x] Found in PR review: saving any edit rounded an event's start to the
      minute (the inputs show minutes; new events start to the second),
      shifting recurring series and un-skipping their skipped dates.
      Untouched time fields now save the original instant.
- [x] Found in PR review: invites from blocked senders and unreadable
      messages were hidden but never deleted, so they still counted toward
      the 200-message inbox cap and could crowd out real invitations.

### Privacy and security fixes
- [x] `friend_codes.consumed_by` recorded *who redeemed whose code* in
      plaintext -- precisely the social-graph edge the capability model
      exists to avoid storing. Codes are now deleted on use; nothing
      records who used them.
- [x] The public-key "repair" endpoint let any bearer token (including an
      API key) replace an account's public key, redirecting future
      invites to an attacker. Repair now happens inside login, which
      proves knowledge of the password.
- [x] API keys can no longer mint further API keys (Phase 2 hardening
      item); only an interactive session can.
- [x] Removed `GET /users/:username`. Its only purpose was the old invite
      flow, and it was an enumeration surface. `POST /tags/resolve`
      covers inviting.
- [x] Keyring and inbox payloads are validated as envelopes with explicit
      size limits instead of accepted as arbitrary JSON.
- [x] Security headers (CSP, frame-ancestors, nosniff, referrer policy)
      on the **HTML** served by nginx. Helmet only ever covered API
      responses, but XSS in the page is what would expose the locally
      stored keys.
- [x] **Rate limits were shared by every user** in the Docker deployment:
      the API didn't trust nginx's `X-Forwarded-For`, so all requests
      came from one IP and ten failed logins anywhere locked everyone out.
      `TRUST_PROXY` is now configurable and set to 1 in docker-compose.

### Removals
- [x] Group-event schemas (`GroupEvent*`, `Slot*`, votes), the API's
      group-event request schemas, `event_votes`, `events.slot_ids/status/
      resolved_slot_id`, `user_relationships`, pseudonym derivation, and
      unused crypto helpers.
- [x] Integer `priority` and the up/down arrows (superseded by fractional
      rank), and the list view that hosted them.
- [x] Stale OpenAPI paths (`/group-events`, `ownerId`); the spec now
      describes the routes that exist.

### Structure
- [x] `POST /events/batch-read` is one SQL query instead of two per event
      (up to 1,000 round trips for a full keyring).
- [x] The web client's 540-line `Calendar` is split into a data hook
      (`useEvents`), a schedule container, a create form, and a shared
      recurrence editor used by both create and edit.
- [x] The keyring is cached in memory per session, so an edit no longer
      re-downloads and re-decrypts it just to find a token.
- [x] One header: sign-out, notifications, invite code, event codes and
      invitations live together instead of being split across two.
- [x] OpenAPI drift is now a test failure: the suite compares the spec
      against the routes Fastify actually registers.

### Test suite
- [x] API test files shared one database and truncated it concurrently,
      so one file could delete another's users mid-test. This was the
      source of the intermittent 401s and "timeouts". Files now run
      serially.
- [x] Tests no longer run scrypt (~2s each) except for the one end-to-end
      login test; the API and web client never see *how* keys were
      derived. Added coverage for friend codes/tags (previously none),
      sealed invitations, the edit panel, and the schedule flows above.

## Phase 8 -- Timeline completion & accessibility

- [x] **Keyboard alternatives for every drag** (WCAG 2.5.7). On a
      focused, editable event: arrows along the time axis move it,
      Shift+arrows move its end, Alt+Shift+arrows its start, arrows across
      the axis re-rank it (away from the base = higher priority). Keys
      follow the orientation, so "later" is whichever arrow points the way
      the event visibly travels. Each press is announced in a polite live
      region, and the keys are described via `aria-describedby`.
      - Step is the largest round unit <= ~1% of the visible span (15 min
        on a day view, never under 1s).
      - Presses preview immediately and are saved as **one** write once
        the keys go quiet for 500ms (or on blur), so holding an arrow is
        not dozens of encrypted round trips -- and later presses build on
        the pending preview rather than a stale copy of the event.
      - Re-ranking passes the next event the focused one actually
        *overlaps* (label separation included, as in `assignLanes`);
        passing a non-overlapping event would change nothing visible. The
        new rank is placed against the passed event's global neighbour so
        it can't tie with anything.
      - Plain Alt is deliberately unused: Alt+Left/Right is browser
        history navigation. Ctrl/Meta combinations are left to the
        browser/OS.
      - Simplification: there are no separately focusable resize handles
        (that would be three tab stops per event); modifiers on the one
        focusable label cover all three drags.
      - Found while exercising it: moving an event entirely out of the
        visible window unmounted its label, so keyboard focus was lost.
        Fixed by the auto-pan item below.
      - Found in PR review and fixed: after one event's save was sent,
        pressing an arrow on a *different* event started from the first
        event's times (and re-sent its save); saves for one event could
        land out of order; raising an event reordered the DOM and dropped
        focus; dragging or opening the editor mid-save started from stale
        times; a failed save was never announced; announcements lacked the
        date. Saves now run one at a time and stay on screen until they
        land, series render in stable (not rank) order, and the editor
        opens once pending changes are saved.
      - Known limitation (shared with dragging): events stored before
        ranks existed get placeholder ranks recomputed each render, so
        passing one of them may not stick. Every event created since has
        a real rank.
- [x] **Keep a keyboard-moved event in view.** A nudge that would carry
      the focused event off screen now pans the timeline with it, so its
      label stays mounted and keeps focus. (`panToKeepInView`, pure.)
      - The view follows the edge being changed (the start for a move,
        the end for Shift+arrow) once it comes within a label's width of
        the view's edge, so the label is still readable, not just mounted.
        The margin is capped at a quarter of the view.
      - It only ever pans in the direction the edge moved: nudging an
        event that already sits near one edge never makes the view jump
        the other way.
      - If the edge wasn't on screen to begin with (a long event clipped
        by the view), the view stays put until the event as a whole would
        leave, then steps in just enough. For a series, "as a whole" means
        every visible occurrence, since a change shifts them all alike;
        the followed edge is that of the first visible occurrence, which
        carries the label.
      - Simplification: the pan is not announced. The live region already
        announces the event's new time, which is what changed; the view
        moving is a consequence of that, not news.
      - Re-ranking never pans: it changes the lane, not the time.
- [ ] Label collision: guarantee text never overlaps text, with overlapping
      modals separated by at least one text-height.
- [ ] Clear affordance that the stack axis scrolls when lanes overflow.
- [ ] Richer recurrence: `bySetPos`, `byMonthDay`, `byMonth` ("first
      Monday of every month"). Schema + UI work; `rrule` already supports
      all three.
- [ ] Single-occurrence overrides (iCalendar `RECURRENCE-ID`): edit one
      occurrence without splitting the series by hand.
- [ ] Undo for timeline drags (one level is enough).
- [ ] How should a **view-only** event look on the timeline? Today it is
      indistinguishable apart from missing handles.

## Phase 9 -- Sync efficiency & offline writes

Note: an earlier draft proposed `GET /events?from=&to=` for time-windowed
fetching. That is incompatible with end-to-end encryption -- the server
would have to know event times to filter on them. Windowing has to happen
client-side; what *can* be reduced is how much is re-downloaded and
re-decrypted.

- [ ] Incremental batch read: the client sends the `updatedAt` it last
      saw per event; the server returns only what changed plus which ids
      are gone.
- [ ] Decrypt cache keyed by `(eventId, updatedAt)` so unchanged events are
      never decrypted twice.
- [ ] Offline writes: a mutation queue with conflict detection (compare
      `updatedAt`; surface conflicts rather than last-write-wins), rebuilt
      from the design in `docs/ARCHITECTURE.md`.
- [ ] Keyring beyond 500 events: batch reads are capped at 500 per request.
- [ ] Keyring backup/export. The keyring is a single point of failure --
      lose it and every event in it is permanently unreachable. An
      encrypted export file is the cheapest real mitigation.
- [ ] The offline event cache stores **decrypted** content in
      `localStorage`. Encrypting it buys nothing while the key sits next to
      it (see Phase 11), so this is tied to that work.

## Phase 10 -- Group scheduling on capabilities

- [ ] Candidate slots inside the encrypted content; opaque slot ids
      server-side.
- [ ] Votes under per-event pseudonyms derived from the voter's
      capability, so the server cannot link one person across events.
- [ ] Resolution strategies (rank-sum default, minimax alternative).
- [ ] Decide how an unresolved event renders on the timeline (all
      candidates faintly / nothing / one spanning block).
- [ ] Revocation by re-keying: rotate the event key and redistribute to
      remaining holders.
- [ ] Series invitations vs. per-occurrence overrides: an invitee to a
      whole series is **not** automatically on a split-off occurrence
      (the split exists because that occurrence is different).

## Phase 11 -- Key handling hardening

- [ ] The encryption key and identity secret live in `localStorage` in
      plaintext, readable by any injected script. Options: wrap with a
      non-extractable WebCrypto key, or keep keys in memory only and
      re-prompt for the password per session.
- [ ] Public keys come from the server, so a malicious server could
      substitute its own and read new invites. Add safety numbers /
      fingerprint comparison for connections.
- [ ] Passkeys/WebAuthn as an additional login method.
- [ ] Re-tune scrypt (`N=2^17`) against real low-end device timings.
- [ ] Real end-to-end push delivery in a browser against a real push
      service (backend, service worker and UI are tested; the last mile
      is not).

## Backlog (optional, deliberately deferred)

- CalDAV import/export; Google/Microsoft sync (off by default)
- Timezone edge cases (DST transitions), i18n
- Capacitor shells for iOS/Android; native push
- Background job queue -- nothing is slow enough to need one yet
- Advertising: a separate project, constraints recorded in
  `docs/ARCHITECTURE.md`

## Measured constraints (don't rediscover these)

- Text composited below ~75% opacity drops under WCAG AA on the modal
  colour (2.92:1 at 60%, 1.42:1 at 25%). Hence background-only fade.
- Red text fails on the modal background (`#B3324E`-family ~3.02:1). Only
  very dark colours clear AA against both fade endpoints; `#5C0F0A`
  scores 6.34 / 13.75.
- Stack density: at 22px line-height, 100 mutually-overlapping events
  need ~2,200px of stack axis and 500 need ~11,000px. Hence scrolling.
- `GET /events` without a `LIMIT` measured ~34 req/s; bounded, ~212 req/s.
  Every list endpoint stays bounded.
