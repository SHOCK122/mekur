import { createPool, type Database } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";
import { buildApp } from "../src/app.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/scheduleapp_test";

export async function setupTestApp() {
  const db = createPool(TEST_DATABASE_URL);
  await runMigrations(db);
  const app = buildApp({ db, jwtSecret: "test-secret" });
  return { app, db };
}

export async function truncateAll(db: Database) {
  await db.query("TRUNCATE TABLE events, users RESTART IDENTITY CASCADE");
}
