import type { Database } from "../db/pool.js";

export interface KeyringRecord {
  envelope: unknown;
  version: number;
}

export class KeyringVersionConflictError extends Error {
  constructor() {
    super("Keyring was modified by another device");
    this.name = "KeyringVersionConflictError";
  }
}

/**
 * The keyring holds, encrypted, the list of events an account can reach
 * and the capability tokens for each. Without it "list my events" is
 * unanswerable, because the server deliberately stores no user->event
 * association.
 */
export function createKeyringRepository(db: Database) {
  return {
    async get(userId: string): Promise<KeyringRecord | null> {
      const result = await db.query<{ envelope: unknown; version: number }>(
        `SELECT envelope, version FROM keyrings WHERE user_id = $1`,
        [userId]
      );
      const row = result.rows[0];
      return row ? { envelope: row.envelope, version: row.version } : null;
    },

    /**
     * Optimistic concurrency: the caller must present the version it read.
     * Two devices writing concurrently must not silently clobber each
     * other -- a lost keyring write means permanently losing access to
     * whatever events that write was adding.
     *
     * `expectedVersion` of 0 means "I believe no keyring exists yet".
     */
    async put(userId: string, envelope: unknown, expectedVersion: number): Promise<KeyringRecord> {
      if (expectedVersion === 0) {
        const inserted = await db.query<{ version: number }>(
          `INSERT INTO keyrings (user_id, envelope) VALUES ($1, $2)
           ON CONFLICT (user_id) DO NOTHING
           RETURNING version`,
          [userId, envelope]
        );
        const row = inserted.rows[0];
        if (!row) throw new KeyringVersionConflictError();
        return { envelope, version: row.version };
      }

      const updated = await db.query<{ version: number }>(
        `UPDATE keyrings SET envelope = $2, version = version + 1, updated_at = now()
         WHERE user_id = $1 AND version = $3
         RETURNING version`,
        [userId, envelope, expectedVersion]
      );
      const row = updated.rows[0];
      if (!row) throw new KeyringVersionConflictError();
      return { envelope, version: row.version };
    },
  };
}

export type KeyringRepository = ReturnType<typeof createKeyringRepository>;
