# Handoff: state of the project (2026-11-25)

For a new Claude Code instance picking this project up in the dev
container on a self-hosted Linux server. Working rules are in `CLAUDE.md`;
read this, then the open items in `docs/ROADMAP.md`, and
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

## Setting up the server

Development happens in the dev container (`.devcontainer/`), opened from
VS Code over SSH. The container has Node 22, the GitHub CLI and Claude
Code, and shares its network with a PostgreSQL 16 container. On first
create it runs `npm ci` and creates the `scheduleapp_test` database, so
`npm run test` works with no further setup.

1. **On the server:** install Docker Engine with the compose plugin, add
   your SSH user to the `docker` group, and clone the repo:
   `git clone https://github.com/SHOCK122/mekur.git`.
2. **In VS Code on your own machine:** install the *Remote - SSH* and
   *Dev Containers* extensions, connect to the server, open the `mekur`
   folder, and run **Dev Containers: Reopen in Container**.
3. **In the container's terminal:** run `claude` and log in. The login
   lives in a named volume, so it survives rebuilds. Run `gh auth login`
   so Claude can open and watch PRs.
4. **Check it:** `npm run typecheck && npm run test && npm run build`
   should match the counts above.

The dev servers (`npm run dev` in `apps/api` and `apps/web`) are
forwarded to your machine by VS Code: open the forwarded 5173.

**Full production stack.** Docker isn't available inside the dev
container on purpose: giving it the host's Docker socket would give
Claude root on the server. Create `.env` inside the dev container (it has
Node, and the folder is shared with the host), then start the stack from a
plain SSH terminal on the server:

```bash
# in the dev container
cp .env.example .env
openssl rand -base64 48            # -> JWT_SECRET
npx web-push generate-vapid-keys   # -> VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
# also set POSTGRES_PASSWORD and VAPID_SUBJECT

# on the server, in the cloned mekur folder
docker compose up --build          # http://<server>:3080
```

- The API container isn't published; nginx serves the web build and
  proxies `/api/*` to it. `TRUST_PROXY=1` is set in docker-compose for
  that one hop. If you put another reverse proxy (TLS) in front, raise it
  to 2, or every user shares one rate-limit bucket.
- Port 3080 is published on the server itself. Close it in the firewall
  or put TLS in front before anyone else can reach it.
- Migrations run automatically when the API starts.
- Web Push needs HTTPS (or localhost) in the browser.
- For UI bughunts, install Playwright with Chromium inside the dev
  container (`npx playwright install --with-deps chromium`).

**Not yet verified anywhere:** the dev container build and
`docker compose up`. CI builds both production images (green), but nobody
has run either on a real Docker host. Worth checking once on the new
server.

## Things that were true of the old environment

The previous work ran in Claude Code cloud sessions. These won't carry over:

- The sandbox reset once and lost unpushed commits: push after each
  meaningful commit.
- Each session got a branch named `claude/<name>`, opened a PR, watched
  CI, and the owner either merged or asked Claude to review and merge
  (squash). GitHub access went through an MCP integration; on the server
  that will be `gh` or whatever is configured instead.
