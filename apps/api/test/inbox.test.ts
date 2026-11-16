import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Database } from "../src/db/pool.js";
import { setupTestApp, truncateAll, registerUser, auth, SEALED_ENVELOPE } from "./testHelpers.js";

// The "capability-based events" tests moved to the Rust server with the
// event routes (crates/api/tests/events.rs, step 3d of
// docs/RUST_MIGRATION.md), and the keyring tests with the keyring routes
// (crates/api/tests/keyring.rs, step 3e).

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