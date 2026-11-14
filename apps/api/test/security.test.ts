import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Database } from "../src/db/pool.js";
import { createPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";
import { buildApp } from "../src/app.js";
import { truncateAll, registerUser, buildTestApp, ENVELOPE, TEST_DATABASE_URL, TEST_VAPID } from "./testHelpers.js";

/** Builds an app with a production-like (low) global rate limit, unlike the
 * shared test helper which raises it to avoid flakes. */
async function setupStrictApp(rateLimitMax: number, trustProxy = 0) {
  const db = createPool(TEST_DATABASE_URL);
  await runMigrations(db);
  const app = buildApp({ db, jwtSecret: "test-secret", ...TEST_VAPID, rateLimitMax, trustProxy });
  return { app, db };
}

// Login and registration, with their own tighter limits, moved to the Rust
// server (crates/api/tests/rate_limit.rs). These check the global limit
// the TS server still applies to its remaining routes.
describe("security hardening", () => {
  describe("the global rate limit", () => {
    let app: FastifyInstance;
    let db: Database;

    beforeAll(async () => {
      ({ app, db } = await setupStrictApp(3));
    });

    afterAll(async () => {
      await app.close();
      await db.end();
    });

    it("throttles a client that keeps calling, rather than allowing unlimited requests", async () => {
      const attempt = () => app.inject({ method: "GET", url: "/push/vapid-public-key" });
      expect((await attempt()).statusCode).toBe(200);
      let sawRateLimit = false;
      for (let i = 0; i < 10; i++) {
        if ((await attempt()).statusCode === 429) {
          sawRateLimit = true;
          break;
        }
      }
      expect(sawRateLimit).toBe(true);
    });
  });

  describe("rate limiting behind a reverse proxy", () => {
    let app: FastifyInstance;
    let db: Database;

    beforeAll(async () => {
      ({ app, db } = await setupStrictApp(2, 1));
    });

    afterAll(async () => {
      await app.close();
      await db.end();
    });

    it("limits each client separately rather than everyone behind the proxy together", async () => {
      // Without trusting the proxy, every request appears to come from
      // nginx, so one client's requests would lock out every user.
      const attempt = (client: string) =>
        app.inject({
          method: "GET",
          url: "/push/vapid-public-key",
          headers: { "x-forwarded-for": client },
        });
      for (let i = 0; i < 5; i++) await attempt("203.0.113.1");
      expect((await attempt("203.0.113.1")).statusCode).toBe(429);
      expect((await attempt("203.0.113.2")).statusCode).toBe(200);
    });
  });

  describe("headers, tokens, and payload bounds", () => {
    let app: FastifyInstance;
    let db: Database;

    beforeAll(async () => {
      db = createPool(TEST_DATABASE_URL);
      await runMigrations(db);
      app = buildTestApp(db);
    });

    beforeEach(async () => {
      await truncateAll(db);
    });

    afterAll(async () => {
      await app.close();
      await db.end();
    });

    it("sends security headers that mitigate clickjacking and content injection", async () => {
      // Any response: /health itself is now served by the Rust server.
      const response = await app.inject({ method: "GET", url: "/keyring" });
      expect(response.headers["content-security-policy"]).toBeDefined();
      expect(String(response.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    });

    // The event payload caps and the malformed-UUID 404s moved to the Rust
    // server with the event routes (crates/api/tests/events.rs, step 3d).

    it("accepts a keyring larger than the global body limit, up to its own cap", async () => {
      const { token } = await registerUser(app, "bigkeyring");
      const response = await app.inject({
        method: "PUT",
        url: "/keyring",
        headers: { authorization: `Bearer ${token}` },
        payload: { envelope: { ...ENVELOPE, ciphertext: "A".repeat(400 * 1024) }, expectedVersion: 0 },
      });
      expect(response.statusCode).toBe(200);
    });
  });
});
