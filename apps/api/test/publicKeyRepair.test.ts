import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Database } from "../src/db/pool.js";
import {
  deriveAuthAndEncryptionKeys,
  generateKeyPair,
  generateSymmetricKey,
  deriveSharedWrapKey,
  wrapKey,
  unwrapKey,
} from "@schedule-app/crypto";
import { setupTestApp, truncateAll } from "./testHelpers.js";

describe("public key repair (fixes the 'invalid tag' bug)", () => {
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

  async function register(username: string, publicKey: string) {
    const keys = await deriveAuthAndEncryptionKeys("some strong password");
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
    return { token: response.json().token as string, userId: response.json().user.id as string };
  }

  it("reproduces the original failure: a stale stored key makes wrapped keys undecryptable", async () => {
    const keys = await deriveAuthAndEncryptionKeys("some strong password");
    // What a pre-fix account looked like: server holds a random public key,
    // the client derives a different one.
    const stalePublicKey = generateKeyPair().publicKey;

    const eventKey = generateSymmetricKey();
    const wrapped = wrapKey(
      eventKey,
      deriveSharedWrapKey(keys.identityKeyPair.secretKey, keys.identityKeyPair.publicKey)
    );

    expect(() =>
      unwrapKey(wrapped, deriveSharedWrapKey(keys.identityKeyPair.secretKey, stalePublicKey))
    ).toThrow(/invalid tag/i);
  }, 20_000);

  it("lets a user replace their own stale public key", async () => {
    const stalePublicKey = generateKeyPair().publicKey;
    const { token } = await register("staleuser", stalePublicKey);
    const correctPublicKey = generateKeyPair().publicKey;

    const response = await app.inject({
      method: "PUT",
      url: "/users/me/public-key",
      headers: { authorization: `Bearer ${token}` },
      payload: { publicKey: correctPublicKey },
    });
    expect(response.statusCode).toBe(204);

    // The directory now hands out the repaired key, so future wraps target
    // a keypair the person actually holds.
    const lookup = await app.inject({
      method: "GET",
      url: "/users/staleuser",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(lookup.json().user.publicKey).toBe(correctPublicKey);
  }, 20_000);

  it("after repair, a round-trip wrap/unwrap against the directory key succeeds", async () => {
    const keys = await deriveAuthAndEncryptionKeys("some strong password");
    const { token } = await register("healeduser", generateKeyPair().publicKey);

    await app.inject({
      method: "PUT",
      url: "/users/me/public-key",
      headers: { authorization: `Bearer ${token}` },
      payload: { publicKey: keys.identityKeyPair.publicKey },
    });

    const lookup = await app.inject({
      method: "GET",
      url: "/users/healeduser",
      headers: { authorization: `Bearer ${token}` },
    });
    const directoryKey = lookup.json().user.publicKey as string;

    // Exactly the flow that used to throw "invalid tag": wrap against the
    // key the directory advertises, unwrap with the derived private key.
    const eventKey = generateSymmetricKey();
    const wrapped = wrapKey(
      eventKey,
      deriveSharedWrapKey(keys.identityKeyPair.secretKey, directoryKey)
    );
    const recovered = unwrapKey(
      wrapped,
      deriveSharedWrapKey(keys.identityKeyPair.secretKey, keys.identityKeyPair.publicKey)
    );
    expect(recovered).toBe(eventKey);
  }, 20_000);

  it("requires authentication", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/users/me/public-key",
      payload: { publicKey: generateKeyPair().publicKey },
    });
    expect(response.statusCode).toBe(401);
  });

  it("cannot rewrite another user's key, which would let you hijack their events", async () => {
    const victimKey = generateKeyPair().publicKey;
    await register("victim", victimKey);
    const attacker = await register("attacker", generateKeyPair().publicKey);
    const attackerControlledKey = generateKeyPair().publicKey;

    // The endpoint only ever targets the authenticated user, so this
    // rewrites the attacker's own key -- never the victim's.
    await app.inject({
      method: "PUT",
      url: "/users/me/public-key",
      headers: { authorization: `Bearer ${attacker.token}` },
      payload: { publicKey: attackerControlledKey },
    });

    const lookup = await app.inject({
      method: "GET",
      url: "/users/victim",
      headers: { authorization: `Bearer ${attacker.token}` },
    });
    expect(lookup.json().user.publicKey).toBe(victimKey);
  }, 20_000);
});
