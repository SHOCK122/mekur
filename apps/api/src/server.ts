import { buildApp } from "./app.js";
import { config } from "./config.js";
import { createPool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";

async function main() {
  const db = createPool(config.databaseUrl);
  const applied = await runMigrations(db);
  if (applied.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`Applied migrations: ${applied.join(", ")}`);
  }

  const app = buildApp({ db, jwtSecret: config.jwtSecret });

  await app.listen({ port: config.port, host: config.host });
  // eslint-disable-next-line no-console
  console.log(`API listening on http://${config.host}:${config.port}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
