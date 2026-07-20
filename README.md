# Schedule App

An open-source, end-to-end encrypted scheduling application. Self-hostable
via Docker, designed to scale from a handful of users to very large
deployments without re-architecting, and usable by both humans and
agentic AI clients through a documented HTTP API.

**Status:** early development (Phase 1 of the roadmap — see
[`docs/ROADMAP.md`](docs/ROADMAP.md)).

## Design principles

- **Encrypted by default.** Event content (titles, descriptions, locations,
  times) is encrypted client-side before it ever reaches the server. The
  server stores and relays ciphertext; it does not hold the keys needed to
  read it. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full
  threat model and the group-scheduling design.
- **Client-side data ownership.** Wherever practical, the canonical copy of
  a user's data lives on their device; the server is a sync/relay point,
  not the source of truth.
- **Self-hostable.** A single `docker compose up` runs the full stack.
- **Built to scale.** Stateless services behind a load balancer, a
  horizontally-scalable data layer, and a design that doesn't need
  rearchitecting to go from 100 users to many millions.
- **Agent-friendly.** A documented REST API (OpenAPI spec, added in a later
  phase) so AI agents can schedule on equal footing with human clients.

## Project structure

```
apps/
  api/      Fastify backend (TypeScript)
  web/      Progressive Web App client (React + Vite)
packages/
  shared/   Shared types and validation schemas (Zod)
  crypto/   Client-side encryption primitives (X25519, XChaCha20-Poly1305, scrypt)
infra/
  Dockerfile.api, Dockerfile.web, nginx.conf
docs/
  ARCHITECTURE.md, ROADMAP.md
```

## Quick start (development)

Requires Node.js 22+.

```bash
npm install
npm run test        # run every package's test suite
npm run typecheck    # typecheck every package

# run the API directly
cd apps/api && npm run dev

# run the web client directly (in another terminal)
cd apps/web && npm run dev
```

## Quick start (Docker)

```bash
docker compose up --build
```

This builds and starts:
- `api` — the backend, internal port 3000 (not published to the host)
- `web` — the PWA served by nginx, published at http://localhost:8080,
  which reverse-proxies `/api/*` to the `api` service

> Note: the Dockerfiles and compose file have been validated by manually
> reproducing each build stage's dependency/build/runtime steps outside of
> Docker in this environment (which has no Docker daemon available). They
> have not yet been verified with an actual `docker build`/`docker compose
> up` — please do that verification on your end before relying on it, and
> report back anything that doesn't work.

## Contributing

This project is early and its architecture is still settling. See
[`docs/ROADMAP.md`](docs/ROADMAP.md) for the current phase and what's next.

## License

AGPL-3.0-or-later. This copyleft license is chosen deliberately for a
self-hostable service: it ensures that anyone who runs a modified version
of this app as a network service must also share their modifications. If
you'd prefer a more permissive license (e.g. MIT/Apache-2.0) for wider
adoption at the cost of that guarantee, that's an easy one-line change to
revisit before the project has outside contributors.
