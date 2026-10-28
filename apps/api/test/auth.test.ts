import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Database } from "../src/db/pool.js";
import { deriveAuthAndEncryptionKeys, generateKeyPair, toBase64, randomBytes } from "@schedule-app/crypto";
import { setupTestApp, truncateAll, registerUser, auth } from "./testHelpers.js";

function registerPayload(username: string) {
  return {
    username,
    displayName: "Ada Lovelace",
    publicKey: generateKeyPair().publicKey,
    authKey: toBase64(randomBytes(32)),
    authSalt: toBase64(randomBytes(16)),
  };
}

describe("auth routes", () => {
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

  it("registers a new user and returns a token", async () => {
    const payload = registerPayload("ada");
    const response = await app.inject({ method: "POST", url: "/users", payload });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.user.username).toBe("ada");
    expect(body.user).not.toHaveProperty("authHash");
    expect(body.user).not.toHaveProperty("authSalt");
    expect(typeof body.token).toBe("string");
  });

  it("rejects a duplicate username", async () => {
    const payload = registerPayload("ada");
    await app.inject({ method: "POST", url: "/users", payload });
    const response = await app.inject({ method: "POST", url: "/users", payload });
    expect(response.statusCode).toBe(409);
  });

  it("rejects an invalid username", async () => {
    const payload = registerPayload("Not Valid!");
    const response = await app.inject({ method: "POST", url: "/users", payload });
    expect(response.statusCode).toBe(400);
  });

  it("logs in with the correct password and rejects the wrong one", async () => {
    // The one test that runs real key derivation end to end.
    const keys = await deriveAuthAndEncryptionKeys("correct horse battery staple");
    await app.inject({
      method: "POST",
      url: "/users",
      payload: { ...registerPayload("ada"), authKey: keys.authKey, authSalt: keys.salt },
    });

    // A real client fetches the salt first, then re-derives keys from it.
    const saltResp = await app.inject({ method: "GET", url: "/users/ada/salt" });
    const { authSalt } = saltResp.json();
    const reDerived = await deriveAuthAndEncryptionKeys(
      "correct horse battery staple",
      Buffer.from(authSalt, "base64")
    );

    const loginOk = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { username: "ada", authKey: reDerived.authKey },
    });
    expect(loginOk.statusCode).toBe(200);
    expect(typeof loginOk.json().token).toBe("string");

    const wrongKeys = await deriveAuthAndEncryptionKeys(
      "wrong password",
      Buffer.from(authSalt, "base64")
    );
    const loginBad = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { username: "ada", authKey: wrongKeys.authKey },
    });
    expect(loginBad.statusCode).toBe(401);
  }, 30_000);

  it("returns the same error for unknown username as for wrong password (no enumeration)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { username: "does-not-exist", authKey: toBase64(new Uint8Array(32)) },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("removed directory lookup", () => {
  let app: FastifyInstance;
  let db: Database;

  beforeAll(async () => {
    ({ app, db } = await setupTestApp());
  });

  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("no longer exposes GET /users/:username, an enumeration surface", async () => {
    await truncateAll(db);
    const alice = await registerUser(app, "alice");
    await registerUser(app, "bob");
    const response = await app.inject({ method: "GET", url: "/users/bob", headers: auth(alice.token) });
    expect(response.statusCode).toBe(404);
  });
});
