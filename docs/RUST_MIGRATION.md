# Rust migration

mekur is moving from TypeScript to Rust. This file is the plan, the
progress tracker and the record of parity decisions. All new code is
written in Rust; existing TypeScript is replaced one module at a time.

## Rules

1. **Straight port.** External behaviour, the HTTP API (paths, status
   codes, response bodies, headers), the database schema and every
   on-the-wire / ciphertext format stay identical, so Rust and the
   remaining TypeScript interoperate at every step. Improvements wait for
   a later, separate PR.
2. **Tests move with the code.** A module's tests are ported to Rust
   alongside it. The TypeScript module and its tests are deleted only once
   the Rust replacement passes the ported tests *and* the full suite (Rust
   and remaining TS). No coverage is dropped on the way.
3. **Conventions are translated, not dropped.**
   - TDD against a real local PostgreSQL for API work (sqlx), never mocks.
   - `mekur-shared` takes the role of the Zod schemas: serde types plus
     explicit validation functions.
   - Repositories stay constructor/factory functions returning a struct
     (or trait object); route handlers stay thin.
4. **No hand-rolled cryptography.** Audited crates only (RustCrypto).
   Decryption stays client-side (WebAssembly). The encryption boundaries in
   `docs/ARCHITECTURE.md` do not change with the language.
5. **No `unsafe`.** The workspace sets `unsafe_code = "forbid"`. If a crate
   ever truly needs it, relax the lint for that crate only, justify it in a
   comment, and say why in the PR description.
6. **One unit per PR.** A port is its own PR; a roadmap feature touching a
   not-yet-ported TS module waits until that module is ported.
7. Every PR runs `cargo fmt --check`, `cargo clippy -D warnings`,
   `cargo test`, and -- while TypeScript remains -- `npm run typecheck`
   and `npm run test`.

## Inventory (TypeScript, at the start of the migration)

| Package / module | Lines (src) | Role | Tests |
|---|---|---|---|
| `packages/shared` | ~230 | Zod schemas: `EncryptedEnvelope`, `SealedEnvelope`, `KeyringEnvelope`, `RecurrenceRule`, `OccurrenceOverride`, `EventContent`; `isValidTimeZone`; `MAX_OCCURRENCE_OVERRIDES` | `test/index.test.ts` |
| `packages/crypto` | ~260 | scrypt->HKDF key derivation, XChaCha20-Poly1305 envelopes, X25519 sealed envelopes with optional sender proof, base64 helpers | `test/index.test.ts` |
| `apps/api` `db/` | ~90 | pg pool; migration runner (advisory lock, `schema_migrations`); SQL migrations 001-007 | `migrationConcurrency.test.ts` |
| `apps/api` `lib/` | ~80 | capability tokens and hashes, API-key format and hashes, UUID param check | (via route tests) |
| `apps/api` `plugins/auth.ts` | ~60 | JWT (HS256, `{userId}`, 30d) or `sak_` API key -> `userId`, `authMethod` | `auth.test.ts`, `apiKeys.test.ts` |
| `apps/api` repositories (7) | ~630 | users, events, API keys, push subscriptions, friend codes, keyrings, inbox | route tests |
| `apps/api` routes (7) | ~530 | auth, events (capabilities, batch read), API keys, push, social, keyring, inbox | `capabilities`, `social`, `pushNotifications`, `security`, `publicKeyRepair`, `health` tests |
| `apps/api` `app.ts`, `server.ts`, `config.ts`, `openapi.ts` | ~550 | wiring: helmet headers, rate limits, 256 KB body limit, empty-JSON-body-as-`{}`, config checks, OpenAPI document | `health.test.ts`, `security.test.ts` |
| `apps/api` `services/notificationService.ts` | ~60 | Web Push (VAPID), generic payloads only | `pushNotifications.test.ts` |
| `apps/web/src/lib` | ~2,600 | `fractionalRank`, `zonedTime`, `datetime`, `recurrence` (on `rrule`), `timeline`, `timelineInteraction`, `eventCache`, `http`, `api`, `session`, `events`, `keyring`, `social`, `push` | matching `apps/web/test/*.test.ts` |
| `apps/web/src/hooks`, `components`, `sw.ts` | ~3,000 | React UI, the 1,400-line `Timeline`, service worker | `*.test.tsx` incl. accessibility |

## Target workspace

