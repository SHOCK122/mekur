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
      - The view follows the edge being changed (the start for a move or
        Alt+Shift, the end for Shift) once it comes within a label's width
        of the view's edge, so the label is still readable, not just
        mounted. The margin is measured along the time axis (height in the
        vertical layouts) and capped at a quarter of the view.
      - It only ever pans in the direction the edge moved: nudging an
        event that already sits near one edge never makes the view jump
        the other way.
      - Following the end never pans the start past the earlier margin:
        an occurrence is only rendered while its start is in view (see
        the bug below), so stretching an event longer than the view lets
        its end run off screen rather than its label. (Lifted once that
        bug was fixed; see below.)
      - For a series the followed occurrence is the first visible one,
        which carries the label; a change shifts every occurrence alike.
      - Simplification: the pan is not announced. The live region already
        announces the event's new time; the view moving is a consequence.
      - Re-ranking never pans: it changes the lane, not the time.
      - Found in PR review and fixed: the first version followed the end
        unconditionally, so 120 Shift+arrow presses on a day view still
        pushed the start off screen and dropped focus.
      - Known limitation: moving a series with an `until` (or onto skipped
        dates) doesn't shift its occurrences uniformly, so its only
        visible occurrence can cease to exist; no pan can keep that in
        view.
- [x] **Bug (found while building the above): events in progress at the
      start of the view are not drawn.** `expandOccurrences` kept an
      occurrence only if its *start* was inside the view, so an event from
      11:00 to 13:00 vanished once the view was panned to start at 12:00.
      It now keeps every occurrence that *overlaps* the view.
      - The in-progress occurrence is drawn from the view's edge with its
        label pinned there, and competes for a lane from that edge (where
        its label actually is), not from its off-screen start. Both resize
        handles stay, as they already did for an event running past the
        view's end; drags are relative, so the start handle at the edge
        still moves the real start.
      - Of a series' occurrences in progress at the view's start, only the
        latest is returned: repeats share a duration, so it ends last and
        every earlier one lies entirely underneath it in the series' row.
        Skipped repeats don't count (with `includeSkipped`, a later
        skipped one is returned alongside the real one, not instead).
        That keeps a long event repeating more often than it lasts (a
        year-long event every minute) to one extra occurrence, found by
        walking at most 100 repeats back -- so if the latest 100 were all
        skipped, an older one still in progress is not drawn.
      - Simplification: open-ended events still appear only while their
        start is in view. Without an end there is nothing to overlap, and
        counting them would keep every open-ended repeat that ever began
        on screen forever.
      - Lifts the cap on keyboard-following noted above: Shift+arrow now
        follows the end of an event stretched longer than the view, and
        moving an in-progress event earlier follows its end rather than
        yanking the view back to its off-screen start. Moving it later
        never pans: nothing can carry it out of view that way.
      - Found in PR review and fixed: without the old cap, following an
        edge that was *already* off screen jumped the view by however far
        away it was (Shift+arrow on an end three days out panned three
        days), and Alt+Shift on an in-progress event's start yanked the
        view back to it. An edge already off screen is no longer followed.
      - Found while fixing it: jsdom has no `PointerEvent`, so every
        `fireEvent.pointer*(el, { clientX })` in the web tests silently
        dropped its coordinates. The pan test computed a `NaN` view and
        passed only because the old start-in-view check was false against
        `NaN`; with real coordinates its drag overshot the event by two
        days. The test setup now polyfills `PointerEvent` and the test's
        arithmetic is corrected.
