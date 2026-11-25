import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Database } from "../src/db/pool.js";
import { createPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";
import { buildApp } from "../src/app.js";
import { truncateAll, registerUser, ENVELOPE } from "./testHelpers.js";
import { parseTrustProxy } from "../src/config.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/scheduleapp_test";

/** Builds an app with production-like (low) rate limits, unlike the shared
 * test helper which raises them to avoid flakes. */
async function setupStrictApp(authRateLimitMax: number, trustProxy: string[] | false = false) {
  const db = createPool(TEST_DATABASE_URL);
  await runMigrations(db);
  const app = buildApp({
    db,
    jwtSecret: "test-secret",
    vapidPublicKey: "BAHQnCgvhlb0-G5wOocrFTe7zK7ewUJ7AR7ZCYGA2rfaGlueYTazRM-fTiZUrkJUlM2SmKbdUALS1FzUnSiFbUI",
    vapidPrivateKey: "qUFTF3lXxouxuo_n0kPvwpMn2Ehl3W51M8Aw3vap5QQ",
    vapidSubject: "mailto:test@example.com",
    rateLimitMax: 100_000,
    authRateLimitMax,
    trustProxy,
  });
  return { app, db };
}

describe("TRUST_PROXY parsing", () => {
  it("trusts nothing when unset or empty", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy(" ")).toBe(false);
  });

  it("accepts addresses, ranges and named groups", () => {
    expect(parseTrustProxy("uniquelocal, 10.0.0.1,172.16.0.0/12")).toEqual([
      "uniquelocal",
      "10.0.0.1",
      "172.16.0.0/12",
    ]);
  });

  it("rejects a hop count, which Fastify now treats as trusting nothing", () => {
    // Regression: TRUST_PROXY=1 silently stopped working with Fastify 5.12.
    expect(() => parseTrustProxy("1")).toThrow(/no longer takes a hop count/);
  });
});

describe("security hardening", () => {
  describe("rate limiting on auth endpoints", () => {
    let app: FastifyInstance;
    let db: Database;

    beforeAll(async () => {
      ({ app, db } = await setupStrictApp(3));
    });

    afterAll(async () => {
      await app.close();
      await db.end();
    });

    it("throttles repeated login attempts, so the endpoint isn't brute-forceable", async () => {
      const attempt = () =>
        app.inject({
          method: "POST",
          url: "/sessions",
          payload: { username: "victim", authKey: "d3JvbmctZ3Vlc3M=" },
        });

      // Within the limit: rejected on the merits (401), not throttled.
      const first = await attempt();
      expect([401, 400]).toContain(first.statusCode);

      // Keep hammering; the limiter must kick in rather than allowing
      // unlimited guesses.
      let sawRateLimit = false;
      for (let i = 0; i < 10; i++) {
        const response = await attempt();
        if (response.statusCode === 429) {
          sawRateLimit = true;
          break;
        }
      }
      expect(sawRateLimit).toBe(true);
    }, 20_000);
  });

  describe("rate limiting behind a reverse proxy", () => {
    let app: FastifyInstance;
    let db: Database;

    beforeAll(async () => {
      // Injected requests arrive from 127.0.0.1, standing in for nginx.
      ({ app, db } = await setupStrictApp(2, ["loopback"]));
    });

    afterAll(async () => {
      await app.close();
      await db.end();
    });

    it("limits each client separately rather than everyone behind the proxy together", async () => {
      // Without trusting the proxy, every request appears to come from
      // nginx, so one person's failed logins would lock out every user.
      const attempt = (client: string) =>
        app.inject({
          method: "POST",
          url: "/sessions",
          headers: { "x-forwarded-for": client },
          payload: { username: "victim", authKey: "d3JvbmctZ3Vlc3M=" },
        });
      for (let i = 0; i < 5; i++) await attempt("203.0.113.1");
      expect((await attempt("203.0.113.1")).statusCode).toBe(429);
      expect((await attempt("203.0.113.2")).statusCode).toBe(401);
    });
  });

  describe("forwarded IPs from an untrusted peer", () => {
    let app: FastifyInstance;
    let db: Database;

    beforeAll(async () => {
      // Only private ranges are trusted, so a request from 127.0.0.1 is a
      // direct client, not the proxy.
      ({ app, db } = await setupStrictApp(2, ["uniquelocal"]));
    });

    afterAll(async () => {
      await app.close();
      await db.end();
    });

    it("ignores X-Forwarded-For, so a client can't dodge the limit by faking it", async () => {
      const attempt = (client: string) =>
        app.inject({
          method: "POST",
          url: "/sessions",
          headers: { "x-forwarded-for": client },
          payload: { username: "victim", authKey: "d3JvbmctZ3Vlc3M=" },
        });
      for (let i = 0; i < 5; i++) await attempt("203.0.113.1");
      expect((await attempt("203.0.113.99")).statusCode).toBe(429);
    });
  });

  describe("headers, tokens, and payload bounds", () => {
    let app: FastifyInstance;
    let db: Database;

    beforeAll(async () => {
      ({ app, db } = await setupStrictApp(100_000));
    });

    beforeEach(async () => {
      await truncateAll(db);
    });

    afterAll(async () => {
      await app.close();
      await db.end();
    });

    it("sends security headers that mitigate clickjacking and content injection", async () => {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.headers["content-security-policy"]).toBeDefined();
      expect(String(response.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("issues session tokens that actually expire", async () => {
      const { token } = await registerUser(app, "expiryuser");

      // A JWT without an exp claim would be valid forever, which is what
      // this guards against.
      const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
      expect(payload.exp).toBeDefined();
      expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    }, 20_000);

    it("rejects an oversized encrypted payload instead of storing unbounded blobs", async () => {
      const { token } = await registerUser(app, "bigpayload");

      const response = await app.inject({
        method: "POST",
        url: "/events",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          envelope: {
            v: 1,
            algo: "xchacha20poly1305",
            keyId: "k",
            nonce: "bm9uY2U=",
            ciphertext: "A".repeat(200 * 1024), // over the 128KB event cap
          },
        },
      });
      // Either schema validation (400) or the body limit (413) stops it --
      // what matters is that it does not succeed.
      expect([400, 413]).toContain(response.statusCode);
    }, 20_000);

    it("still accepts a normally-sized encrypted event", async () => {
      const { token } = await registerUser(app, "normalpayload");

      const response = await app.inject({
        method: "POST",
        url: "/events",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          envelope: ENVELOPE,
        },
      });
      expect(response.statusCode).toBe(201);
    }, 20_000);

    it("returns 404, not a 500, for a malformed UUID path param (found during bughunt)", async () => {
      // Previously the malformed id reached Postgres, which throws on the
      // invalid uuid cast, surfacing as an unhandled 500 -- both the wrong
      // status (the resource simply isn't there) and a hint about internals.
      const { token } = await registerUser(app, "uuidguard");
      const auth = { authorization: `Bearer ${token}` };

      const getResponse = await app.inject({
        method: "GET",
        url: "/events/not-a-uuid",
        headers: { ...auth, "x-event-capability": "anything" },
      });
      expect(getResponse.statusCode).toBe(404);

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: "/events/also-not-a-uuid",
        headers: auth,
      });
      expect(deleteResponse.statusCode).toBe(404);

      const apiKeyResponse = await app.inject({
        method: "DELETE",
        url: "/api-keys/still-not-a-uuid",
        headers: auth,
      });
      expect(apiKeyResponse.statusCode).toBe(404);
    }, 20_000);

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
