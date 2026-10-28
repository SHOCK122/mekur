# Schedule App

An open-source, end-to-end encrypted scheduling application. Self-hostable
via Docker, usable by both humans and agentic AI clients, and designed to
work on flaky connections and low-end devices.

**Status:** single-user scheduling, sharing, and the timeline work end to
end. Group scheduling (candidate slots + voting) is being rebuilt on the
capability model and is not currently available. See
[`docs/ROADMAP.md`](docs/ROADMAP.md) for what's built, what's deferred,
and what's next.

## What it does today

- **Timeline** — a real time axis from minutes to years, in four
  orientations, with a live present-time marker. Drag an event's edges to
  change its times, drag it away from the base to raise its priority.
- **Encrypted events** — title, times, location, notes and recurrence are
  encrypted on your device with a per-event key. The server stores
  ciphertext and never learns which events are yours.
- **Recurring events** — any interval ("every 37 minutes", "every 2
  weeks"), with an optional end date. Skip a single occurrence and restore
  it later.
- **Priority and importance** — stacking order uses fractional ranks (one
  write per reorder, no ties); "important" is a separate flag that changes
  styling only.
- **Sharing** — invite someone by username, or by their one-time friend
  code (which keeps both of you anonymous to each other), or hand out an
  event code. Invitations are sealed so the server can't tell who sent
  them. Connections and blocks stay on your device.
- **Works offline for reading** — the app shell and your last-synced
  schedule load with no network. Offline *editing* is on the roadmap.
- **Push notifications** — optional, deliberately generic ("Someone shared
  an event with you"): the server can't read your events, so it can't
  leak them.
- **Agent-friendly API** — API keys for programmatic clients; the REST
  surface is documented via OpenAPI at `GET /api/openapi.json`.

## Design principles

- **Encrypted by default, and no social graph.** Access is by capability
  token, not by account: the database holds no link between users and
  events. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the model
  and its honest limitations.
- **Self-hostable.** A single `docker compose up` runs the whole stack.
- **Measured, not asserted.** Statelessness is verified with two instances
  on one database, and throughput numbers are real measurements.
- **Honest about gaps.** Known limitations are written down in the roadmap
  rather than quietly omitted.

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

API tests run against a real PostgreSQL instance, not mocks (test files
run one at a time, since they share the database):

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
  ARCHITECTURE.md   threat model, keys, capability model, invitations, scaling
  ROADMAP.md        phase-by-phase status, decisions, known gaps
```

## Security notes

- Passwords never leave your device. A single scrypt run derives an auth
  key (proves your password to the server), an encryption key (encrypts
  your keyring), and an X25519 identity keypair (receives invitations).
- The server stores a hash of the auth key it receives — a leaked database
  alone isn't a usable login credential.
- Each event has its own random key; capability tokens are stored only as
  hashes. A database dump doesn't reveal who can reach which event.
- API keys can't mint further API keys; only a signed-in session can.
- **Known limitation:** your keys live in `localStorage` so a refresh
  doesn't sign you out, which means an XSS bug could read them. The page is
  served with a strict CSP to make that harder; proper hardening is tracked
  in the roadmap.
- **Known limitation:** public keys come from the server, so a malicious
  server could substitute its own. Key fingerprint verification is on the
  roadmap.

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
