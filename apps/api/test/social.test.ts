import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Database } from "../src/db/pool.js";
import { setupTestApp, truncateAll, registerUser, auth } from "./testHelpers.js";

describe("friend codes and tags", () => {
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

  async function codeOf(token: string): Promise<string> {
    const response = await app.inject({ method: "GET", url: "/friend-code", headers: auth(token) });
    return response.json().friendCode.code as string;
  }

  function resolve(token: string, tag: string) {
    return app.inject({ method: "POST", url: "/tags/resolve", headers: auth(token), payload: { tag } });
  }

  it("returns the same code until it is used or rotated", async () => {
    const alice = await registerUser(app, "alice");
    const first = await codeOf(alice.token);
    expect(first).toMatch(/^[23456789A-HJKMNP-Z]{8}$/);
    expect(await codeOf(alice.token)).toBe(first);

    const rotated = await app.inject({ method: "POST", url: "/friend-code/rotate", headers: auth(alice.token) });
    expect(rotated.json().friendCode.code).not.toBe(first);
  });

  it("resolves a code anonymously, consumes it, and issues a replacement", async () => {
    const alice = await registerUser(app, "alice");
    const bob = await registerUser(app, "bob");
    const code = await codeOf(alice.token);

    const resolved = await resolve(bob.token, code);
    expect(resolved.statusCode).toBe(200);
    const target = resolved.json().target;
    expect(target.userId).toBe(alice.userId);
    expect(target.viaCode).toBe(true);
    expect(target).not.toHaveProperty("username");
    expect(target.displayName).not.toBe("alice");

    expect((await resolve(bob.token, code)).statusCode).toBe(404);
    expect(await codeOf(alice.token)).not.toBe(code);
  });

  it("records nothing about who redeemed whose code", async () => {
    const alice = await registerUser(app, "alice");
    const bob = await registerUser(app, "bob");
    await resolve(bob.token, await codeOf(alice.token));

    const rows = await db.query("SELECT * FROM friend_codes");
    expect(JSON.stringify(rows.rows)).not.toContain(bob.userId);
  });

  it("won't resolve your own code, with the same answer as an unknown one", async () => {
    const alice = await registerUser(app, "alice");
    const own = await resolve(alice.token, await codeOf(alice.token));
    const unknown = await resolve(alice.token, "ZZZZZZZZ");
    expect(own.statusCode).toBe(404);
    expect(own.json()).toEqual(unknown.json());
  });

  it("resolves a username to a named target", async () => {
    const alice = await registerUser(app, "alice");
    const bob = await registerUser(app, "bob");
    const resolved = await resolve(alice.token, "Bob");
    expect(resolved.json().target).toMatchObject({
      userId: bob.userId,
      username: "bob",
      publicKey: bob.keyPair.publicKey,
      viaCode: false,
    });
  });
});
