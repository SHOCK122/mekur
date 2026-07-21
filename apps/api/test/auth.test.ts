import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Database } from "../src/db/pool.js";
import { deriveAuthAndEncryptionKeys, generateKeyPair, toBase64 } from "@schedule-app/crypto";
import { setupTestApp, truncateAll } from "./testHelpers.js";

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

  async function registerPayload(username: string, password: string) {
    const keys = await deriveAuthAndEncryptionKeys(password);
    const { publicKey } = generateKeyPair();
    return {
      username,
      displayName: "Ada Lovelace",
      publicKey,
      authKey: keys.authKey,
      authSalt: keys.salt,
    };
  }

  it("registers a new user and returns a token", async () => {
    const payload = await registerPayload("ada", "correct horse battery staple");
    const response = await app.inject({ method: "POST", url: "/users", payload });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.user.username).toBe("ada");
    expect(body.user).not.toHaveProperty("authHash");
    expect(body.user).not.toHaveProperty("authSalt");
    expect(typeof body.token).toBe("string");
  });

  it("rejects a duplicate username", async () => {
    const payload = await registerPayload("ada", "correct horse battery staple");
    await app.inject({ method: "POST", url: "/users", payload });
    const response = await app.inject({ method: "POST", url: "/users", payload });
    expect(response.statusCode).toBe(409);
  });

  it("rejects an invalid username", async () => {
    const payload = await registerPayload("Not Valid!", "some password");
    const response = await app.inject({ method: "POST", url: "/users", payload });
    expect(response.statusCode).toBe(400);
  });

  it("logs in with the correct password and rejects the wrong one", async () => {
    const payload = await registerPayload("ada", "correct horse battery staple");
    await app.inject({ method: "POST", url: "/users", payload });

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
  });

  it("returns the same error for unknown username as for wrong password (no enumeration)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { username: "does-not-exist", authKey: toBase64(new Uint8Array(32)) },
    });
    expect(response.statusCode).toBe(401);
  });
});
