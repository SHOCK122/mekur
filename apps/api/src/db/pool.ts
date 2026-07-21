import pg from "pg";

export type Database = pg.Pool;

export function createPool(connectionString: string): Database {
  return new pg.Pool({ connectionString });
}
