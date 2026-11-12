import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Database } from "../src/db/pool.js";
import { setupTestApp } from "./testHelpers.js";

// Records what this server answers to requests whose replies don't depend
// on any route group -- 404s for unknown paths and wrong methods, and the
// security headers on them -- in crates/api/tests/fixtures/ts_responses.json.
// The Rust server's tests (crates/api/tests/ts_parity.rs) replay the same
// file, so the two servers can't drift apart while both exist.
// Regenerate with UPDATE_API_PARITY=1 npm run test --workspace=@schedule-app/api.
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, "../../../crates/api/tests/fixtures");
const FIXTURE = resolve(FIXTURES, "ts_responses.json");
const BASE64_FIXTURE = resolve(FIXTURES, "node_base64.json");
const RUST_JWT_FIXTURE = resolve(FIXTURES, "rust_jwt.json");

/** Compares `actual` with the fixture file, or rewrites the file. */
function checkFixture(path: string, actual: unknown) {
  if (process.env.UPDATE_API_PARITY) {
    writeFileSync(path, JSON.stringify(actual, null, 2) + "\n");
  }
  expect(actual).toEqual(JSON.parse(readFileSync(path, "utf8")));
}

/** Varies per request or per connection rather than per server. */
const UNCOMPARED_HEADERS = ["date", "connection", "keep-alive", "content-length", "transfer-encoding"];

const CASES: { method: string; url: string }[] = [
  { method: "GET", url: "/nope" },
  { method: "GET", url: "/nope?x=%20&y=%22" },
  { method: "GET", url: "/health/" },
  { method: "POST", url: "/health" },
  { method: "OPTIONS", url: "/health" },
  { method: "DELETE", url: "/openapi.json" },
  { method: "HEAD", url: "/nope" },
  { method: "PATCH", url: "/a/b/c" },
  { method: "GET", url: "/Health" },
  // Paths find-my-way can't percent-decode: refused before routing.
  { method: "GET", url: "/nope/%zz" },
  { method: "POST", url: "/users/%zz/salt?q=%zz" },
  { method: "GET", url: "/users/%E2%82/salt" },
  { method: "GET", url: "/health%" },
  // Decodable paths, including escapes of reserved characters.
  { method: "GET", url: "/nope%2F%25" },
];

describe("responses the Rust server must reproduce", () => {
  let app: FastifyInstance;
  let db: Database;

  beforeAll(async () => {
    ({ app, db } = await setupTestApp());
  });

  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("match crates/api/tests/fixtures/ts_responses.json", async () => {
    const cases = [];
    for (const { method, url } of CASES) {
      const response = await app.inject({ method: method as "GET", url });
      const headers = Object.fromEntries(
        Object.entries(response.headers)
          .filter(([name]) => !UNCOMPARED_HEADERS.includes(name))
          .map(([name, value]) => [name, String(value)])
          .sort(([a], [b]) => a!.localeCompare(b!))
      );
      cases.push({ method, url, status: response.statusCode, headers, body: response.body });
    }
    checkFixture(FIXTURE, { uncomparedHeaders: UNCOMPARED_HEADERS, cases });
  });
});

// crates/api/tests/fixtures/ts_auth_responses.json, the TS server's replies
// on the auth routes, was recorded here before those routes were deleted
// (step 3b); it is now a frozen record, replayed by crates/api/tests/ts_parity.rs.

// --- Node's base64 decoder ---------------------------------------------------
// The auth verifier is sha256(Buffer.from(authKey, "base64")), so the Rust
// server must decode auth keys exactly as Node does, junk and all.

describe("Node's base64 decoding, which stored auth hashes depend on", () => {
  it("matches crates/api/tests/fixtures/node_base64.json", () => {
    const curated = [
      "", "Q", "QQ", "QQ=", "QQ==", "QQ===", "QUI", "QUJD", "QUJDRA", "d3JvbmctZ3Vlc3M=",
      "Q U J D", "Q\tU\nJ\rD", "-_-_", "+/+/", "!!!!", "QQ==QUJD", "=QUJD", "Q=UJD",
      "QUJD====", "QUJDR", "QUJDRA=x", "\u0141\u0141\u0141\u0141", "Q\u013dUJD", "QUJD\u013d",
      "😀QUJD", "QUJD😀", "QUJ😀D", "....QUJD", "QUJD....", "Q.U.J.D.", "QUJDRA==QUJD",
    ];
    // Deterministic pseudo-random strings over the characters that matter.
    const alphabet = ["A", "Q", "z", "0", "9", "+", "/", "-", "_", "=", " ", "\n", "!", "é", "\u013d", "\u0141", "😀"];
    let seed = 1;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    const generated: string[] = [];
    for (let n = 0; n < 2000; n++) {
      const length = next() % 24;
      let s = "";
      for (let i = 0; i < length; i++) s += alphabet[next() % alphabet.length];
      generated.push(s);
    }
    const cases = [...curated, ...generated].map((input) => ({
      input,
      hex: Buffer.from(input, "base64").toString("hex"),
    }));
    checkFixture(BASE64_FIXTURE, { cases });
  });
});

// --- Session tokens ------------------------------------------------------------

describe("session tokens the Rust server issues", () => {
  let app: FastifyInstance;
  let db: Database;

  beforeAll(async () => {
    ({ app, db } = await setupTestApp());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("are accepted by the TS server (crates/api/tests/fixtures/rust_jwt.json)", () => {
    // Written by crates/api/tests/auth.rs, signed with setupTestApp's secret.
    const { token, userId, iat } = JSON.parse(readFileSync(RUST_JWT_FIXTURE, "utf8"));
    const payload = app.jwt.verify<{ userId: string; iat: number; exp: number }>(token, {
      clockTimestamp: (iat + 60) * 1000,
    });
    expect(payload).toEqual({ userId, iat, exp: iat + 30 * 24 * 60 * 60 });
    // ...and expire when the TS server's own would.
    expect(() =>
      app.jwt.verify(token, { clockTimestamp: (iat + 30 * 24 * 60 * 60 + 1) * 1000 })
    ).toThrow();
  });
});