```
Cargo.toml              workspace root (resolver 3, edition 2024, shared lints)
rust-toolchain.toml     pinned toolchain + rustfmt, clippy, wasm32 target
crates/
  shared/   mekur-shared   types + validation      <- packages/shared
  crypto/   mekur-crypto   client cryptography     <- packages/crypto
  api/      mekur-api      axum HTTP server         <- apps/api
  client/   mekur-client   browser logic -> wasm    <- apps/web/src/lib (then UI)
```

Dependency direction: `shared` <- `crypto` <- `client`; `shared` <- `api`.
`api` must never depend on `crypto`'s decryption: the server needs only
hashing (`sha2`) and never holds a key that opens user content. The one
crypto call the API makes today (`sha256Base64` of the auth key) becomes a
direct `sha2` call.

`crates/` sits beside `apps/` and `packages/` rather than inside them so
the two toolchains never share a directory during the transition. When a
TS package is fully gone, its directory is deleted, not left empty.

## Crate choices

| Need | Crate | Notes |
|---|---|---|
| Serialization | `serde`, `serde_json` | No `deny_unknown_fields`: Zod objects strip unknown keys rather than rejecting them. |
| Validation | hand-written `validate()` per type | Explicit, mirrors each Zod refinement one-to-one; no derive-macro framework whose rules drift from Zod's. |
| Dates, zones | `chrono`, `chrono-tz` | IANA data is bundled at build time rather than read from the runtime's `Intl`; pin and note the tzdata version. |
| AEAD | `chacha20poly1305` (`XChaCha20Poly1305`) | RustCrypto. |
| X25519 | `x25519-dalek` | Check `SharedSecret::was_contributory()`: noble rejects an all-zero shared secret, so the port must too. |
| KDF | `scrypt`, `hkdf`, `sha2`, `hmac` | RustCrypto. |
| Constant time | `subtle` | Sender-proof comparison. |
| Randomness | `rand_core` `OsRng` / `getrandom` | `getrandom`'s wasm backend (`wasm_js`) in the client. |
| Secrets in memory | `zeroize` | |
| Password normalisation | `unicode-normalization` | Passwords are NFKC-normalised before scrypt. |
| Base64 | `base64` | See parity: Node's decoder is lenient. |
| HTTP server | `axum`, `tokio`, `tower`, `tower-http` | `tower-http` for body limit and security headers (helmet's set). |
| Database | `sqlx` (postgres, tokio, rustls, uuid, chrono) | Runtime-checked `query_as` + tests against real Postgres; revisit compile-time `query!` (needs committed `.sqlx` offline data) once the API is ported. |
| JWT | `jsonwebtoken` (HS256) | Must accept tokens the TS server issued and vice versa during the side-by-side phase. |
| Rate limiting | `tower_governor` | Per-IP, honouring `TRUST_PROXY` hops. |
| Web Push | `web-push` crate (VAPID) | Evaluate maintenance when the push slice is ported; fall back to `web-push-native`. |
| Errors, logs | `thiserror`, `tracing` | `anyhow` only in the binary. |
| WebAssembly | `wasm-bindgen`, `serde-wasm-bindgen`, `wasm-bindgen-test`, `wasm-pack` | `mekur-client` is `cdylib` + `rlib`. |
| UI (later) | Leptos (CSR) -- *recommendation, not yet decided* | Decided in its own PR once `lib/` is ported; see step 5. |

## Port order (leaves first)

Each numbered item is one PR unless noted. Check items off as they merge,
with a line on anything simplified or discovered.

### 0. Plan, workspace skeleton, CI
- [x] This document; `Cargo.toml` workspace with empty `mekur-shared`,
  `mekur-crypto`, `mekur-api`, `mekur-client`; pinned toolchain;
  `unsafe_code = "forbid"`; CI job running fmt, clippy (native and
  wasm32), tests and a wasm32 build. (Postgres is added to that job in
  3a, with its first consumer.)

### 1. `mekur-shared` <- `packages/shared`
- [ ] Types and validation for every schema, `MAX_OCCURRENCE_OVERRIDES`,
  time-zone check; port `packages/shared/test/index.test.ts`.
- The TS package keeps serving its TS consumers until step 4 / step 3
  remove them; it is deleted when its last importer is gone.
- Decide (and record here) whether validation errors reproduce Zod's
  `issues` array exactly. The API returns
  `{ error: "Invalid request", details: issues }` and the web client's
  `http.ts` formats `details` into user-visible messages, so at minimum
  `path` and `message` must match.

### 2. `mekur-crypto` <- `packages/crypto`
- [ ] `derive_auth_and_encryption_keys`, `encrypt_envelope` /
  `decrypt_envelope`, `seal_to_recipient` / `open_sealed`, keypair
  generation, `sha256_base64`; port `packages/crypto/test/index.test.ts`.
- [ ] **Cross-language vectors**: a small script (run once, output
  committed as a fixture) has the TS package derive keys from a fixed
  password + salt, and produce envelopes and sealed envelopes (named and
  anonymous). The Rust tests must reproduce the derived keys exactly and
  open every TS-made envelope; Rust-made envelopes are opened by a TS test
  in the same PR.
- TS package deleted at step 4 (its last importer is the web client).

### 3. `mekur-api` <- `apps/api`, route group by route group
Side-by-side ("strangler") deployment: nginx sends each ported route
group to the Rust server and everything else to the TS server. Both use
the same database and the same `JWT_SECRET`. After each slice the TS
routes, repository and tests for that group are deleted.

- [ ] **3a. Foundation**: config (same variables, same production
  guards), pool, migration runner, `GET /health`, `GET /openapi.json`,
  security headers, 256 KB body limit, empty JSON body as `{}`, 404 and
  parse-error bodies, rate limiting; Rust test harness (real Postgres,
  truncate between tests, tests serialised, `RUST_TEST_DATABASE_URL`);
  a Postgres service in the `rust` CI job; Docker image for the Rust
  server; nginx + Vite proxy split. Port `health.test.ts`,
  `migrationConcurrency.test.ts` and the header/body-limit parts of
  `security.test.ts`.
- [ ] **3b. Auth**: auth extractor (JWT + `sak_` API keys), users
  repository, `authRoutes`. Port `auth.test.ts`, `publicKeyRepair.test.ts`.
- [ ] **3c. API keys**: repository + routes. Port `apiKeys.test.ts`.
- [ ] **3d. Events & capabilities**: repository + routes incl. batch read
  (one query per request, max 500). Port `capabilities.test.ts`.
- [ ] **3e. Keyring**: repository + routes (versioned, 409 on conflict,
  1.5 MB body limit on `PUT`).
- [ ] **3f. Social**: friend codes, tag resolution. Port `social.test.ts`.
- [ ] **3g. Inbox + push**: inbox repository/routes (newest 200 only --
  every list stays bounded), push subscriptions,
  notification service. Port `pushNotifications.test.ts` and the rest of
  `security.test.ts`. Then delete `apps/api` and the TS server from
  `docker-compose.yml`; the Rust server takes over running migrations.

### 4. `mekur-client` <- `apps/web/src/lib`, leaves first
Each module is exposed to the React app via wasm-bindgen (built with
`wasm-pack --target bundler` and imported like any package), and its TS
tests are ported to Rust (`cargo test` for pure logic,
`wasm-bindgen-test` where the browser matters).

- [ ] 4a. `fractionalRank`
- [ ] 4b. `zonedTime`, `datetime`
- [ ] 4c. `recurrence` -- the largest and riskiest port (replaces the
  `rrule` npm package). Compare against the Rust `rrule` crate, but only
  adopt it if all 1,200 lines of `recurrence.test.ts` pass unchanged in
  meaning; otherwise port the expansion directly.
- [ ] 4d. `timeline`, `timelineInteraction`
- [ ] 4e. `events`, `keyring`, `social`, `session`, `api`, `http`,
  `eventCache`, `push` -- the crypto call sites. After this nothing
  imports `packages/crypto` or `packages/shared`: delete both.

### 5. UI
- [ ] Decide the UI approach in a short ADR here (recommendation: Leptos,
  client-side rendered). Must keep every accessibility guarantee the
  current component tests assert; port those tests first.
- [ ] Port components (Timeline last), hooks, service worker. Then delete
  `apps/web`'s TypeScript and the Node toolchain from CI.

## Parity hazards (check every port against these)

**Validation (`mekur-shared`)**
- Zod's `.max(n)` on strings counts **UTF-16 code units**, not bytes or
  chars: use `s.encode_utf16().count()`.
- `z.string().datetime()` (Zod 3.25) accepts `YYYY-MM-DDTHH:MM[:SS[.f+]]Z`:
  seconds are **optional** (`2024-01-01T10:00Z` is valid), any number of
  fractional digits, a trailing `Z` only (no `+02:00` offsets, no space
  separator), and real calendar dates only (`2024-02-29` yes, `2023-02-29`
  and `02-30` no). chrono's RFC 3339 parser requires seconds and accepts
  offsets, so it cannot be used as-is.
- `isValidTimeZone` asks `Intl.DateTimeFormat`, which accepts zone names in
  **any letter case** (`america/new_york`, `utc`), legacy aliases
  (`US/Eastern`, `EST`) and **offset zones** (`+05:00`). `chrono_tz::Tz::
  from_str` is case-sensitive and has no offset zones: match
  case-insensitively and accept `±HH:MM` offsets, or stored rules start
  failing validation. Recurrence expansion must then resolve the same
  names the same way.
- Instants are compared at **millisecond** precision (`new Date(x)
  .getTime()`): two override `occurrence`s differing only below a
  millisecond are duplicates; `endTime` must be strictly later at ms
  precision.
- `z.number().int()` accepts JSON `1.0`; `serde` into an integer type does
  not. Deserialise as `f64` (or a custom visitor) and check integrality.
- Unknown object keys are stripped, not rejected.
- `interval` defaults to 1 when absent.
- Error bodies: `{ error, details }` with Zod-shaped issues (see step 1).

**Crypto (`mekur-crypto`)**
- scrypt `N = 2^17, r = 8, p = 1, dkLen = 32` over the NFKC-normalised
  password; salt 16 random bytes.
- HKDF-SHA256 labels are wire format and keep their old names:
  `schedule-app:auth-key:v1`, `schedule-app:encryption-key:v1`,
  `schedule-app:identity-key:v1`, `schedule-app:seal:v1`,
  `schedule-app:sender-proof:v1` (sender proof uses no salt, i.e. a
  zero-filled one).
- Seal key salt is `epk || recipientPublicKey`. The sender proof is
  HMAC-SHA256 over `epk || utf8(body)`, where `body` is the JSON string
  carried inside the ciphertext (so JSON key order never matters).
- Envelope: `{ v: 1, algo: "xchacha20poly1305", keyId, nonce, ciphertext }`,
  24-byte nonce, standard base64 with padding; sealed adds `epk`, and a
  sealed envelope's `keyId` is the literal `"sealed"`.
- `fromBase64` is lenient on both TS paths, differently: Node's
  `Buffer.from(s, "base64")` accepts missing padding, URL-safe characters
  and skips garbage; the browser's `atob` accepts missing padding and ASCII
  whitespace. Decryption runs in the browser, so `atob`'s rules are the ones
  stored data has actually been decoded under. Accept missing padding and
  whitespace in Rust (with tests); document anything else only the TS side
  accepted rather than emulating garbage.
- An all-zero X25519 shared secret is an error (noble checks it).

**API (`mekur-api`)**
- Token formats are stored hashes and must not change: capability tokens
  are 32 random bytes, base64url; stored as base64(sha256(utf8 token)).
  API keys are `sak_` + base64url(24 bytes), prefix = first 12 chars,
  stored the same way. The voting pseudonym is
  base64(sha256(`schedule-app:pseudonym:v1:{eventId}:{token}`)).
- JWT: HS256, payload `{ userId, iat, exp }`, 30-day lifetime.
- Migrations: the Rust runner is a compatible port -- same
  `schema_migrations` table, same advisory lock key `7272774`, same SQL
  files (read from `apps/api/src/db/migrations` until 3g moves them into
  `crates/api`). Because of the shared lock and table, the TS and Rust
  servers can both run it at startup during the side-by-side phase, and
  the Rust test harness migrates its own database with it. Do **not** use
  `sqlx::migrate!`: its `_sqlx_migrations` table would re-run every
  migration on an existing database.
- Body limits: 256 KB globally, but `PUT /keyring` raises its own to
  1.5 MB (`1536 * 1024`). A global `RequestBodyLimitLayer` must be
  overridden on that route.
- During the side-by-side phase each server keeps its own rate-limit
  buckets, so the effective limit for a client is briefly the sum. Accepted
  for the transition; it ends at 3g.
- Rust API tests read `RUST_TEST_DATABASE_URL` (default
  `postgres://postgres:postgres@localhost:5432/scheduleapp_rust_test`), not
  the TS suite's `TEST_DATABASE_URL`, so the two suites can run at the same
  time without truncating each other's tables, locally as well as in CI.

## Log

- Step 0 (plan + skeleton + CI). Found while inventorying: the API's
  validation errors embed Zod's raw `issues`, which makes Zod's error
  shape part of the HTTP API -- recorded under step 1 rather than
  discovered mid-port.
  Self-review corrected the first draft's parity notes: Zod's datetime
  makes seconds optional and range-checks dates; `Intl` time-zone names
  are case-insensitive and include offsets; the browser decodes base64
  with `atob`; `PUT /keyring` has its own 1.5 MB body limit; and the Rust
  tests get their own database variable rather than sharing
  `TEST_DATABASE_URL`.
