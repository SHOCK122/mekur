import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Database } from "../src/db/pool.js";
import {
  deriveAuthAndEncryptionKeys,
  encryptEnvelope,
  generateKeyPair,
} from "@schedule-app/crypto";
import { setupTestApp, truncateAll } from "./testHelpers.js";

async function registerAndGetToken(app: FastifyInstance, username: string) {
  const keys = await deriveAuthAndEncryptionKeys("some strong password");
  const { publicKey } = generateKeyPair();
  const response = await app.inject({
    method: "POST",
    url: "/users",
    payload: {
      username,
      displayName: "Test User",
      publicKey,
      authKey: keys.authKey,
      authSalt: keys.salt,
    },
  });
  const body = response.json();
  return { token: body.token as string, userId: body.user.id as string, encryptionKey: keys.encryptionKey };
}

describe("event routes", () => {
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

  it("rejects unauthenticated requests", async () => {
    const response = await app.inject({ method: "GET", url: "/events" });
    expect(response.statusCode).toBe(401);
  });

  it("creates, lists, reads, updates, and deletes an event for the authenticated owner", async () => {
    const { token, encryptionKey } = await registerAndGetToken(app, "owner1");
    const auth = { authorization: `Bearer ${token}` };

    const envelope = encryptEnvelope(
      { title: "Team sync", startTime: "2026-08-01T10:00:00.000Z", endTime: "2026-08-01T10:30:00.000Z" },
      encryptionKey,
      "user-key-1"
    );

    const createResp = await app.inject({
      method: "POST",
      url: "/events",
      headers: auth,
      payload: { envelope },
    });
    expect(createResp.statusCode).toBe(201);
    const created = createResp.json().event;
    expect(created.envelope.ciphertext).toBe(envelope.ciphertext);

    const listResp = await app.inject({ method: "GET", url: "/events", headers: auth });
    expect(listResp.statusCode).toBe(200);
    expect(listResp.json().events).toHaveLength(1);

    const getResp = await app.inject({
      method: "GET",
      url: `/events/${created.id}`,
      headers: auth,
    });
    expect(getResp.statusCode).toBe(200);
    expect(getResp.json().event.id).toBe(created.id);

    const newEnvelope = encryptEnvelope(
      { title: "Team sync (rescheduled)", startTime: "2026-08-02T10:00:00.000Z", endTime: "2026-08-02T10:30:00.000Z" },
      encryptionKey,
      "user-key-1"
    );
    const updateResp = await app.inject({
      method: "PUT",
      url: `/events/${created.id}`,
      headers: auth,
      payload: { envelope: newEnvelope },
    });
    expect(updateResp.statusCode).toBe(200);
    expect(updateResp.json().event.envelope.ciphertext).toBe(newEnvelope.ciphertext);

    const deleteResp = await app.inject({
      method: "DELETE",
      url: `/events/${created.id}`,
      headers: auth,
    });
    expect(deleteResp.statusCode).toBe(204);

    const getAfterDelete = await app.inject({
      method: "GET",
      url: `/events/${created.id}`,
      headers: auth,
    });
    expect(getAfterDelete.statusCode).toBe(404);
  });

  it("never lets one user read, update, or delete another user's event", async () => {
    const owner = await registerAndGetToken(app, "owner2");
    const intruder = await registerAndGetToken(app, "intruder");

    const envelope = encryptEnvelope({ title: "Private" }, owner.encryptionKey, "user-key-1");
    const createResp = await app.inject({
      method: "POST",
      url: "/events",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { envelope },
    });
    const eventId = createResp.json().event.id;

    const intruderAuth = { authorization: `Bearer ${intruder.token}` };

    const getResp = await app.inject({ method: "GET", url: `/events/${eventId}`, headers: intruderAuth });
    expect(getResp.statusCode).toBe(404);

    const updateResp = await app.inject({
      method: "PUT",
      url: `/events/${eventId}`,
      headers: intruderAuth,
      payload: { envelope },
    });
    expect(updateResp.statusCode).toBe(404);

    const deleteResp = await app.inject({
      method: "DELETE",
      url: `/events/${eventId}`,
      headers: intruderAuth,
    });
    expect(deleteResp.statusCode).toBe(404);

    // Confirm it's still there for the real owner, untouched.
    const ownerGet = await app.inject({
      method: "GET",
      url: `/events/${eventId}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(ownerGet.statusCode).toBe(200);
  });

  it("rejects a malformed envelope", async () => {
    const { token } = await registerAndGetToken(app, "owner3");
    const response = await app.inject({
      method: "POST",
      url: "/events",
      headers: { authorization: `Bearer ${token}` },
      payload: { envelope: { not: "valid" } },
    });
    expect(response.statusCode).toBe(400);
  });
});
