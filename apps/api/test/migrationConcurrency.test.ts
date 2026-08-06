import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { createPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";

// Uses its own dedicated database, isolated from the shared test database
// the rest of the suite uses (which other test files truncate/query
// concurrently) -- this test is destructive (drops tables to genuinely
// exercise the "fresh database" race) and must not interfere with them.
const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const CONCURRENCY_DB_NAME = "scheduleapp_migration_concurrency_test";
const CONCURRENCY_DB_URL = ADMIN_URL.replace(/\/[^/]*$/, `/${CONCURRENCY_DB_NAME}`);

describe("runMigrations concurrency", () => {
  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: ADMIN_URL });
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${CONCURRENCY_DB_NAME}`);
      await admin.query(`CREATE DATABASE ${CONCURRENCY_DB_NAME}`);
    } finally {
      await admin.end();
    }
  }, 30_000);

  afterAll(async () => {
    const admin = new pg.Pool({ connectionString: ADMIN_URL });
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${CONCURRENCY_DB_NAME}`);
    } finally {
      await admin.end();
    }
  });

  it("is safe to call concurrently from multiple pools against a fresh database, as happens when multiple API replicas start up at once", async () => {
    // Regression test for a real bug found while load/scale-testing: two
    // instances starting simultaneously against a shared, fresh database
    // used to race on "CREATE TABLE IF NOT EXISTS schema_migrations" and
    // crash with a duplicate-key error from Postgres's internal catalog.
    const dbA = createPool(CONCURRENCY_DB_URL);
    const dbB = createPool(CONCURRENCY_DB_URL);
    const dbC = createPool(CONCURRENCY_DB_URL);

    try {
      const results = await Promise.all([runMigrations(dbA), runMigrations(dbB), runMigrations(dbC)]);

      // Every migration file should have been applied exactly once in
      // total across all three concurrent callers, not zero times (silently
      // skipped) and not more than once (would mean the lock didn't work).
      const allApplied = results.flat();
      const uniqueApplied = new Set(allApplied);
      expect(uniqueApplied.size).toBe(allApplied.length); // no file applied twice
      expect(uniqueApplied.size).toBeGreaterThanOrEqual(3); // our 3 migration files

      const tableCheck = await dbA.query<{ count: string }>(
        `SELECT count(*)::text FROM information_schema.tables WHERE table_name = 'users'`
      );
      expect(tableCheck.rows[0]?.count).toBe("1");
    } finally {
      await dbA.end();
      await dbB.end();
      await dbC.end();
    }
  }, 30_000);
});
