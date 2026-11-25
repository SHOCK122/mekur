import type { FastifyInstance } from "fastify";
import { generateKeyPair, randomBytes, toBase64 } from "@schedule-app/crypto";
import { createPool, type Database } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";
import { buildApp } from "../src/app.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/scheduleapp_test";

export async function setupTestApp() {
  const db = createPool(TEST_DATABASE_URL);
  await runMigrations(db);
  const app = buildApp({
    db,
    jwtSecret: "test-secret",
    vapidPublicKey:
      "BAHQnCgvhlb0-G5wOocrFTe7zK7ewUJ7AR7ZCYGA2rfaGlueYTazRM-fTiZUrkJUlM2SmKbdUALS1FzUnSiFbUI",
    vapidPrivateKey: "qUFTF3lXxouxuo_n0kPvwpMn2Ehl3W51M8Aw3vap5QQ",
    vapidSubject: "mailto:test@example.com",
    // Raised well above production defaults: the suite fires hundreds of
    // requests in seconds, which would otherwise trip the limiter and
    // produce confusing flakes unrelated to what's being tested.
    rateLimitMax: 100_000,
    authRateLimitMax: 100_000,
  });
  return { app, db };
}

export async function truncateAll(db: Database) {
  await db.query("TRUNCATE TABLE events, keyrings, inbox_messages, users RESTART IDENTITY CASCADE");
}

/** A structurally valid envelope. The server never decrypts, so its
 * contents don't matter for API tests. */
export const ENVELOPE = {
  v: 1,
  algo: "xchacha20poly1305",
  keyId: "k",
  nonce: "bm9uY2U=",
  ciphertext: "Y2lwaGVydGV4dA==",
};

/** An inbox envelope: sealed, so it carries an ephemeral public key. */
export const SEALED_ENVELOPE = { ...ENVELOPE, keyId: "sealed", epk: "ZXBoZW1lcmFs" };

/**
 * Registers an account directly. The API only ever sees an auth key, never
 * a password, so tests skip the (deliberately slow) scrypt derivation and
 * use random bytes -- the server can't tell the difference, and the suite
 * stops timing out under parallel load.
 */
export async function registerUser(app: FastifyInstance, username: string) {
  const keyPair = generateKeyPair();
  const authKey = toBase64(randomBytes(32));
  const response = await app.inject({
    method: "POST",
    url: "/users",
    payload: {
      username,
      displayName: username,
      publicKey: keyPair.publicKey,
      authKey,
      authSalt: toBase64(randomBytes(16)),
    },
  });
  const body = response.json();
  return { userId: body.user.id as string, token: body.token as string, keyPair, authKey };
}

export function auth(token: string, capability?: string) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (capability) headers["x-event-capability"] = capability;
  return headers;
}
