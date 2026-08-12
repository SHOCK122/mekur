# Schedule App

An open-source, end-to-end encrypted scheduling application. Self-hostable
via Docker, usable by both humans and agentic AI clients, and designed to
work on flaky connections and low-end devices.

**Status:** Phases 0–3 complete and working. See
[`docs/ROADMAP.md`](docs/ROADMAP.md) for what's built, what's deliberately
deferred, and what's next.

## What it does today

- **Personal calendar** — create, edit, and delete events. Event content
  (title, times, location, notes) is encrypted on your device before it
  ever reaches the server.
- **Recurring events** — arbitrary intervals ("every 37 minutes"), daily,
  weekly, or specific weekdays, using the iCalendar RRULE model.
- **Priorities** — bump an event up, or push it down (which raises
  everything else instead). No raw numbers shown.
- **Group scheduling** — propose several candidate times, invite people,
  everyone ranks the options, and the app picks the best slot. The server
  only ever sees opaque slot IDs and rank numbers — never the real times
  or the event's content.
- **Works offline** — the app shell, your event data, *and* your edits.
  Changes made offline queue up and replay when you reconnect, with real
  conflict detection rather than silently overwriting another device.
- **Push notifications** — optional browser notifications for group event
  invites and resolutions.
- **Agent-friendly API** — mint API keys for programmatic/AI clients; the
  full REST surface is documented via OpenAPI at `GET /api/openapi.json`.

## Design principles

- **Encrypted by default.** Event content is encrypted client-side before
  it reaches the server. The server stores and relays ciphertext; it does
  not hold the keys needed to read it. Group scheduling uses per-event
  keys wrapped individually to each participant via X25519 ECDH. See
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full model and
  its honest limitations.
- **Self-hostable.** A single `docker compose up` runs the whole stack.
- **Built to scale, and actually measured.** Statelessness is verified
  (two instances against one database, tokens and data interchangeable),
  not just asserted, and throughput numbers are real measurements rather
  than aspirations.
- **Honest about gaps.** Known limitations and deliberate simplifications
  are written down in the roadmap rather than quietly omitted.

## Quick start (Docker)

```bash
git clone https://github.com/SHOCK122/mekur.git
cd mekur
cp .env.example .env
```

Then edit `.env` and set real values — the stack intentionally refuses to
start with placeholders:

```bash
# a long random string
openssl rand -base64 48

# a VAPID keypair for push notifications
npx web-push generate-vapid-keys
```

```bash
docker compose up --build
```

Open **http://localhost:3080**. Register an account and you're going.

> The API container isn't published to the host — nginx serves the app and
> reverse-proxies `/api/*` to it over the internal Docker network.

## Quick start (development)

Requires Node.js 22+ and a local PostgreSQL.

```bash
npm install
npm run test        # every package's test suite
npm run typecheck   # typecheck every package

cd apps/api && npm run dev    # API on :3000
cd apps/web && npm run dev    # PWA (Vite prints the URL), proxies /api to :3000
```

Tests run against a real PostgreSQL instance, not mocks:

```bash
createdb scheduleapp_test
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/scheduleapp_test npm run test
```

Load testing against a running instance:

```bash
cd apps/api && BASE_URL=http://localhost:3000 npm run loadtest
```

## Project structure

```
apps/
  api/      Fastify backend (TypeScript, PostgreSQL)
  web/      Progressive Web App client (React + Vite)
packages/
  shared/   Shared types and validation schemas (Zod)
  crypto/   Client-side encryption (X25519, XChaCha20-Poly1305, scrypt, HKDF)
infra/
  Dockerfile.api, Dockerfile.web, nginx.conf
docs/
  ARCHITECTURE.md   encryption model, scaling, offline sync
  ROADMAP.md        phase-by-phase status, decisions, known gaps
```

## Security notes

- Passwords never leave your device. A single scrypt run derives three
  domain-separated keys: one to prove your identity to the server, one to
  encrypt your data, and an X25519 identity keypair for sharing.
- The server stores a hash of the auth key it receives — a leaked database
  alone isn't a usable login credential.
- **Known limitation:** the encryption key currently lives in
  `localStorage` so a page refresh doesn't log you out, which means an XSS
  bug could read it. Hardening options are tracked in the roadmap.
- Push notification payloads are deliberately generic ("You've been
  invited to a group event") — the server never has your event titles, so
  it can't leak them even by accident.

## Contributing

The architecture is still settling. [`docs/ROADMAP.md`](docs/ROADMAP.md)
tracks the current phase, decisions made along the way, and known gaps.

Every phase ends with a bughunt pass — actually exercising what was built,
not just re-reading it — with regression tests for anything found. Several
real bugs have been caught this way.

## License

AGPL-3.0-or-later. Chosen deliberately for a self-hostable service: anyone
running a modified version as a network service must also share their
modifications.
