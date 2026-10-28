import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Database } from "../src/db/pool.js";
import { setupTestApp, truncateAll, registerUser, ENVELOPE } from "./testHelpers.js";

describe("API keys", () => {
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

  it("mints a key and returns the raw value exactly once", async () => {
    const { token } = await registerUser(app, "alice");
    const response = await app.inject({
      method: "POST",
      url: "/api-keys",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "my agent" },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.rawKey).toMatch(/^sak_/);
    expect(body.apiKey.keyPrefix).toBe(body.rawKey.slice(0, body.apiKey.keyPrefix.length));
    // The stored record never includes the raw key or its hash.
    expect(body.apiKey).not.toHaveProperty("rawKey");
    expect(body.apiKey).not.toHaveProperty("keyHash");
  });

  it("authenticates ordinary API requests using a minted API key, same as a JWT would", async () => {
    const { token } = await registerUser(app, "bob");
    const mintResp = await app.inject({
      method: "POST",
      url: "/api-keys",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "agent key" },
    });
    const rawKey = mintResp.json().rawKey;

    const envelope = ENVELOPE;
    const createResp = await app.inject({
      method: "POST",
      url: "/events",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { envelope },
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
    const { token } = await registerUser(app, "carol");
    const mintResp = await app.inject({
      method: "POST",
      url: "/api-keys",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "temp key" },
    });
    const { rawKey, apiKey } = mintResp.json();

    const beforeRevoke = await app.inject({
      method: "GET",
      url: "/keyring",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(beforeRevoke.statusCode).toBe(200);

    const revokeResp = await app.inject({
      method: "DELETE",
      url: `/api-keys/${apiKey.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revokeResp.statusCode).toBe(204);

    const afterRevoke = await app.inject({
      method: "GET",
      url: "/keyring",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(afterRevoke.statusCode).toBe(401);
  });

  it("lists only the authenticated user's own keys, and cannot revoke someone else's", async () => {
    const alice = await registerUser(app, "alice2");
    const bob = await registerUser(app, "bob2");

    const aliceKeyResp = await app.inject({
      method: "POST",
      url: "/api-keys",
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { name: "alice's key" },
    });
    const aliceKeyId = aliceKeyResp.json().apiKey.id;

    const bobList = await app.inject({
      method: "GET",
      url: "/api-keys",
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(bobList.json().apiKeys).toHaveLength(0);

    const bobRevokeAttempt = await app.inject({
      method: "DELETE",
      url: `/api-keys/${aliceKeyId}`,
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(bobRevokeAttempt.statusCode).toBe(404);
  });

  it("will not mint a new API key when authenticated with an API key", async () => {
    // Otherwise one leaked key becomes a self-renewing set that survives
    // its own revocation.
    const { token } = await registerUser(app, "dave");
    const mintResp = await app.inject({
      method: "POST",
      url: "/api-keys",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "agent" },
    });
    const { rawKey } = mintResp.json();

    const attempt = await app.inject({
      method: "POST",
      url: "/api-keys",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { name: "escalation" },
    });
    expect(attempt.statusCode).toBe(403);
  });
});
