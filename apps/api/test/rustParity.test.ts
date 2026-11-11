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
const FIXTURE = resolve(here, "../../../crates/api/tests/fixtures/ts_responses.json");

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
    const actual = { uncomparedHeaders: UNCOMPARED_HEADERS, cases };
    if (process.env.UPDATE_API_PARITY) {
      writeFileSync(FIXTURE, JSON.stringify(actual, null, 2) + "\n");
    }
    expect(actual).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
  });
});