- [x] **Label collision: text never overlaps text**, with overlapping
      modals separated by at least one text-height. Exercised in Chromium
      with seven overlapping events and long names, checking every pair of
      label boxes: `main` had 19 overlaps across the six layouts and
      enlarged text; now none.
      - Every label was assumed to be 90px wide, so a long name on a short
        event ran over the next name in its lane. Each event's lane now
        stays taken until the later of its end and its *label's* end, plus
        an 8px gap (`occupiedUntil`, shared by lane assignment and keyboard
        re-ranking). An event that outlasts its name no longer reserves
        90px past its end, so lanes pack tighter too.
      - Label sizes are **measured** after render and fed back into the
        layout (one extra render; sizes depend only on the text, so it
        settles). Until then -- and always in jsdom -- a deliberately
        generous estimate is used. Measuring forces layout, so it runs
        only when the set of labels on screen or the axis changes, plus a
        `ResizeObserver` on the labels for text-size changes and late
        fonts. Measurements persist across pans, capped at 500.
      - Lanes are at least as thick as the thickest label on screen (min
        28px), so names in neighbouring lanes can't overlap even with the
        browser's text size doubled. Neighbouring modals are therefore
        offset by at least one full label: a text-height plus padding.
      - Vertical layouts: names are now set sideways (`writing-mode:
        vertical-rl`), running along time like the horizontal ones.
        Written across, any name wider than a 28px lane covered the names
        in neighbouring lanes, and no lane width short of the longest name
        would fix that. Simplification: sideways text is less pleasant to
        read; the alternative was lanes as wide as the longest name.
      - Found while doing it: with the base on the **left**, every label
        sat at the base whatever its lane (the modal reached the base, and
        the label was pinned to its corner), so all overlapping names were
        drawn in one place. With the base at the **top**, the modal ran
        from its lane *away* from the base.
      - Found in PR review and fixed: because the whole event box reached
        the base, its resize handles and body lay over every lower lane's
        event, and since each box was its own stacking context, a name
        overhanging its event could be painted under (and have its clicks
        taken by) a later neighbour. Now the event -- label, handles, hit
        area -- stays in its own lane, and only its fill reaches the base
        (`fillToBase`), ignoring pointer events. Fills, handles and names
        each share one layer across all events, names on top. This also
        fixes both base-left and base-top above.
      - Consequence: a skipped occurrence now dims only its fill, not its
        name (dimming the whole box made it a stacking context again, and
        dimmed text fails contrast anyway).
      - Found while doing it: the label reservation converted px to time
        using the viewport's *width* even in vertical layouts, where the
        time axis is the height.
      - Also from review: the important star's margin is logical, so it
        stays between star and name when set sideways; measurements are
        keyed by the title as rendered, not trimmed.
