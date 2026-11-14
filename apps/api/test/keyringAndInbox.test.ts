import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Database } from "../src/db/pool.js";
import { setupTestApp, truncateAll, registerUser, auth, ENVELOPE, SEALED_ENVELOPE } from "./testHelpers.js";

// The "capability-based events" tests moved to the Rust server with the
// event routes: crates/api/tests/events.rs (step 3d of
// docs/RUST_MIGRATION.md).

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
      payload: { recipientId: bob.userId, envelope: SEALED_ENVELOPE },
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
      payload: { recipientId: bob.userId, envelope: SEALED_ENVELOPE },
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
      payload: { recipientId: bob.userId, envelope: SEALED_ENVELOPE },
    });
    const alicesInbox = await app.inject({
      method: "GET",
      url: "/inbox",
      headers: auth(alice.token),
    });
    expect(alicesInbox.json().messages).toHaveLength(0);
  }, 20_000);

  it("rejects an envelope that isn't sealed, rather than storing arbitrary JSON", async () => {
    const alice = await registerUser(app, "alice");
    const bob = await registerUser(app, "bob");
    const response = await app.inject({
      method: "POST",
      url: "/inbox/deliver",
      headers: auth(alice.token),
      payload: { recipientId: bob.userId, envelope: { anything: "goes" } },
    });
    expect(response.statusCode).toBe(400);
  });
});