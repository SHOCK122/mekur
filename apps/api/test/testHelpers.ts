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
