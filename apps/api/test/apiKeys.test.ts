import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Database } from "../src/db/pool.js";
import { setupTestApp, truncateAll, registerUser, ENVELOPE } from "./testHelpers.js";

// The API-key routes (mint, list, revoke) are served by the Rust server now
// -- crates/api/tests/api_keys.rs ported their tests, step 3c of
// docs/RUST_MIGRATION.md. What stays here is the TS server's side of the
// contract: its auth plugin accepts a key in the format the Rust server
// mints and stores, on the routes it still serves, until that key is
// revoked.

/** Inserts a key as the Rust server's POST /api-keys stores it. */
async function mintKey(db: Database, userId: string) {
  const rawKey = "sak_" + randomBytes(24).toString("base64url");
  const keyHash = createHash("sha256").update(rawKey, "utf8").digest("base64");
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES ($1, 'agent', $2, $3) RETURNING id`,
    [userId, rawKey.slice(0, 12), keyHash]
  );
  return { rawKey, id: rows[0]!.id };
}

describe("API keys on the TS server's routes", () => {
  let app: FastifyInstance;
  let db: Database;

  beforeAll(async () => {
    ({ app, db } = await setupTestApp());
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("authenticates ordinary API requests using an API key, same as a JWT would", async () => {
    const { userId } = await registerUser(app, "bob");
    const { rawKey } = await mintKey(db, userId);

    const createResp = await app.inject({
      method: "POST",
      url: "/events",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { envelope: ENVELOPE },
    });
    expect(createResp.statusCode).toBe(201);
    const { event, viewToken } = createResp.json();

    // Reading back requires the capability, not the identity -- the API key
    // authenticates the request, the token authorises the event.
    const readResp = await app.inject({
      method: "GET",
      url: `/events/${event.id}`,
      headers: { authorization: `Bearer ${rawKey}`, "x-event-capability": viewToken },
    });
    expect(readResp.statusCode).toBe(200);

    const { rows } = await db.query("SELECT last_used_at FROM api_keys");
    expect(rows[0].last_used_at).not.toBeNull();
  });

  it("rejects an unknown or malformed API key", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/keyring",
      headers: { authorization: "Bearer sak_not_a_real_key" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("stops working immediately after revocation", async () => {
    const { userId } = await registerUser(app, "carol");
    const { rawKey, id } = await mintKey(db, userId);
    const keyring = () =>
      app.inject({ method: "GET", url: "/keyring", headers: { authorization: `Bearer ${rawKey}` } });

    expect((await keyring()).statusCode).toBe(200);
    // What the Rust server's DELETE /api-keys/:id does.
    await db.query("DELETE FROM api_keys WHERE id = $1", [id]);
    expect((await keyring()).statusCode).toBe(401);
  });
});
