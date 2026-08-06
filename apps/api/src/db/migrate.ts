import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Database } from "./pool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

// Arbitrary fixed key for a Postgres advisory lock scoped to migrations.
// Any two processes calling pg_advisory_lock with the same key serialize
// against each other automatically -- the second caller blocks until the
// first releases it. This is what makes runMigrations() safe to call from
// multiple API replicas starting up at the same time against a shared,
// possibly-fresh database (a completely realistic horizontal-scaling
// scenario), instead of racing on "CREATE TABLE IF NOT EXISTS" and
// crashing with a duplicate-key error from Postgres's internal catalog.
const MIGRATION_LOCK_KEY = 7_272_774;

export async function runMigrations(db: Database): Promise<string[]> {
  const client = await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const applied = new Set(
      (await client.query<{ id: string }>("SELECT id FROM schema_migrations")).rows.map((r) => r.id)
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const newlyApplied: string[] = [];

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
        await client.query("COMMIT");
        newlyApplied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }

    return newlyApplied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    client.release();
  }
}
