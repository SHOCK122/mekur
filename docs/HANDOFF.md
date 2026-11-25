# Handoff: state of the project (2026-11-25)

For a new Claude Code instance picking this project up in the dev
container on a self-hosted Linux server. Working rules are in `CLAUDE.md`;
read this, then the open items in `docs/ROADMAP.md`, and
`docs/ARCHITECTURE.md` before touching encryption, capabilities or the
data model. Update or delete this file once it's stale; the
roadmap is the long-lived record.

## Where things stand

- `main` is green: 503 tests pass (crypto 22, shared 29, api 62,
  web 390), typecheck is clean, and both production builds work.
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
4. The two remaining major upgrades under Maintenance in the roadmap
   (`zod` 4, then `vite-plugin-pwa` 2), and Dependabot's PRs as they
   arrive.
5. Then Phase 9 (sync efficiency and offline writes) per the roadmap.

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
   with a fine-grained token scoped to `SHOCK122/mekur` only, so Claude
   can open and watch PRs.
4. **Check it:** `npm run typecheck && npm run test && npm run build`
   should match the counts above.
5. **On your PC, in VS Code's settings:** set
   `remote.SSH.enableAgentForwarding` to `false` and stop Dev Containers
   sharing your Git credentials
   (`dev.containers.gitCredentialHelperConfigLocation`: `none`). Otherwise
   your PC's SSH agent reaches into the container, and with it a way to
   log in to the server itself. After rebuilding, `echo $SSH_AUTH_SOCK`
   in the container should print nothing.

**Running Claude unattended.** Start it with `claude-unattended` instead
of `claude`. That skips the per-command permission prompts, but only after
checking that the container's outbound firewall is up and that the dev
user can't use sudo to switch it off; otherwise it refuses to start.

- The firewall (`.devcontainer/init-firewall.sh`) runs on every container
  start. It refuses all outbound traffic except DNS, loopback (where
  PostgreSQL lives) and: npm's registry, GitHub, Anthropic's API and
  sign-in, and VS Code's extension and update servers. The LAN, the
  Docker host and the server's other services are unreachable. It was
  tested in isolated network namespaces, not yet in a real container.
- The dev user's sudo allows that script and nothing else, so Claude
  can't install system packages. If something needs another host or
  package, change `.devcontainer/` yourself and rebuild.
- Hosts are resolved to IP addresses once, at start. If npm or GitHub
  stops working after a while (a CDN moved), run
  `sudo /usr/local/bin/init-firewall.sh` again.
- If signing in to Claude fails behind the firewall, the sign-in may use
  a host the allowlist is missing. Check which one is refused and add it
  to `ALLOWED_DOMAINS`.
- What it can't prevent: Claude can still send data to the allowed hosts
  (for example, push to GitHub) and over DNS. Keep the GitHub token
  limited to this repository, and protect `main` in GitHub's settings
  (require a PR and passing CI), so nothing lands there without review.

**Rebuilding.** Day to day, no rebuild is needed: code changes, `npm`
installs and restarts don't require one. Rebuild (**Dev Containers:
Rebuild Container**) for Ubuntu security patches and changes to
`.devcontainer/`, roughly monthly or when a Dependabot PR touches
`.devcontainer/`. A rebuild also installs the latest Claude Code; check
`claude --version` now and then in case it isn't updating itself in place. Review any diff to
`.devcontainer/` before rebuilding: a rebuild applies whatever it says,
including permissions.

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
  proxies `/api/*` to it. docker-compose sets `TRUST_PROXY=uniquelocal`,
  so the API believes `X-Forwarded-For` only from private addresses. That
  still works with another reverse proxy in front, provided it reaches
  nginx from a private address. Behind Cloudflare, have the outer proxy
  restore the real client IP (nginx's `real_ip` module with
  `CF-Connecting-IP`), or every user appears as one of a few Cloudflare
  addresses and they share rate limits.
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
