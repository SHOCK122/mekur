import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Database } from "../src/db/pool.js";
import { deriveAuthAndEncryptionKeys, generateKeyPair } from "@schedule-app/crypto";
import { setupTestApp, truncateAll } from "./testHelpers.js";

const ENVELOPE = {
  v: 1,
  algo: "xchacha20poly1305",
  keyId: "k",
  nonce: "bm9uY2U=",
  ciphertext: "Y2lwaGVydGV4dA==",
};

async function registerUser(app: FastifyInstance, username: string) {
  const keys = await deriveAuthAndEncryptionKeys("some strong password");
  const { publicKey } = generateKeyPair();
  const response = await app.inject({
    method: "POST",
    url: "/users",
    payload: {
      username,
      displayName: username,
      publicKey,
      authKey: keys.authKey,
      authSalt: keys.salt,
    },
  });
  const body = response.json();
  return { userId: body.user.id as string, token: body.token as string };
}

function auth(token: string, capability?: string) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (capability) headers["x-event-capability"] = capability;
  return headers;
}

describe("capability-based events", () => {
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

  async function createEvent(userToken: string) {
    const response = await app.inject({
      method: "POST",
      url: "/events",
      headers: auth(userToken),
      payload: { envelope: ENVELOPE },
    });
    return response.json() as { event: { id: string }; viewToken: string; editToken: string };
  }

  it("returns view and edit tokens exactly once on creation", async () => {
    const alice = await registerUser(app, "alice");
    const created = await createEvent(alice.token);
    expect(created.viewToken).toBeTruthy();
    expect(created.editToken).toBeTruthy();
    expect(created.viewToken).not.toBe(created.editToken);
  }, 20_000);

  it("grants read to anyone holding the view token, regardless of which account they are", async () => {
    const alice = await registerUser(app, "alice");
    const bob = await registerUser(app, "bob");
    const created = await createEvent(alice.token);

    // Bob has no relationship to this event in any table -- the capability
    // alone is the authorisation. That is the whole point of the model.
    const response = await app.inject({
      method: "GET",
      url: `/events/${created.event.id}`,
      headers: auth(bob.token, created.viewToken),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().event.id).toBe(created.event.id);
  }, 20_000);

  it("refuses access without a capability, even to the account that created the event", async () => {
    const alice = await registerUser(app, "alice");
    const created = await createEvent(alice.token);

    // There is no notion of ownership: creating an event grants no standing
    // access. Alice keeps her tokens in her keyring, not in the database.
    const response = await app.inject({
      method: "GET",
      url: `/events/${created.event.id}`,
      headers: auth(alice.token),
    });
    expect(response.statusCode).toBe(404);
  }, 20_000);

  it("does not let a view token edit or delete", async () => {
    const alice = await registerUser(app, "alice");
    const created = await createEvent(alice.token);

    const edit = await app.inject({
      method: "PUT",
      url: `/events/${created.event.id}`,
      headers: auth(alice.token, created.viewToken),
      payload: { envelope: ENVELOPE },
    });
    expect(edit.statusCode).toBe(404);

    const remove = await app.inject({
      method: "DELETE",
      url: `/events/${created.event.id}`,
      headers: auth(alice.token, created.viewToken),
    });
    expect(remove.statusCode).toBe(404);
  }, 20_000);

  it("lets an edit token both read and write, since edit implies view", async () => {
    const alice = await registerUser(app, "alice");
    const created = await createEvent(alice.token);

    const read = await app.inject({
      method: "GET",
      url: `/events/${created.event.id}`,
      headers: auth(alice.token, created.editToken),
    });
    expect(read.statusCode).toBe(200);

    const edit = await app.inject({
      method: "PUT",
      url: `/events/${created.event.id}`,
      headers: auth(alice.token, created.editToken),
      payload: { envelope: { ...ENVELOPE, ciphertext: "dXBkYXRlZA==" } },
    });
    expect(edit.statusCode).toBe(200);
  }, 20_000);

  it("returns 404 rather than 403 for a wrong capability, so ids can't be probed", async () => {
    const alice = await registerUser(app, "alice");
    const created = await createEvent(alice.token);

    const wrongToken = await app.inject({
      method: "GET",
      url: `/events/${created.event.id}`,
      headers: auth(alice.token, "not-a-real-token"),
    });
    const missingEvent = await app.inject({
      method: "GET",
      url: `/events/6c84fb90-12c4-11e1-840d-7b25c5ee775a`,
      headers: auth(alice.token, "not-a-real-token"),
    });
    // Identical responses: a different status would confirm the event
    // exists to someone guessing ids.
    expect(wrongToken.statusCode).toBe(404);
    expect(missingEvent.statusCode).toBe(404);
    expect(wrongToken.json()).toEqual(missingEvent.json());
  }, 20_000);

  it("mints a reusable join capability, and revokes it", async () => {
    const alice = await registerUser(app, "alice");
    const bob = await registerUser(app, "bob");
    const created = await createEvent(alice.token);

    const minted = await app.inject({
      method: "POST",
      url: `/events/${created.event.id}/capabilities`,
      headers: auth(alice.token, created.editToken),
      payload: { level: "view" },
    });
    expect(minted.statusCode).toBe(201);
    const joinToken = minted.json().token as string;

    // Reusable: works more than once, unlike a friend code.
    for (let i = 0; i < 3; i++) {
      const used = await app.inject({
        method: "GET",
        url: `/events/${created.event.id}`,
        headers: auth(bob.token, joinToken),
      });
      expect(used.statusCode).toBe(200);
    }

    const revoked = await app.inject({
      method: "POST",
      url: `/events/${created.event.id}/capabilities/revoke`,
      headers: auth(alice.token, created.editToken),
      payload: { token: joinToken },
    });
    expect(revoked.statusCode).toBe(204);

    const afterRevoke = await app.inject({
      method: "GET",
      url: `/events/${created.event.id}`,
      headers: auth(bob.token, joinToken),
    });
    expect(afterRevoke.statusCode).toBe(404);
  }, 20_000);

  it("will not mint or revoke with only a view capability", async () => {
    const alice = await registerUser(app, "alice");
    const created = await createEvent(alice.token);
    const attempt = await app.inject({
      method: "POST",
      url: `/events/${created.event.id}/capabilities`,
      headers: auth(alice.token, created.viewToken),
      payload: { level: "edit" },
    });
    expect(attempt.statusCode).toBe(404);
  }, 20_000);

  it("batch-reads only the events whose capabilities are presented", async () => {
    const alice = await registerUser(app, "alice");
    const mine = await createEvent(alice.token);
    const other = await createEvent(alice.token);

    const response = await app.inject({
      method: "POST",
      url: "/events/batch-read",
      headers: auth(alice.token),
      payload: {
        events: [
          { eventId: mine.event.id, token: mine.viewToken },
          // Correct id, wrong token -- must be silently omitted.
          { eventId: other.event.id, token: "wrong-token" },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    const ids = response.json().events.map((e: { id: string }) => e.id);
    expect(ids).toEqual([mine.event.id]);
  }, 20_000);

  it("accepts a DELETE that declares a JSON content-type but sends no body", async () => {
    // Regression: the client sent Content-Type: application/json on DELETE
    // with no body, and Fastify rejected it outright with
    // FST_ERR_CTP_EMPTY_JSON_BODY -- surfacing to the user as a bare
    // "Bad Request" when they tried to delete an event.
    const alice = await registerUser(app, "alice");
    const created = await createEvent(alice.token);

    const response = await app.inject({
      method: "DELETE",
      url: `/events/${created.event.id}`,
      headers: {
        ...auth(alice.token, created.editToken),
        "content-type": "application/json",
      },
    });
    expect(response.statusCode).toBe(204);
  }, 20_000);

  it("still rejects malformed JSON rather than silently treating it as empty", async () => {
    const alice = await registerUser(app, "alice");
    const response = await app.inject({
      method: "POST",
      url: "/events",
      headers: { ...auth(alice.token), "content-type": "application/json" },
      payload: "{not valid json",
    });
    expect(response.statusCode).toBe(400);
  }, 20_000);
});

describe("keyring", () => {
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

  it("starts empty at version 0 for a new account", async () => {
    const alice = await registerUser(app, "alice");
    const response = await app.inject({
      method: "GET",
      url: "/keyring",
      headers: auth(alice.token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ keyring: null, version: 0 });
  }, 20_000);

  it("round-trips and increments version", async () => {
    const alice = await registerUser(app, "alice");
    const first = await app.inject({
      method: "PUT",
      url: "/keyring",
      headers: auth(alice.token),
      payload: { envelope: ENVELOPE, expectedVersion: 0 },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().version).toBe(1);

    const second = await app.inject({
      method: "PUT",
      url: "/keyring",
      headers: auth(alice.token),
      payload: { envelope: ENVELOPE, expectedVersion: 1 },
    });
    expect(second.json().version).toBe(2);
  }, 20_000);

  it("rejects a stale write rather than silently clobbering another device", async () => {
    // Losing a keyring write means permanently losing access to whatever
    // events it was adding, so this must never be last-write-wins.
    const alice = await registerUser(app, "alice");
    await app.inject({
      method: "PUT",
      url: "/keyring",
      headers: auth(alice.token),
      payload: { envelope: ENVELOPE, expectedVersion: 0 },
    });

    const stale = await app.inject({
      method: "PUT",
      url: "/keyring",
      headers: auth(alice.token),
      payload: { envelope: ENVELOPE, expectedVersion: 0 },
    });
    expect(stale.statusCode).toBe(409);
  }, 20_000);

  it("keeps keyrings private to their account", async () => {
    const alice = await registerUser(app, "alice");
    const bob = await registerUser(app, "bob");
    await app.inject({
      method: "PUT",
      url: "/keyring",
      headers: auth(alice.token),
      payload: { envelope: ENVELOPE, expectedVersion: 0 },
    });
    const bobsView = await app.inject({
      method: "GET",
      url: "/keyring",
      headers: auth(bob.token),
    });
    expect(bobsView.json().keyring).toBeNull();
  }, 20_000);
});

describe("inbox", () => {
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

  it("delivers to a recipient and lets them read and dismiss it", async () => {
    const alice = await registerUser(app, "alice");
    const bob = await registerUser(app, "bob");

    const delivered = await app.inject({
      method: "POST",
      url: "/inbox/deliver",
      headers: auth(alice.token),
      payload: { recipientId: bob.userId, envelope: ENVELOPE },
    });
    expect(delivered.statusCode).toBe(204);

    const listed = await app.inject({ method: "GET", url: "/inbox", headers: auth(bob.token) });
    expect(listed.json().messages).toHaveLength(1);

    const messageId = listed.json().messages[0].id;
    const dismissed = await app.inject({
      method: "DELETE",
      url: `/inbox/${messageId}`,
      headers: auth(bob.token),
    });
    expect(dismissed.statusCode).toBe(204);
  }, 20_000);

  it("stores no sender, so the delivery table cannot rebuild the social graph", async () => {
    const alice = await registerUser(app, "alice");
    const bob = await registerUser(app, "bob");
    await app.inject({
      method: "POST",
      url: "/inbox/deliver",
      headers: auth(alice.token),
      payload: { recipientId: bob.userId, envelope: ENVELOPE },
    });

    // Inspect the raw row: nothing in it may point back at Alice.
    const raw = await db.query("SELECT * FROM inbox_messages");
    const row = raw.rows[0] as Record<string, unknown>;
    expect(Object.keys(row)).not.toContain("sender_id");
    expect(JSON.stringify(row)).not.toContain(alice.userId);
  }, 20_000);

  it("does not let one account read another's inbox", async () => {
    const alice = await registerUser(app, "alice");
    const bob = await registerUser(app, "bob");
    await app.inject({
      method: "POST",
      url: "/inbox/deliver",
      headers: auth(alice.token),
      payload: { recipientId: bob.userId, envelope: ENVELOPE },
    });
    const alicesInbox = await app.inject({
      method: "GET",
      url: "/inbox",
      headers: auth(alice.token),
    });
    expect(alicesInbox.json().messages).toHaveLength(0);
  }, 20_000);
});