- [x] **Clear affordance that the stack axis scrolls when lanes
      overflow.** A count ("N more events stacked beyond the edge") and a
      fade already existed; exercising them in Chromium showed they
      mostly pointed the wrong way.
      - Found while doing it: with the base at the **bottom** (the
        default) or the **right**, an overflowing timeline opened at
        scroll position 0 -- the lanes *furthest* from the base -- with
        the base itself scrolled out of view, and the fade on the edge
        that had nothing past it. The view is now kept a fixed distance
        from the base (`stackOffsetFromScroll` / `scrollForStackOffset`,
        pure), re-applied whenever the stack's size or the layout changes,
        so it opens at the base and stays put as lanes come and go.
      - The note now says how many events are hidden **on each side**,
        and follows the scroll position ("34 more events above, 18
        below."), with a button per side that scrolls a view's worth
        (less a lane, for context) toward them, smoothly unless reduced
        motion is preferred. The old count assumed the view never moved.
        Counts were checked against the real DOM at several scroll
        positions. (`stackOverflow`: a partly visible lane counts as
        hidden.)
      - Each edge with events past it gets a cue -- a fade plus a chevron
        on its own surface-coloured disc (5.0:1, so it never depends on
        the colour of the fill behind it) -- in all four layouts. The old
        fade existed only for horizontal layouts, and only on one edge.
        The cues sit outside the scrolling box, so they stay put while
        it scrolls (the old sticky fade also added 24px of empty scroll).
      - Found while doing it: the stack axis could not be scrolled on a
        **touch screen** at all -- the canvas had `touch-action: none`
        for drag-to-pan, and the canvas fills the scroll area. Drags
        across the time axis are now left to the browser (`pan-y` /
        `pan-x`), so they scroll the stack, while drags along it still
        pan time. Verified with synthesized touch input in Chromium.
        Event labels keep `touch-action: none` (they drag both ways), so
        a swipe has to start on the background.
      - Simplification: the scroll state only re-renders the timeline
        when it changes which events are hidden, not every scroll frame.
      - Found in PR review and fixed: dragging an event re-ranked it by
        the pointer's position in the *viewport*, ignoring the scroll
        offset -- harmless while the view opened at scroll 0, but opening
        at the base made every drag of a base-lane event jump it ~28
        lanes. Lanes are now measured against the canvas. Also: the wheel
        both zoomed and scrolled the stack (React's wheel listener is
        passive, so `preventDefault` did nothing; now a native listener);
        a scroll button that ran out of events unmounted and dropped
        focus (both stay while overflowing, `aria-disabled` when empty);
        the per-side counts were a live region that re-announced at every
        lane while scrolling (the live region now says only how many
        don't fit, which scrolling doesn't change); the cues covered names
        in the outermost visible lane, focus ring included (now layered
        under names, over fills), and the scrollbar (now inset by its
        measured width); a second press during a smooth scroll went a page
        from wherever the animation was (now from where the first was
        headed); and a swipe reaching the end of the stack chained on to
        scroll the page (`overscroll-behavior: contain`).
      - Known trade-off: when the stack *doesn't* overflow, a vertical
        swipe over the timeline now scrolls the page (it previously did
        nothing). That is the expected behaviour for a page on a phone,
        and a horizontal swipe still pans time.
- [x] **Richer recurrence: `bySetPos`, `byMonthDay`, `byMonth`** ("first
      Monday of every month"). Schema, expansion and editor.
      - Monthly and yearly repeats get an "On" choice derived from the
        start: the same date, "the third Tuesday", "the last Friday" (when
        the start is in a month's final week), "the last day" (when it is
        a month's last; yearly, only for February -- otherwise it is just
        the date); yearly ones name the month. Moving the start keeps the
        kind of pattern ("the third Tuesday" moved to a Wednesday becomes
        "the third Wednesday"; a fifth Tuesday becomes the last), so the
        start is always an occurrence of its own series
        (`followStart`, pure). This applies to the editor **and** to
        dragging or keyboard-moving a series on the timeline, previews
        included. Changing the unit to or from months/years resets the
        pattern.
      - Simplification: no free-form day/month pickers ("the 1st and 15th",
        "only in summer"). The schema and expansion support them; a rule
        from another client that matches no offered pattern is shown by its
        description and kept as is (also when its start moves).
      - Found while doing it: rrule evaluates `BYDAY`/`BYMONTHDAY` in UTC,
        so "the first Monday" at 09:00 in Sydney (22:00 UTC on Sunday)
        repeated on Tuesdays -- and, found in review, a plain "day 31" set
        at 20:00 in New York (01:00 UTC on the 1st) repeated on every
        month's last day instead of skipping short months. Rules now carry
        an optional **`tzid`** and are evaluated on that zone's wall clock
        (`lib/zonedTime.ts`, `Intl` only; DST gaps resolve forward,
        repeated hours to the earlier one). Every monthly/yearly rule the
        editor writes sets it to the creator's zone, and patterns are read
        in the rule's zone when someone elsewhere edits or drags it, so
        everyone sharing the event sees the same instants. Rules without
        one run in UTC exactly as before -- adding a zone to existing
        series would move their post-DST occurrences by an hour and orphan
        their skipped dates. DST drift for plain daily/weekly repeats
        remains, under "Timezone edge cases" in the backlog. Privacy note:
        the zone travels inside the encrypted content, so the server
        learns nothing, but everyone the event is shared with learns the
        time zone it was set in -- inherent in "09:00 on the first Monday,
        there".
      - Found while doing it: **a rule that never matches freezes the
        page.** rrule walks to the year 9999 looking for a match, ignoring
        `until` (it only checks it against matches): ~0.5s per expansion
        for "the sixth Monday", ~7s for a daily "February 30th". The schema
        restricts calendar parts to monthly/yearly rules, requires
        `bySetPos` to have something to pick from and to stay within the
        most days a month or year can offer, and rejects days no chosen
        month has. Decrypted content isn't schema-checked anywhere and
        comes from whoever holds the edit token, so expansion re-validates
        the calendar fields and drops just the ones that fail (an unknown
        zone falls back to UTC; a bad position takes its weekday with it,
        so "the sixth Tuesday" doesn't become every Tuesday). For what
        validation can't see -- "every 12 months from January, only in
        February" -- it remembers per rule whether it ever occurs, so the
        walk is paid once, not on every render.
      - Found in review: validation ran on every expansion (every pan
        frame), so it is memoised per rule object; zoned expansion
        confirms each occurrence's offset with the previous one's instead
        of a full search, halving the `Intl` work.
- [x] **Single-occurrence overrides** (iCalendar `RECURRENCE-ID`): move
      one occurrence without splitting the series by hand. Opening an
      occurrence of a series you can edit offers "Change: every occurrence
      / only this one"; "only this one" edits that occurrence's start and
      end and records an `occurrenceOverrides` entry inside the encrypted
      content (`{ occurrence, startTime, endTime? }`, keyed by the start
      the rule gives it, like skips). The panel lists moved occurrences
      with "Put back"; moving one back to the series' times removes the
      entry. Nothing changes server-side.
      - Simplification: only times can differ. Title, importance and the
        rest belong to the series, so the timeline keeps one name per
        series.
      - A moved occurrence is shown wherever it was moved to (also into a
        window its original slot isn't in), and only while the series
        still occurs at its original start -- checked against the rule,
        remembered alongside the list for as long as the rule, start and
        zone stay the same -- so an entry left behind by a change to the
        series is ignored rather than resurrected, and isn't listed (saving
        another move drops it). A skip wins over a move; restoring the skip
        brings the move back. Decrypted content isn't schema-checked, so
        expansion and the panel take at most `MAX_OCCURRENCE_OVERRIDES`
        (200, also the schema's cap; the panel refuses a 201st) and drop
        entries with unreadable or backwards times.
      - **Moving a series now carries its skips and moves along** (editor,
        drag and keyboard alike) where that is exact: fixed-length repeats
        in UTC with no day filter. Before, any change to a series' start
        left its skips keyed to times it no longer had, so they silently
        stopped applying. Moved occurrences keep the times they were moved
        to.
      - A moved occurrence on the timeline has no drag handles or arrow
        keys: those change the whole series, which the moved occurrence
        doesn't follow. It is changed from its edit panel. (Superseded:
        they now change that occurrence alone -- see below.)
      - Found while doing it: the timeline handed the panel the clicked
        occurrence's *displayed* start, which for a moved one is not the
        occurrence it is -- "Skip this one" would have recorded a time the
        series never occurs at. It now passes the occurrence's identity
        (`recurrenceId`).
      - Known gaps: a moved occurrence couldn't be dragged on its own
        (since fixed, below); and a moved occurrence shares its series' single row, so
        one moved onto a sibling covers it. (Skips and moves of weekday,
        calendar pattern and zoned rules being left behind when the
        series' start moves was fixed by the next item.)
- [x] **Keep skips and moves attached when the start of a weekday,
      calendar pattern or zoned series moves** (`exceptionsFollowingStart`,
      pure; editor, drag and keyboard alike). Each exception goes to its
      occurrence's counterpart, worked out on the rule's own wall clock:
      - Fixed-length repeat, no day filter (zoned or not): moved by as much
        as the start. Exact, O(1), also across a change of clocks.
      - Chosen weekdays: moved by the whole weeks the start moved plus the
        change in its time of day. The days are the rule's, not the
        start's, so moving Monday's start to Tuesday leaves Wednesday's
        skip on Wednesday. Fortnightly (and slower) ones move by the
        calendar weeks between the starts, which decide which weeks the
        series falls in.
      - Monthly/yearly: the same occurrence (by rank) of the corresponding
        month or year -- September's third Tuesday to September's third
        Wednesday, 31 May to 30 May, 29 Feb 2032 to 28 Feb 2032. Moving
        the start into another month moves them as many months. In the
        series' first period, which its start may cut short, ranks count
        back from the period's end, so the first months of two series
        starting on different days still line up.
      - A moved occurrence keeps the time of day it was moved to and
        follows its occurrence by whole days, rounded (a series moved a
        week takes its moved occurrences with it; one nudged across
        midnight doesn't move them a day).
      - The rule after the move must be the same, or -- monthly/yearly --
        its pattern following the start: the same kind, or one
        `followStart` falls back to. That is checked by kind rather than
        against one `followStart`, because the editor follows the start
        one edit at a time and its fallbacks depend on the route. Any
        other change to the rule, a deliberate switch to another kind of
        pattern included, leaves exceptions where they are.
      - An exception that can't be placed (not an occurrence; no
        counterpart, e.g. the 31st moved into September; past the
        10,000-occurrence calendar walk, centuries of any offered pattern)
        is kept as it is, so a chosen time isn't lost -- unless the moved
        series has an occurrence at that instant, which it would wrongly
        start to apply to. Then it is dropped.
      - Cost: it runs on every drag frame. Calendar rules walk once per
        series on the rule's clock, converting only hits through `Intl`,
        and the old series' slots are remembered per saved event. Measured:
        a London-zoned monthly series with 100 skips over a century, ~9ms
        per frame; every other kind is O(1) per exception.
      - Found in review (of a first version that counted positions from
        the start): positions shifted May's skip of "the 31st" to April
        when moved to the 30th, and shifted every weekday exception one
        along when the start moved to a day the rule doesn't include; it
        deleted exceptions it couldn't place, chosen times included; the
        editor's step-by-step pattern was rejected; a capped walk silently
        undid far-out exceptions of zoned hourly series; and walking the
        new series through `Intl` cost ~170ms per frame.
      - Found in the second review and fixed: first-period ranks were
        counted from each series' own start (the 15th of a 1st-and-15th
        series lost its skip); a deliberate pattern change plus a nudge
        remapped exceptions; moved occurrences jumped a day when a nudge
        crossed midnight; fortnightly weekday series moved across a week
        boundary landed their exceptions in the wrong weeks; and an
        enormous decrypted skip list overflowed the stack via `Math.max`
        spreading. Raised but not a bug: calendar filters on a daily rule
        are dropped by expansion, so such a series moves like a plain
        daily one.
      - Known limitation: a daily, hourly or minutely series with chosen
        weekdays that repeats every few units leaves its exceptions where
        they are, since its phase doesn't follow weeks.
- [x] **Let dragging a moved occurrence move only that occurrence**
      (`applyTimelineChange`, pure). Drags, resize handles and arrow keys
      on a moved occurrence now change its override and nothing else; on
      any other occurrence they change the series, as before.
      - Its handles say so ("Adjust start of this occurrence of ..."), its
        label is described by its own key help, and announcements say
        "This occurrence of ... moved to ...". Priority stays the
        series' -- one row -- so up/down and dragging across lanes re-rank
        the series, announced under the series' name.
      - Dragged back exactly onto its slot (same start, the series'
        length), the override is removed rather than kept as a move to
        where it already was.
      - The arrow keys' target is fixed by the first press and kept until
        the label loses focus. The label rides on the first visible
        occurrence, so a moved occurrence nudged past a sibling hands the
        label (the same button, which keeps focus) over to it; further
        presses still move the occurrence they started on. Panning follows
        that occurrence rather than whichever one has the label.
      - Saves still in flight are now kept as the fields they change and
        later changes are applied on top (changes compose), replacing
        "merge the previews, re-derive from the saved event". The merge
        couldn't express a series move and an occurrence move in sequence:
        a series move remaps overrides, so the order they happen in
        matters.
      - Found in review and fixed: the keys' target outlived its label
        when the label scrolled away while focused (no blur fires), so a
        later press could write an override for an occurrence the series
        no longer has -- now reset on focus too, and dropped once that
        occurrence is off screen; the key help followed the occurrence
        carrying the label rather than what the keys would change; a series
        nudge panned to follow a moved occurrence that doesn't move with
        it; and failure announcements named the series for an occurrence
        drag.
      - Simplification: only the first visible occurrence has a label, so
        only that one can be moved (rather than resized) by dragging, or
        nudged with the keys -- exactly as for any series occurrence. Any
        moved occurrence can be resized by its handles, and moved from its
        edit panel.
- [x] **Undo for timeline drags** (one level). The last drag, resize or
      keyboard change on the timeline can be put back with an Undo button
      in the toolbar or Ctrl/Cmd+Z while focus is in the timeline.
      - Undo saves what the change replaced, only for the fields it
        changed (times, rank, recurrence, skips, overrides), on top of
        anything still in flight, queued like any other save. An end that
        Shift+arrow added is removed again; a moved occurrence gets its old
        override back and nothing else.
      - One level: each change replaces the entry, and undoing clears it
        (no redo; Shift+Ctrl+Z does nothing). A change that failed to save
        leaves nothing to undo.
      - Undo never overwrites a change made since: if the fields it would
        restore no longer hold what the change set (another device, the
        editor), it announces "Can't undo: ... has changed since" and does
        nothing. Changes to other fields (a renamed title) don't block it.
      - Pressed mid-nudge, the pending presses are saved first and then
        undone, so Undo always means "the change I just made". It works
        while that save is still in flight, queued behind it.
      - The button appears with the first change and then stays, disabled
        (`aria-disabled`) rather than removed, so pressing it doesn't drop
        focus. Its name says what it undoes ("Undo change to Standup");
        the outcome is announced in the timeline's live region.
      - Ctrl+Z in a form control (the layout selects) is left alone.
        Decision recorded: the Phase 8 note that Ctrl/Meta combinations
        are left to the browser is relaxed for Z alone -- browsers have no
        undo for a focused button, so nothing is taken away.
      - Simplification: the entry lives in the timeline component, so it
        is lost if the timeline unmounts (e.g. sign-out). Changes made in
        the edit panel aren't undoable here; the panel has its own Cancel.
      - Found while writing it: the first version only listened for
        Ctrl+Z once the button existed, so undoing the very first change
        while its presses were still pending did nothing.
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
