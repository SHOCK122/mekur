import type { FastifyInstance } from "fastify";
import { generateKeyPair, randomBytes, sha256Base64, toBase64 } from "@schedule-app/crypto";
import { createPool, type Database } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";
import { buildApp } from "../src/app.js";
import { createUserRepository } from "../src/repositories/userRepository.js";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/scheduleapp_test";

export const TEST_VAPID = {
  vapidPublicKey:
    "BAHQnCgvhlb0-G5wOocrFTe7zK7ewUJ7AR7ZCYGA2rfaGlueYTazRM-fTiZUrkJUlM2SmKbdUALS1FzUnSiFbUI",
  vapidPrivateKey: "qUFTF3lXxouxuo_n0kPvwpMn2Ehl3W51M8Aw3vap5QQ",
  vapidSubject: "mailto:test@example.com",
};

/** Each test app's database, so registerUser can create accounts directly. */
const databases = new WeakMap<FastifyInstance, Database>();

/** Builds an app on the test database. Remembers the pairing for
 * registerUser; options override the defaults. */
export function buildTestApp(db: Database, options: { rateLimitMax?: number } = {}) {
  const app = buildApp({
    db,
    jwtSecret: "test-secret",
    ...TEST_VAPID,
    // Raised well above production defaults: the suite fires hundreds of
    // requests in seconds, which would otherwise trip the limiter and
    // produce confusing flakes unrelated to what's being tested.
    rateLimitMax: 100_000,
    ...options,
  });
  databases.set(app, db);
  return app;
}

export async function setupTestApp() {
  const db = createPool(TEST_DATABASE_URL);
  await runMigrations(db);
  return { app: buildTestApp(db), db };
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
 * Creates an account and a session token directly. Registration and login
 * are served by the Rust server now (crates/api, step 3b of
 * docs/RUST_MIGRATION.md), so this writes the row POST /users wrote and
 * signs the token it issued. The API only ever sees an auth key, never a
 * password, so tests skip the (deliberately slow) scrypt derivation and
 * use random bytes.
 */
export async function registerUser(app: FastifyInstance, username: string) {
  const db = databases.get(app);
  if (!db) throw new Error("registerUser needs an app from buildTestApp/setupTestApp");
  const keyPair = generateKeyPair();
  const authKey = toBase64(randomBytes(32));
  const user = await createUserRepository(db).create({
    username,
    displayName: username,
    publicKey: keyPair.publicKey,
    authSalt: toBase64(randomBytes(16)),
    authHash: sha256Base64(authKey),
  });
  await app.ready();
  const token = app.jwt.sign({ userId: user.id }, { expiresIn: "30d" });
  return { userId: user.id, token, keyPair, authKey };
}

export function auth(token: string, capability?: string) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (capability) headers["x-event-capability"] = capability;
  return headers;
}
