import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Database } from "../src/db/pool.js";
import { generateKeyPair, sealToRecipient, openSealed } from "@schedule-app/crypto";
import { setupTestApp, truncateAll, registerUser, auth } from "./testHelpers.js";

/**
 * Accounts created before the identity keypair was derived from the
 * password registered a RANDOM public key whose private half was thrown
 * away. Anything sealed to it is unreadable (the original "invalid tag"
 * bug). Login repairs it -- and only login, because replacing a public key
 * redirects every future invitation.
 */
describe("public key repair on login", () => {
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

  async function resolvedKey(asToken: string, username: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/tags/resolve",
      headers: auth(asToken),
      payload: { tag: username },
    });
    return response.json().target.publicKey as string;
  }

  it("reproduces the original failure: a stale stored key makes sealed envelopes unreadable", async () => {
    const stale = await registerUser(app, "stale");
    const derived = generateKeyPair(); // what the client actually holds
    const sealed = sealToRecipient({ hi: 1 }, stale.keyPair.publicKey);
    expect(() => openSealed(sealed, derived.secretKey)).toThrow();
  });

  it("replaces a stale key when login presents the derived one", async () => {
    const stale = await registerUser(app, "stale");
    const sender = await registerUser(app, "sender");
    const derived = generateKeyPair();

    const login = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { username: "stale", authKey: stale.authKey, publicKey: derived.publicKey },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.publicKey).toBe(derived.publicKey);

    // Senders now seal to the repaired key, which the client can open.
    const key = await resolvedKey(sender.token, "stale");
    expect(key).toBe(derived.publicKey);
    const opened = openSealed(sealToRecipient({ hi: 1 }, key), derived.secretKey);
    expect(opened.payload).toEqual({ hi: 1 });
  });

  it("does not replace the key on a failed login", async () => {
    const victim = await registerUser(app, "victim");
    const attacker = await registerUser(app, "attacker");
    const attackerKey = generateKeyPair();

    const login = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { username: "victim", authKey: attacker.authKey, publicKey: attackerKey.publicKey },
    });
    expect(login.statusCode).toBe(401);
    expect(await resolvedKey(attacker.token, "victim")).toBe(victim.keyPair.publicKey);
  });

  it("offers no other way to rewrite a key, so a stolen token can't redirect invitations", async () => {
    const victim = await registerUser(app, "victim");
    const response = await app.inject({
      method: "PUT",
      url: "/users/me/public-key",
      headers: auth(victim.token),
      payload: { publicKey: generateKeyPair().publicKey },
    });
    expect(response.statusCode).toBe(404);
  });
});
