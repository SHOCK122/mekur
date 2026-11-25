# Rust migration

mekur's API is moving from TypeScript to Rust. This file is the plan, the
progress tracker and the record of parity decisions. All new API code is
written in Rust; the TypeScript API is replaced one route group at a time.

**Scope decision (2026-11-25): the browser client stays TypeScript/React.**
Steps 4 (`mekur-client`, a wasm port of `apps/web/src/lib`) and 5 (a Leptos
UI) below were considered and dropped before any code was written for them
-- see the Log. The migration's scope is the API (steps 0-3g) only. The
rest of this document still describes 4 and 5 for the record, struck
through, since the port-order numbering elsewhere refers to them.

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
   - `mekur-shared` takes the role of the Zod schemas: each schema is a
     type whose only way in from JSON is `parse(&Value)` (no
     `Deserialize`), reporting Zod-shaped issues. New types follow the
     same pattern rather than `#[derive(Deserialize)]` plus a separate
     `validate()` that callers could forget.
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
```

Dependency direction: `shared` <- `crypto`; `shared` <- `api`. `api` must
never depend on `crypto`'s decryption: the server needs only hashing
(`sha2`) and never holds a key that opens user content. The one crypto call
the API makes today (`sha256Base64` of the auth key) became a direct `sha2`
call over Node's base64 decoding of the key (step 3b); `mekur-crypto` is
only a dev-dependency of the API's tests -- `packages/shared` and
`packages/crypto` keep serving the browser client directly (see the scope
decision above), so neither crate is built for wasm.

`crates/` sits beside `apps/` and `packages/` rather than inside them so
the two toolchains never share a directory during the transition. When a
TS package is fully gone, its directory is deleted, not left empty.

## Crate choices

| Need | Crate | Notes |
|---|---|---|
| Serialization | `serde`, `serde_json` | No `deny_unknown_fields`: Zod objects strip unknown keys rather than rejecting them. |
| Validation | hand-written `parse(&Value)` per type (no `Deserialize`) | Explicit, mirrors each Zod check and refinement one-to-one; no derive-macro framework whose rules drift from Zod's. |
| Dates, zones | `chrono`, `chrono-tz` | IANA data is bundled at build time rather than read from the runtime's `Intl`; pin and note the tzdata version. |
| AEAD | `chacha20poly1305` (`XChaCha20Poly1305`) | RustCrypto. |
| X25519 | `x25519-dalek` | Check `SharedSecret::was_contributory()`: noble rejects an all-zero shared secret, so the port must too. |
| KDF | `scrypt`, `hkdf`, `sha2`, `hmac` | RustCrypto. |
| Constant time | `subtle` | Sender-proof comparison. |
| Randomness | `rand_core` `OsRng` / `getrandom` | Native only: `mekur-crypto` is never compiled for wasm (see the scope decision above). |
| Secrets in memory | `zeroize` | |
| Password normalisation | `unicode-normalization` | Passwords are NFKC-normalised before scrypt. |
| Base64 | `base64` | See parity: Node's decoder is lenient. |
| HTTP server | `axum`, `tokio`, `tower`, `tower-http` | `tower-http` for body limit and security headers (helmet's set). |
| Database | `sqlx` (postgres, tokio, rustls, uuid, chrono) | Runtime-checked `query_as` + tests against real Postgres; revisit compile-time `query!` (needs committed `.sqlx` offline data) once the API is ported. |
| JWT | `jsonwebtoken` 11 (HS256, `rust_crypto` backend) | Must accept tokens the TS server issued and vice versa during the side-by-side phase. The backend feature also links RSA/ECDSA code that is never called. |
| Rate limiting | hand-written fixed window (`api::rate_limit`) + `lru` | `@fastify/rate-limit`'s algorithm and headers; `tower_governor`'s GCRA can't reproduce `x-ratelimit-*` or the 429 body. Not cryptography. |
| Web Push | `web-push` crate (VAPID) | Evaluate maintenance when the push slice is ported; fall back to `web-push-native`. |
| Errors, logs | `thiserror`, `tracing` | `anyhow` only in the binary. |

## Port order (leaves first)

Each numbered item is one PR unless noted. Check items off as they merge,
with a line on anything simplified or discovered.

### 0. Plan, workspace skeleton, CI
- [x] This document; `Cargo.toml` workspace with empty `mekur-shared`,
  `mekur-crypto`, `mekur-api`; pinned toolchain; `unsafe_code = "forbid"`;
  CI job running fmt, clippy and tests. (Postgres is added to that job in
  3a, with its first consumer.)
  - Originally scaffolded a fourth crate, `mekur-client`, and a wasm32
    target and CI job for it, toward steps 4-5 below. Removed once the
    scope decision above dropped those steps -- see the Log.

### 1. `mekur-shared` <- `packages/shared`
- [x] Types and validation for every schema, `MAX_OCCURRENCE_OVERRIDES`,
  time-zone check; port `packages/shared/test/index.test.ts`.
  - Each schema is a type with `parse(&serde_json::Value) -> Result<T,
    ValidationError>` and `Serialize` to the same JSON Zod's parsed output
    has (unknown keys stripped, absent optionals omitted, `interval`
    defaulted to 1). There is deliberately no `Deserialize` on them, so
    nothing can skip validation.
  - **Decided: issues reproduce Zod's exactly** -- same `code`, `path`,
    `message` and every code-specific field (`expected`/`received`,
    `minimum`/`maximum`, `type`, `inclusive`, `exact`, `validation`,
    `options`), in Zod's order, including Zod's abort/dirty rules (a wrong
    type stops the container's refinements; a failed check or refinement
    does not). Only key order *within* an issue object may differ.
  - **Zod parity fixture.** `packages/shared/test/zodParity.test.ts` runs
    138 cases through the Zod schemas and checks the result against
    `crates/shared/tests/fixtures/zod_parity.json`; the Rust test
    `tests/zod_parity.rs` replays the same file. So the fixture is Zod's
    real output, can't drift while the TS package exists, and stays behind
    as the record once it's gone. It also holds Node's `Intl` verdict on
    678 time-zone strings: Node's canonical zones, every alias chrono-tz
    knows (a Rust test fails if chrono-tz gains a name the fixture lacks)
    and edge cases.
    Regenerate with `UPDATE_ZOD_PARITY=1 npm run test
    --workspace=@schedule-app/shared`.
  - Time zones: IANA names from `chrono-tz` (tzdata 2025b; Node 22 here
    ships 2026e, and no zone differs), matched case-insensitively; offsets
    `±HH`, `±HHMM`, `±HH:MM` (also with U+2212); and the legacy ids ICU
    keeps but IANA dropped (Java three-letter ids, `SystemV/*`,
    `US/Pacific-New`, `Canada/East-Saskatchewan`), found by asking Node.
  - Divergences, all limited to input that is already invalid or that no
    client can produce:
    - Instants for the end-after-start and moved-once refinements are
      computed only for strings that pass Zod's datetime check. JavaScript's
      `Date` also parses some strings Zod rejects (offsets, date-only,
      legacy formats); Rust treats those as invalid dates. The value is
      invalid either way; only whether an *extra* issue is listed can
      differ.
    - Integers past `u64::MAX` in `interval`/`count` (Zod accepts any JS
      integer) get a `custom` "too large" issue.
- The TS package keeps serving the web client and, until step 3 removes
  them, the remaining TS API routes. It is permanent now that the client
  stays TypeScript (see the scope decision above): there is no step left
  that would delete it.

### 2. `mekur-crypto` <- `packages/crypto`
- [x] `derive_auth_and_encryption_keys`, `encrypt_envelope` /
  `decrypt_envelope`, `seal_to_recipient` / `open_sealed`, keypair
  generation, `sha256_base64`; port `packages/crypto/test/index.test.ts`
  (`crates/crypto/tests/index.rs`, every TS test plus key/nonce lengths,
  low-order points and malformed sealed bodies).
  - Keys cross the API as base64 strings, as in TS, so call sites port
    one-to-one. Secret fields are `Zeroizing<String>` (wiped on drop,
    movable out of their struct) and redacted from `Debug`; key types
    have no `PartialEq`, so secrets aren't compared with a non-constant-
    time `==`. Internally keys stay raw `Zeroizing` byte arrays (no
    base64 round trip for the seal key), and base64 decoding and NFKC
    normalisation write into buffers sized up front and wiped on drop.
  - **Derivation is synchronous** (`scryptAsync` yielded to the event
    loop) and allocates ~128 MiB, which wasm memory never gives back. Step
    4e must call it in a dedicated Web Worker and end the worker
    afterwards, or login freezes the page and the tab keeps the memory.
  - `decrypt_envelope` returns a `serde_json::Value`; callers validate it
    with the matching `mekur_shared` type's `parse`, as the TS client's
    `decryptEnvelope<T>` cast was meant to be followed by a schema check.
    It opens any envelope shape (`Envelope` trait); `encrypt_keyring_envelope`
    makes a `KeyringEnvelope` (same bytes as `encrypt_envelope`), so the
    API checks it against the keyring's size limit. Like the TS functions,
    the constructors don't check the schema limits themselves.
  - `from_base64` implements `atob`'s forgiving-base64 (whitespace
    ignored, padding optional but checked, non-zero leftover bits
    allowed), on top of the `base64` crate.
  - A falsy `sender` inside a sealed body (`null`, `false`, `0`, `""`)
    reads as anonymous, as `if (inner.sender)` did.
- [x] **Cross-language vectors**: `packages/crypto/test/crossLanguage.test.ts`
  writes `crates/crypto/tests/fixtures/ts_vectors.json` (5 derivations
  incl. NFKC pairs and an empty password, 6 envelopes, 12 sealed --
  anonymous and named -- and a forged sender) and opens
  `rust_vectors.json`, which `crates/crypto/tests/cross_language.rs`
  writes from the same keys and payloads and opens the TS file. The
  derivations are re-checked against TS on every run. Regenerate with
  `UPDATE_CRYPTO_VECTORS=1` on either side.
- Divergences, all limited to content no client produces:
  - `serde_json` rejects a JSON string with a lone UTF-16 surrogate escape
    (`"\ud800"`) and nesting deeper than 128; `JSON.parse` accepts both.
    `JSON.stringify` writes a lone surrogate as such an escape, so a title
    holding one (only possible by pasting malformed text) decrypts in TS
    but is `PlaintextNotJson` in Rust. Moot now that the browser keeps
    using `packages/crypto` (see the scope decision above) -- recorded for
    the cross-language test vectors only, not a product requirement.
  - A sealed body whose `body` is not a string is an error;
    `JSON.parse(non-string)` coerced it.
  - Payload JSON is written by `serde_json`: numbers can be spelled
    differently (`1e21` vs `1e+21`, a float `1.0` vs `1`), so the
    plaintext bytes (and ciphertext length) can differ by a character or
    two, never the parsed value.
- Permanent, like `packages/shared`: the web client is its only importer
  and stays TypeScript (see the scope decision above).

### 3. `mekur-api` <- `apps/api`, route group by route group
Side-by-side ("strangler") deployment: nginx sends each ported route
group to the Rust server and everything else to the TS server. Both use
the same database and the same `JWT_SECRET`. After each slice the TS
routes, repository and tests for that group are deleted.

- [x] **3a. Foundation**: config (same variables, defaults and production
  guards), pool, migration runner, `GET /health`, `GET /openapi.json`,
  helmet's security headers, Fastify's 404s; Rust test harness (real
  Postgres, truncate between tests, tests serialised,
  `RUST_TEST_DATABASE_URL`, database created if missing); a Postgres
  service in the `rust` CI job; `infra/Dockerfile.api-rs` (`api-rs` in
  `docker-compose.yml`); nginx + Vite proxy split. Ported
  `health.test.ts`, `migrationConcurrency.test.ts` (plus: re-runs apply
  nothing, a partly-migrated database is completed, a failing file rolls
  back and still releases the lock) and the header test of
  `security.test.ts`.
  - **One OpenAPI document for both servers**: `crates/api/openapi.json`,
    generated once from `openapi.ts` (now deleted) and served
    byte-for-byte as before (stored pretty-printed, sent minified). The
    route-coverage check moved to `apps/api/test/openapi.test.ts`: TS
    routes plus `ROUTES` in `crates/api/src/app.rs` (read from the source)
    must equal what the document lists, and no route is on both servers.
    Later slices edit the JSON file directly.
  - **Proxy split**: nginx (`location =` per path) and the Vite proxy (one
    regex) list the Rust server's paths; `openapi.test.ts` checks both
    against `ROUTES`, so a slice can't port a route and forget a proxy.
    The split is by path, so a path moves to Rust with all its methods
    (also checked).
  - **Parity fixture**: `apps/api/test/rustParity.test.ts` records the TS
    server's 404s (unknown paths, wrong methods, trailing slash, case,
    query strings) with every header in
    `crates/api/tests/fixtures/ts_responses.json`; `tests/ts_parity.rs`
    replays it, extra headers included. Regenerate with
    `UPDATE_API_PARITY=1`. axum's `405` + `Allow` for a wrong method
    is turned into Fastify's 404 without `Allow`.
  - Migrations are embedded at build time by `build.rs` from
    `apps/api/src/db/migrations`, so the image carries no SQL files.
  - Startup checks that the TS server got implicitly from its
    libraries -- `@fastify/jwt` refusing an empty secret, `web-push`
    validating the VAPID keys and subject -- arrive with their consumers
    (3b, 3g); the explicit production guards are ported.
  - `PORT`/`TRUST_PROXY` are read as decimal whole numbers; `Number()`'s
    other spellings (`0x1`, `1e0`) are refused rather than reproduced.
  - **Moved to 3b, with their first consumer**: rate limiting, the 256 KB
    body limit, empty-JSON-body-as-`{}` and the JSON parse-error body. The
    TS server never rate-limited `/health` or `/openapi.json` (they are
    registered before `@fastify/rate-limit` loads, so its `onRoute` hook
    never sees them -- no `x-ratelimit-*` headers either), and neither
    route reads a body, so nothing in 3a would use them.
  - The TS container's healthcheck now accepts any HTTP answer (it gets a
    404 for `/health`), which is all `/health` ever showed: it never
    touched the database.
- [x] **3b. Auth**: users repository, `authRoutes` (`POST /users`,
  `POST /sessions`, `GET /users/{username}/salt`), session tokens, rate
  limiting, request bodies. `RegisterRequest`/`LoginRequest` (were
  `apps/api/src/schemas.ts`) are `mekur-shared` types with Zod's issues,
  including the username regex's `invalid_string`/`regex` issue. Ported
  `auth.test.ts` (`tests/auth.rs`), `publicKeyRepair.test.ts`
  (`tests/public_key_repair.rs`; it reads the stored key from the
  database, since `/tags/resolve` is still TS) and the login rate-limit
  and token-expiry tests of `security.test.ts` (`tests/rate_limit.rs`,
  `tests/auth.rs`); TS `authRoutes.ts`, `schemas.ts` and those tests
  deleted. The TS suite's `registerUser` now writes the user row and signs
  the token itself, as the deleted route did.
  - **Frozen fixture of the TS replies**: `tests/fixtures/ts_auth_responses.json`
    holds 44 replies of the TS auth routes (validation issues, every body
    error, content types, 404s around the routes, the 10/min and 300/min
    limits and their headers, buckets per route, `X-Forwarded-For`
    ignored without a trusted proxy, 404s not counted), each on a fresh app
    with production limits and one seeded account. It was recorded before
    the TS routes were deleted, so it can no longer be regenerated; it is
    the record `tests/ts_parity.rs` replays.
  - **The auth hash decodes the key as Node did.** The TS server stored
    `sha256(Buffer.from(authKey, "base64"))` -- Node's lenient decoder,
    which skips junk, accepts URL-safe characters, stops at the first `=`
    and reads only the low byte of each UTF-16 unit. `api::node_base64` is
    a port of that decoder (`nbytes::Base64Decode`), checked against
    Node's output for 2,031 strings (`tests/fixtures/node_base64.json`,
    regenerated by `rustParity.test.ts`), so every stored hash keeps
    verifying, and any spelling Node read as the same bytes still logs in.
  - **Tokens**: HS256 `{ userId, iat, exp }`, 30 days, as `@fastify/jwt`
    signed them. `tests/fixtures/rust_jwt.json` is a Rust-signed token
    that `rustParity.test.ts` verifies with the TS server's `@fastify/jwt`
    (and checks it expires when the TS server's would). An empty
    `JWT_SECRET` is refused at startup, as `@fastify/jwt` refused it.
  - **Rate limits** port `@fastify/rate-limit` 11's in-memory store: a
    fixed one-minute window per client key, separate counts for the global
    limit and for each of login and registration, 5,000 clients remembered
    per limiter (least recent forgotten), counted before the body is read,
    unmatched paths not counted. Client keys follow Fastify's `request.ip`
    with `trustProxy` as a hop count and `normalizeIP` (IPv4-mapped
    addresses as IPv4, other IPv6 addresses by /64).
  - **Bodies** follow Fastify's rules: no content type and no body is
    `undefined` (Zod's "Required"); a body without a content type, or of a
    type other than JSON or `text/plain`, is a 415; `text/plain` is a
    string (so the route's validation answers); an empty or whitespace
    JSON body is `{}`; over 256 KB is a 413; 413 and malformed JSON close
    the connection.
  - **Undecodable paths** (`%zz`, escapes that aren't UTF-8) get
    find-my-way's raw `FST_ERR_BAD_URL` 400 on every path and method --
    without security headers or rate limiting, as before. Recorded in
    `ts_responses.json`.
  - Proxies: nginx and Vite send `/users`, `/sessions` and
    `/users/{username}/salt` to Rust. Parameterised paths use a regex
    location in nginx; `openapi.test.ts` checks it covers each Rust path
    and no TS one. nginx matches the normalised URI (slashes merged,
    `%2F` decoded), so `/api/users//salt` and `/api/users/a%2Fb/salt` fall
    through to the TS server's 404 -- as they did before this step, when
    nginx normalised them the same way on their way to Fastify. The Rust
    server handles them as Fastify did when reached directly.
  - The TS repository's `updatePublicKey` is deleted with its only caller:
    only login may rewrite a public key.
  - **Moved to 3c, with its first consumer**: the auth extractor (JWT and
    `sak_` API keys). No Rust route requires authentication yet. Found
    while reading `fast-jwt`: it accepts a token *without* `exp`, so tokens
    issued before expiry was added never expire on the TS server; 3c must
    decide whether to keep accepting them (parity) or close that hole in
    its own PR.
  - Divergences, all on input no client sends or on failure paths:
    - Fastify routed on the percent-decoded path (`/%75sers` reached
      `/users`); axum routes on the raw path, so such requests get the
      404. Path parameters are still fully decoded (`a%2Fb` is the
      username `a/b`). Clients never percent-encode unreserved characters.
    - The malformed-JSON 400 keeps Fastify's shape but carries
      `serde_json`'s message, not V8's; `serde_json` also rejects lone
      surrogate escapes (`"\ud800"`) that `JSON.parse` took, which the TS
      server stored as U+FFFD.
    - A 500 says `"Internal Server Error"` rather than echoing the
      database error's message, which leaked internals; the error is
      logged instead.
    - `find_by_id`/`update_public_key` treat a string that isn't a UUID as
      no such user rather than a database error (every caller passes an
      id from the database or a token).
- [x] **3c. API keys**: repository + routes (`POST`/`GET /api-keys`,
  `DELETE /api-keys/{id}`), and the auth check (JWT + `sak_` API keys,
  `authMethod`) moved here from 3b. `CreateApiKeyRequest` is a
  `mekur-shared` type with Zod's issues. Ported `apiKeys.test.ts`
  (`tests/api_keys.rs`) and the API-key half of `security.test.ts`'s
  malformed-UUID test; TS `apiKeyRoutes.ts` and `generateApiKey` deleted.
  The TS auth plugin, `hashApiKey`/`looksLikeApiKey` and the repository's
  `findUserIdByHash` stay until the last TS route goes (3g): the TS
  routes still authenticate keys. `apiKeys.test.ts` now checks just that,
  with keys inserted in the Rust server's format.
  - **Frozen fixture of the TS replies**:
    `tests/fixtures/ts_api_key_responses.json`, 97 replies of the TS
    routes recorded before deletion, replayed by `tests/ts_parity.rs` with
    new ids, keys and timestamps normalised away, and which keys were left
    and marked used afterwards. It covers 30 JWT variants (HS384/512,
    without `exp`/`iat`/`typ`, `nbf`, fractional and non-numeric `exp`,
    `crit`, `alg: none`, wrong secret, tampering, padding, extra segments),
    16 `Authorization` spellings, validation and body errors, 403, 404s,
    204s, paths around the routes and the global limit.
  - **What `fast-jwt` accepted** (`jwt::verify`, by reading `fast-jwt` 6
    and `@fastify/jwt` 10, then the fixture): any of HS256/384/512 (the
    HMAC family for a string secret); `exp`/`nbf` checked only when
    present, as numbers, at millisecond precision; no truthy `crit`; `typ`
    and `iat` ignored; segments decoded with Node's lenient decoder (so
    `node_base64` again). The HMAC is RustCrypto's, compared in constant
    time; `jsonwebtoken` still signs.
  - **Decided: tokens without `exp` stay valid** (parity). Refusing them
    is a behaviour change that would sign out those users on one server
    but not the other; it is a Phase 11 roadmap item instead.
  - **Header parsing** has two rules, kept as they were: an API key needs
    exactly `Bearer ` (case-sensitive, one space) and everything after it
    is the key; a JWT needs `/^Bearer\s/i` and exactly one space in the
    header (so `bearer <jwt>` works, `Bearer  <jwt>` and a trailing space
    don't). The header is read as Latin-1, as Node did.
  - **Order**: handlers read the body before authenticating, since Fastify
    parsed bodies before `preHandler` hooks: a malformed body is a 400 or
    415 even without credentials. `GET` reads no body.
  - **User ids from tokens** are bound as text and cast by Postgres, as
    node-pg sent them, so an uppercase id still matches and a non-UUID is
    a 500, as before. `DELETE`'s id is checked with Zod's UUID rule
    (`is_zod_uuid`: hyphenated hex only, no braces or URNs) after
    percent-decoding; an empty id (`/api-keys/`) is a route, as in Fastify.
  - Proxies: nginx sends `/api/api-keys` and `/api/api-keys/<id>` (empty id
    included) to Rust; Vite likewise. `openapi.test.ts`'s "longer path"
    check now knows a Rust path can extend another (`/api-keys/{id}`).
  - Divergences, only reachable with a token signed with `JWT_SECRET`
    that neither server issues:
    - a `userId` that isn't a string (missing, `null`, a number, an array
      payload) is a 401; the TS server let the query fail (500) or match
      nothing (an empty list, or a 500 on insert);
    - claims `serde_json` can't parse (numbers past `f64`, lone surrogate
      escapes) are refused; `JSON.parse` took them.
  - Found, not changed (roadmap items): tokens without `exp`, above; and
    `GET /api-keys` is the one unbounded list (a user's own hand-minted
    keys).
  - For 3d onward (from review): each parametric route still needs a
    second, empty-parameter route and its handler strips its own prefix
    from the raw URI (`/users//salt`, `/api-keys/`). With events and keyring
    adding several `{id}` routes, factor that into one helper first.
- [x] **3d. Events & capabilities**: repository + routes (`POST /events`,
  `POST /events/batch-read`, `GET`/`PUT`/`DELETE /events/{id}`, `POST
  /events/{id}/capabilities` and `.../revoke`), capability tokens
  (`api::events`: 32 random bytes base64url, stored as base64(sha256)) and
  the voting pseudonym (format only; no route uses it until Phase 10).
  The request bodies are `mekur-shared` types with Zod's issues
  (`EventEnvelopeRequest`, `BatchReadRequest` with `BATCH_READ_LIMIT`,
  `MintCapabilityRequest`, `RevokeCapabilityRequest`); Zod's `.uuid()`
  check moved to `mekur_shared::is_zod_uuid`. Ported the events half of
  `capabilities.test.ts` and the event tests of `security.test.ts`
  (payload caps, malformed ids) to `tests/events.rs`, plus: no row links
  the creating account to the event, only token hashes are stored, expiry
  (stored to the millisecond), the batch bound, and envelopes round-trip
  byte for byte. TS `eventRoutes.ts`, `eventRepository.ts` and
  `lib/capability.ts` deleted; the keyring and inbox tests left in
  `capabilities.test.ts` became `keyringAndInbox.test.ts`, and the TS
  API-key test now uses `/keyring`.
  - **Frozen fixture of the TS replies**:
    `tests/fixtures/ts_event_responses.json`, 185 replies of the TS routes
    recorded before deletion (by a throwaway recorder, as in 3c), replayed
    by `tests/ts_parity.rs` *with the events and capabilities left in the
    database afterwards* and whether the seeded API key was marked used.
    Seeded: two accounts, an API key, two events, and live, expired,
    revoked and future-expiring view/edit capabilities. It covers every
    route's success and refusal paths, body errors, validation issues
    (UUIDs, token lengths, the 500 bound with per-entry issues, datetime
    and enum errors, ciphertext and keyId caps in UTF-16 units), unknown
    keys stripped, paths and methods around the routes, and the global
    rate limit. New ids, tokens, hashes and today's timestamps are
    normalised; runs of 64+ identical characters are written `⟪c×n⟫`.
    Checked to fail when the envelope formatting or the expiry rule is
    broken.
  - **Order of checks** (from the recording): body (400/413/415), then
    account (401), then target -- a Zod UUID in the path and a non-empty
    `X-Event-Capability` -- (404), then validation (400), then the
    capability (404). So a *wrong* token with an invalid body is a 400,
    a *missing* one a 404; neither says whether the event exists. `GET`
    reads no body.
  - **Envelopes are sent byte for byte as before**: read as `jsonb::text`
    and minified, which is exactly `JSON.stringify(JSON.parse(text))`
    (jsonb's key order; jsonb and V8 escape the same characters). Stored
    is Zod's output: unknown keys stripped, `v: 1.0` stored as `1`.
  - **Ids** are bound as text and cast by Postgres, as node-pg sent them,
    so an upper-case or percent-encoded id still matches (the reply carries
    the lowercase id). The capability header is read as Latin-1 with
    repeated headers joined by `", "`, as Node did.
  - **Routing**: Fastify's routes are per method, so `GET /events/batch-read`
    reached `/events/:id` (a 404 after auth); in axum the static path
    shadows the parameter for every method, so `/events/batch-read` routes
    `GET`/`PUT`/`DELETE` to the id handlers itself. Empty ids (`/events/`,
    `/events//capabilities`) are routes, as in Fastify; `/events//` is not.
    The empty-parameter helpers the 3c review asked for are
    `app::route_with_empty_param` (registers both forms of every
    parametric route) and `app::path_param` (reads the parameter from the
    raw path), now used by every parametric route.
  - **Privacy unchanged**: no handler passes the account on; the
    repository takes no user id; the batch read stays one query, at most
    500 capabilities.
  - Proxies: nginx sends `/api/events`, `/api/events/batch-read` and
    `^/api/events/[^/]*(/capabilities(/revoke)?)?$` to Rust; Vite likewise.
  - Divergences: none observed beyond the ones every route shares (V8's
    JSON parse message, percent-decoded routing; see 3b).
- [x] **3e. Keyring**: repository + routes (`GET`/`PUT /keyring`:
  versioned, 409 on conflict, its own 1.5 MB body limit on `PUT`).
  `PutKeyringRequest` is a `mekur-shared` type with Zod's issues, over the
  existing `KeyringEnvelope`. Ported the keyring tests of
  `keyringAndInbox.test.ts`, `security.test.ts` (the larger body limit) and
  `apiKeys.test.ts` (a key reads and writes the keyring) to
  `tests/keyring.rs`, plus: what a refused write leaves behind, two
  devices racing with one version (exactly one wins), what the row holds,
  both size caps to the byte, and that the larger limit is the keyring's
  alone. TS `keyringRoutes.ts` and `keyringRepository.ts` deleted;
  `keyringAndInbox.test.ts` is now `inbox.test.ts`, and the TS tests that
  used `/keyring` as "any signed-in route" (API-key auth, security
  headers) use `/inbox`.
  - **Frozen fixture of the TS replies**:
    `tests/fixtures/ts_keyring_responses.json`, 117 replies of the TS
    routes recorded before deletion (by a throwaway recorder, as in 3c and
    3d), replayed by `tests/ts_parity.rs` *with the keyrings left in the
    database afterwards* and which API keys were marked used. Seeded: two
    accounts with an API key each, and a keyring for one of them at
    version 3. It covers reads (none yet, existing, after writes, at the
    cap, `HEAD`), writes and every conflict, versions spelled `3.0`, `3e0`
    and `-0`, versions Postgres can't take, every validation issue, the
    256 KB / 1 MB / 1.5 MB boundaries, body errors, every refusal of
    credentials, tokens for unknown or malformed user ids, paths and
    methods around the route, and the global rate limit. Nothing in a
    keyring reply varies between runs, so bodies are compared byte for
    byte. Checked to fail when the version step, the body limit or
    `updated_at` is broken.
  - **Order of checks** (from the recording): `PUT` reads its body up to
    1.5 MB (400/413/415), then the account (401), then validation (400),
    then the write (200/409). So an oversized body is a 413 without
    credentials, and a 300 KB one a 401. `GET` reads no body.
  - **One statement per write**, as before: `INSERT ... ON CONFLICT DO
    NOTHING` for `expectedVersion` 0, `UPDATE ... WHERE version = $3`
    otherwise; no row back is the 409. Of two racing writers exactly one
    wins (now tested). `-0` and `0.0` are 0, as `=== 0` had it.
  - **Envelopes are sent byte for byte as before** (`jsonb::text`,
    minified, as in 3d); stored is Zod's output, unknown keys stripped.
    The repository takes a `KeyringEnvelope`, not JSON, so only a
    validated keyring can be stored.
  - **User ids** from tokens are bound as text and cast by Postgres, as
    before: an upper-case id matches; an id that is no UUID is a 500; a
    well-formed id of no account reads as "no keyring" and its first
    write is a 500 (the foreign key), a later one a 409.
  - **Kept: an `expectedVersion` past `i32::MAX` is a 500.** node-pg sent
    it as text and Postgres refused it; the Rust repository refuses it
    itself (`VersionOutOfRange`). A 409 would be the better answer, but
    that is a behaviour change (roadmap, Phase 11). `PutKeyringRequest`
    holds the version as a `u64`, saturating past `u64::MAX`.
  - `KEYRING_BODY_LIMIT` is passed to `read_body` by the handler; there is
    no global body-limit layer to override.
  - Proxies: nginx and Vite send `/api/keyring` to Rust (nginx with its
    own body limit, below).
  - Divergences, on input no client sends:
    - `"expectedVersion": 1e400`: `JSON.parse` read it as `Infinity`, which
      Zod reported as a float (a 400 with `details`); `serde_json` refuses
      the number, so it is the malformed-JSON 400.
    - The ones every route shares: percent-decoded routing (`/%6beyring`
      reached the TS route), V8's JSON parse message, and the 500's body
      (no database error code or message).
  - **Fixed on the way: nginx refused large keyrings.** Its default
    `client_max_body_size` is 1 MB, below what the route reads, so behind
    the compose stack a keyring write past 1 MB (the schema allows 1 MB
    of ciphertext alone) got nginx's HTML 413 from the proxy, whichever
    server was behind it. The keyring location now sets `2m`, above the
    API's limit, so an oversized keyring still gets the API's JSON 413
    through the proxy. `openapi.test.ts` checks it is the only raised
    limit and that it sits above `KEYRING_BODY_LIMIT`, which it reads from
    the Rust source.
  - `app::stored_json` is only right for envelopes (strings and the
    integer `v`): for other JSON, jsonb's text and `JSON.stringify` differ
    (`1.0` vs `1`, integer-like keys first in V8). 3f/3g must check before
    reusing it on another column.
  - Review: `auth::body_then_account` is the one place that reads a body
    and then authenticates (API keys, events and the keyring use it);
    `app::stored_json` the one place a stored envelope becomes a reply;
    `parsers!` (now in `zod.rs`) the one `parse`/`parse_optional` pair.
  - Found, not changed (roadmap items): the 500 above; and bodies are
    parsed before the account is checked (Fastify's order), which on this
    route means up to 1.5 MB for a client without credentials.
- [x] **3f. Social**: friend-code repository + routes (`GET /friend-code`,
  `POST /friend-code/rotate`, `POST /tags/resolve`). `ResolveTagRequest`
  (was the inline `ResolveTagRequestSchema` in
  `apps/api/src/routes/socialRoutes.ts`) is a `mekur-shared` type with
  Zod's issues. Ported `social.test.ts` to `tests/social.rs`, plus: of two
  people racing to redeem the same code, exactly one succeeds, and a tag
  surrounded by JavaScript's `trim`-removed whitespace still resolves. TS
  `socialRoutes.ts` and `friendCodeRepository.ts` deleted.
  - **Frozen fixture of the TS replies**:
    `tests/fixtures/ts_social_responses.json`, 22 replies recorded before
    deletion (by a throwaway recorder, as in 3c-3e). Unlike those steps'
    fixtures, it needed no database introspection afterwards: there is no
    version/conflict state to leave behind, and the one thing a single
    recorded run can't show -- two redeemers racing for one code -- is
    covered directly by `tests/social.rs` instead. Seeded: two accounts
    (API keys only, no JWTs: nothing here needed a session to also work,
    and an API key never expires, so the fixture can't go stale) and one
    account's friend code at a fixed value and timestamp. The recorder
    normalises what varies between runs (a new code, `now`) to the same
    placeholders the Rust replay uses, so fixture bodies compare directly
    -- extended `normalise` in `ts_parity.rs` (shared with the API-key
    fixture) with one more case rather than writing a second copy.
  - **Order of checks**, as established by 3b-3e and unchanged here: a
    body is read (400/413/415) before the account is checked (401), then
    validation (400), then the capability/resolution step (404). `POST
    /friend-code/rotate` reads a body it never uses, so a malformed one is
    still a 400 without credentials -- found by recording the TS server,
    not assumed.
  - **Trimming.** `tag.trim()` is JavaScript's `trim`, not Rust's: reused
    `body::is_js_whitespace` (already public, from the content-type and
    rate-limit header parsing) rather than add a second notion of
    whitespace. Unreachable with real input: usernames are
    `[a-z0-9_.-]`-only, so a username lookup's case-folding can only ever
    differ from JavaScript's on characters no valid username contains.
  - Proxies: nginx and Vite send `/friend-code`, `/friend-code/rotate` and
    `/tags/resolve` to Rust.
  - No divergences found beyond the ones every route shares (percent-decoded
    routing, V8's JSON parse message; see 3b).
- [ ] **3g. Inbox + push**: inbox repository/routes (newest 200 only --
  every list stays bounded; port `inbox.test.ts`), push subscriptions,
  notification service. Port `pushNotifications.test.ts` and the rest of
  `security.test.ts`. Then delete `apps/api` and the TS server from
  `docker-compose.yml`; the Rust server takes over running migrations.

### 4. `mekur-client` <- `apps/web/src/lib` -- decided against
**Decided (2026-11-25): not pursued.** The plan was to expose each module
of `apps/web/src/lib` to the React app via wasm-bindgen, porting
`fractionalRank`; `zonedTime`/`datetime`; `recurrence` (the largest and
riskiest port, replacing the `rrule` npm package); `timeline` and
`timelineInteraction`; and last the crypto call sites (`events`, `keyring`,
`social`, `session`, `api`, `http`, `eventCache`, `push`). None of it was
started -- `mekur-client` was an empty skeleton crate from step 0, now
removed along with the wasm32 toolchain target and CI job that existed only
for it. See the scope decision at the top of this document and the Log.

### 5. UI -- decided against
**Decided (2026-11-25): not pursued.** The plan was a from-scratch UI
rewrite (recommendation: Leptos, client-side rendered) once step 4 landed,
keeping every accessibility guarantee the current component tests assert.
Dropped with step 4, for the same reason: see the scope decision above.

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
- The auth hash is `sha256` of the auth key **as Node's `Buffer.from(key,
  "base64")` decodes it** (lenient), not of its UTF-8 text:
  `api::node_base64`.
- Migrations: the Rust runner is a compatible port -- same
  `schema_migrations` table, same advisory lock key `7272774`, same SQL
  files (read from `apps/api/src/db/migrations` until 3g moves them into
  `crates/api`). Because of the shared lock and table, the TS and Rust
  servers can both run it at startup during the side-by-side phase, and
  the Rust test harness migrates its own database with it. Do **not** use
  `sqlx::migrate!`: its `_sqlx_migrations` table would re-run every
  migration on an existing database.
- Body limits: 256 KB everywhere (`body::BODY_LIMIT`), except `PUT
  /keyring`, which reads up to 1.5 MB (`routes::keyring::KEYRING_BODY_LIMIT`,
  `1536 * 1024`). Each handler passes its limit to `read_body`; there is no
  global layer.
- Fastify's 404 is `{"message":"Route METHOD:URL not found","error":"Not
  Found","statusCode":404}` with the raw request target (query string
  included), for unknown paths *and* wrong methods (never 405). Paths are
  case-sensitive and `/health/` is not `/health`. Every JSON reply's
  `content-type` is `application/json; charset=utf-8`. Helmet's headers
  are on every reply, 404s included.
- Route-level rate limits apply only to routes registered after the plugin
  loaded; check each route group's actual headers (the parity fixture)
  rather than assuming the global limit covers it.
- A malformed JSON body's 400 `message` is V8's `JSON.parse` error text
  (`Expected property name or '}' in JSON at position 1 (line 1 column
  2)`), which `serde_json` can't reproduce: keep the shape, document the
  text as a divergence. Fastify also closes the connection after a 400
  parse error or a 413.
- Fastify parses `text/plain` bodies too (to a string), so a route given
  one answers with its own validation error (400 `invalid_type`, received
  `string`), not a 415.
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
- Step 1 (`mekur-shared`). The TS package stays: the API and web client
  still import it. Found while porting: Zod echoes a wrong literal's
  `received` value as JavaScript prints it (`2.0` comes back as `2`), and
  `Math.max()` of an empty `byMonth` is `-Infinity`, which makes every
  `byMonthDay` "never occur" -- both reproduced. Node's `Intl` accepts far
  more than the IANA list (Java-style `PST`, `SystemV/EST5`); those are
  listed explicitly rather than rejected, so a stored rule never stops
  validating. Self-review: `KeyringEnvelope` became its own type rather
  than wrapping `EncryptedEnvelope`, so a 1 MB keyring ciphertext can't
  pass for an event envelope; the zone fixture gained every alias
  (`Intl`'s canonical list omits them); each enum's names live in one
  table. CI now also lints `mekur-shared` for wasm32, since the
  browser client will link it.
- Step 2 (`mekur-crypto`). The TS package stays: the web client and API
  still import it. Found while porting: Node's base64 decoder silently
  accepted a mistyped 23-character salt in the first draft of the vector
  script -- exactly the leniency the parity notes warned about; the Rust
  side (following `atob`) rejected it. Crate versions are the current
  RustCrypto majors (`chacha20poly1305` 0.11, `x25519-dalek` 3,
  `scrypt` 0.12, `hkdf`/`hmac` 0.13, `sha2` 0.11); `getrandom` 0.4 needs
  only its `wasm_js` feature in the browser (no `--cfg`). scrypt and its
  inner crates build optimised even in dev, or a debug derivation takes
  tens of seconds. CI now also lints and builds `mekur-crypto` for wasm32.
  Review (no correctness findings) tightened secret handling as noted
  under step 2, and surfaced the synchronous-scrypt requirement for 4e.
- Step 3a (API foundation). The Rust server now answers `/health` and
  `/openapi.json` behind nginx and the Vite proxy; the TS server dropped
  both. Found by probing the running TS server rather than reading it:
  neither route was ever rate-limited (see 3a), so the limiter and body
  handling moved to 3b, where the first routes that use them land. Also
  found: axum still adds `Allow` to a wrong-method reply after
  `Router::layer` middleware has run, so response middleware wraps the
  whole router instead. Checked end to end with a real nginx in front of
  both servers (split, query strings passed through, OpenAPI bytes
  identical to the TS server's).
  Review fixes: the migration connection is closed rather than pooled, so
  a cancelled run can't leave the advisory lock held on an idle pooled
  connection (blocking both servers' next start); the lock-released test
  only counts locks on its own database (it flaked against parallel
  tests); `healthcheck` asks the address in `HOST`; the proxies' route
  lists are tested; test binaries migrate once rather than per test.
- Step 3b (auth). Registration, login and the salt lookup moved to the
  Rust server, with rate limiting and Fastify's body handling. Found by
  probing the TS server before porting: the stored auth hash depends on
  Node's lenient base64 decoder (now ported, with Node's own output as the
  fixture), find-my-way rejects undecodable paths before routing with a
  raw 400, Fastify accepts `text/plain` bodies and empty path parameters,
  and the rate limiter counts requests before reading their bodies. The
  auth extractor moved to 3c, where the first authenticated Rust route
  lands; reading `fast-jwt` for it showed that tokens without `exp` are
  accepted.
- Step 3c (API keys). Minting, listing and revoking keys moved to the Rust
  server, with the auth check every later route group will use. Found by
  probing the TS server before porting: JWTs signed HS384/HS512 and with a
  fractional `exp` were accepted, `bearer` was case-insensitive for JWTs
  but not for API keys, and a body error beat a missing token. The
  fixture's per-case "keys afterwards" also pins that only API-key
  requests touch `last_used_at`.
- Step 3d (events and capabilities). The event routes moved to the Rust
  server. Found by recording the TS server before porting: a wrong
  capability with an invalid body is a 400 but a missing one a 404 (the
  target check runs before validation, the capability check after);
  `GET /events/batch-read` was routed to `/events/:id`; an upper-case or
  percent-encoded event id matched; and the reply's envelope is jsonb's
  key order, which the Rust server reproduces byte for byte rather than
  re-serialising. The recording also confirmed revoking an *expired*
  capability succeeds (only unrevoked is required), kept for parity.
  Review fixes: `/events/batch-read`'s `GET`/`PUT`/`DELETE` passed the
  global limiter twice (regression test: every event route counts once);
  an `expiresAt` that validates but names no instant is now a 500 rather
  than a capability that never expires; secrets share one
  `api::secret` (random base64url, base64(sha256)); the create inserts
  both capabilities in one statement. Found, not changed (parity): the
  capability check and the write are separate statements, so a token
  revoked between them can finish one write in flight -- a Phase 11
  roadmap item. `derive_pseudonym` is kept although unused: its format is
  on the parity list and its TS source is gone.
- Step 3e (keyring). `GET` and `PUT /keyring` moved to the Rust server.
  Found by recording the TS server first: an `expectedVersion` Postgres
  can't hold was a 500 rather than a conflict (kept), `1e400` parsed as
  `Infinity` (a divergence, documented), and the route was reachable as
  `/%6beyring`. Found by review: the compose stack's nginx capped request
  bodies at 1 MB, under the keyring's own limit, so a full-size keyring
  could never be saved through it -- fixed in the keyring location. The
  replay scaffolding in `ts_parity.rs` is now shared between the event and
  keyring fixtures.
- **Scope decision.** Steps 4 (`mekur-client`) and 5 (UI) are decided
  against: the browser client stays TypeScript/React, so the migration's
  scope is the API (steps 0-3g) only. Rationale: the API and crypto are
  where Rust's safety argument (no `unsafe`, audited crates, memory
  safety) actually matters, and that part was already most of the way
  done with a proven, low-risk TDD pattern (two slices left: 3f, 3g). The
  remaining steps were the opposite -- a from-scratch port of a 1,200-line
  recurrence engine and a 1,400-line, accessibility-critical `Timeline`
  component to an undecided UI framework (Leptos), rewriting code that
  already works and already has full test coverage, for a layer where
  Rust's advantages don't apply (a calendar UI isn't CPU- or memory-bound).
  Root-cause cleanup, since nothing will ever consume it: removed the
  `mekur-client` skeleton crate (`crates/client`, workspace member since
  step 0), the wasm32 target from `rust-toolchain.toml`, the wasm clippy
  and build steps from CI, and `mekur-crypto`'s wasm32-only `getrandom`
  dependency (it was conditional on a target that crate will now never be
  built for). `mekur-shared` and `mekur-crypto` keep existing exactly as
  before -- they still serve `mekur-api`'s tests -- but will never be
  linked into a wasm build.
- Step 3f (social). Friend codes and tag resolution moved to the Rust
  server. The smallest slice yet, and the first with no version/conflict
  state or large ciphertexts to track, so its fixture carries no "seed
  state afterwards" section at all -- that coverage lives in
  `tests/social.rs`'s own race test instead of a recorded one, since a
  single recording can only ever show one side of a race. Found by
  recording the TS server before porting: `POST /friend-code/rotate`
  parses a body it never reads, so a malformed one is still a 400 without
  credentials (the general body-then-account order from 3b, confirmed
  rather than assumed for a route that ignores its body); and resolving a
  tag runs it through `trim()` before matching, which only reused code
  (`body::is_js_whitespace`) needed to reproduce correctly.
