# Handoff: state of the project (2026-11-25)

For a new Claude Code instance picking this project up on a self-hosted
Linux server. Read this, then the open items in `docs/ROADMAP.md`, and
`docs/ARCHITECTURE.md` before touching encryption, capabilities or the
data model. Update or delete this file once it's stale; the
roadmap is the long-lived record.

## Where things stand

- `main` at `078ab0d` is green: 499 tests pass (crypto 22, shared 29,
  api 58, web 390), typecheck is clean, and both production builds work.
  Verified on Node 22.22 with PostgreSQL 16.
- **Working end to end:** registration and login; encrypted events on a
  timeline (minutes-to-years zoom, four orientations, drag and keyboard
  editing, undo); recurrence including monthly/yearly patterns, time
  zones, skipping and moving single occurrences; sharing by username,
  one-time friend code or event code with sealed invitations; push
  notifications; API keys.
- **Not built:** group scheduling (Phase 10), offline *writes* (Phase 9;
  offline reading works), and the key-storage hardening (Phase 11).

## History a new instance can't see

1. **Phases 0-6:** scaffolding, single-user scheduling, an ACL-based
   multi-user model, scale and security passes.
2. **Capability model (pre-#2):** the ACL model leaked who-schedules-with-
   whom, so it was replaced: events have no owner, access is by token,
   each account keeps an encrypted keyring. See ARCHITECTURE.md.
3. **#2, Phase 7:** consolidated the code on that model, removed the old
   model's leftovers (migration 007), and fixed what the switch broke,
   most importantly invitations, which recipients could never open.
4. **#3-#12, Phase 8:** timeline and recurrence work, all merged. Only one
   Phase 8 item remains open (see below).
5. **#13-#20, Rust migration, then #21 reverting it.** The API was
   being ported to Rust step by step; on 2026-11-25 the owner decided
   against it, and #21 restored the tree byte-for-byte to `705d75c`
   (the commit before the port began). The reason isn't recorded in the
   repo. Treat TypeScript as settled, and ask the owner before proposing
   another language migration.

All PRs except #1 are merged. Branches named `claude/*` on the remote are
leftovers from squash-merged PRs: their commits *look* unmerged but their
content is on `main`. They can be deleted.

## First tasks

1. **Port the two remaining fixes from PR #1, then close it.** PR #1
   (`cleanup/dead-code-and-stale-openapi`, commit `7a32722`) predates the
   capability-model refactor. Most of it was superseded by #2, and its
   `CLAUDE.md` describes code that no longer exists (don't merge it). Two
   fixes in it never reached `main`:
   - **Web tests vs. newer Node.** On some Node versions, Node's own
     experimental global `localStorage` shadows jsdom's, and ~42 web
     tests failed silently in PR #1's testing. The fix there is an
     in-memory `Storage` polyfill in `apps/web/test/setup.ts`. Do this
     first if the server runs anything newer than Node 22.
   - **Focus stealing.** `EventEditPanel` moves focus to the title 180ms
     after opening, even if the user has already started typing in
     another field. The fix only focuses the title if nothing inside the
     panel is focused yet.

   Port both by hand (the files have changed since), each with a test,
   then close #1 with a note that the rest was superseded by #2.
2. **Confirm before deleting.** "Delete" on a one-off event in the edit
   panel deletes it for *everyone* it's shared with, with no
   confirmation. Found in the #2 review, never picked up.
3. **Phase 8's last item:** decide how a view-only event looks on the
   timeline (today it differs only by lacking resize handles).
4. Then Phase 9 (sync efficiency and offline writes) per the roadmap.

## Rules that are easy to break

- **Never make the server answer "which events does this user have".** It
  is unanswerable by design; the client's encrypted keyring is the index.
  Anything that records user-to-event or user-to-user links in plaintext
  (tables, columns, logs) reintroduces the leak the capability model
  exists to prevent. Inbox messages have no sender column for this reason.
- A wrong or missing capability returns **404, never 403**, so ids can't
  be probed.
- The API is stateless (proven with two instances on one database): no
  in-process caches or sessions.
- Every list endpoint stays bounded (batch read 500, inbox 200).
- API tests run against a real Postgres, never mocks, and the files run
  **serially** (`apps/api/vitest.config.ts`) because they share one
  database. Turning file parallelism back on brings back intermittent 401s.
- Tests avoid real scrypt (~2s each) except one end-to-end login test: use
  `apps/web/test/testSession.ts` and `registerUser` in
  `apps/api/test/testHelpers.ts`.
- `apps/api/src/openapi.ts` is hand-written; a test fails if it drifts
  from the registered routes. Migrations are new numbered SQL files, never
  edits to applied ones.
- UI must work by keyboard and screen reader. Measured contrast and density
  constraints are at the bottom of the roadmap; don't re-derive them.
- Accepted gaps (keys in `localStorage`, server-supplied public keys, no
  offline writes) are tracked in the roadmap; don't "fix" them as a side
  effect of other work.

## How work has been done

- One roadmap item per branch and PR; each fix gets a regression test that
  fails without it.
- Every feature ends with a **bughunt**: actually run it (Playwright drives
  Chromium for UI), not just re-read the code. Findings go in the roadmap
  item.
- PRs get a review pass; review fixes go in a follow-up commit on the same
  branch; PRs are squash-merged once CI is green.
- Keep the roadmap, ARCHITECTURE.md and README truthful, in the same change
  that would make them wrong.

## Setting up the server

Needs: git, Node.js 22, Docker (with the compose plugin), and Claude Code.

```bash
git clone https://github.com/SHOCK122/mekur.git && cd mekur
npm ci

# Postgres for the API tests (they use a real database, never mocks)
docker run -d --name mekur-test-db -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=scheduleapp_test postgres:16-alpine

npm run test && npm run typecheck && npm run build
```

If Claude Code itself runs inside a container, `localhost:5432` won't
reach a database container started beside it. Put both on one Docker
network and set
`TEST_DATABASE_URL=postgres://postgres:postgres@mekur-test-db:5432/scheduleapp_test`.

To run the full stack:

```bash
cp .env.example .env
openssl rand -base64 48            # -> JWT_SECRET
npx web-push generate-vapid-keys   # -> VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
# also set POSTGRES_PASSWORD and VAPID_SUBJECT
docker compose up --build          # http://localhost:3080
```

- The API container isn't published; nginx serves the web build and
  proxies `/api/*` to it. `TRUST_PROXY=1` is set in docker-compose for
  that one hop. If you put another reverse proxy (TLS) in front, raise it
  to 2, or every user shares one rate-limit bucket.
- Migrations run automatically when the API starts.
- Web Push needs HTTPS (or localhost) in the browser.
- For UI bughunts, install Playwright with Chromium
  (`npx playwright install --with-deps chromium`). It was preinstalled
  in the cloud sessions used so far.

**Not yet verified anywhere:** `docker compose up` itself. CI builds both
images (green), but nobody has run the stack and checked it serves the app
with the nginx security headers. Worth doing once on the new server.

## Things that were true of the old environment

The previous work ran in Claude Code cloud sessions. These won't carry over:

- The sandbox reset once and lost unpushed commits: push after each
  meaningful commit.
- Each session got a branch named `claude/<name>`, opened a PR, watched
  CI, and the owner either merged or asked Claude to review and merge
  (squash). GitHub access went through an MCP integration; on the server
  that will be `gh` or whatever is configured instead.
