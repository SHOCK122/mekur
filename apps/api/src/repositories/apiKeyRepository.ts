import type { Database } from "../db/pool.js";

export interface ApiKeyRecord {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  created_at: Date;
  last_used_at: Date | null;
}

function toApiKeyRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
  };
}

export function createApiKeyRepository(db: Database) {
  return {
    async create(userId: string, name: string, keyPrefix: string, keyHash: string): Promise<ApiKeyRecord> {
      const result = await db.query<ApiKeyRow>(
        `INSERT INTO api_keys (user_id, name, key_prefix, key_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, user_id, name, key_prefix, created_at, last_used_at`,
        [userId, name, keyPrefix, keyHash]
      );
      const row = result.rows[0];
      if (!row) throw new Error("Insert returned no row");
      return toApiKeyRecord(row);
    },

    /** Looks up which user a raw API key's hash belongs to, and bumps
     * last_used_at. Returns null if the key doesn't exist (revoked or
     * never existed) -- callers should treat that as "unauthenticated". */
    async findUserIdByHash(keyHash: string): Promise<string | null> {
      const result = await db.query<{ user_id: string }>(
        `UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 RETURNING user_id`,
        [keyHash]
      );
      return result.rows[0]?.user_id ?? null;
    },

    async listForUser(userId: string): Promise<ApiKeyRecord[]> {
      const result = await db.query<ApiKeyRow>(
        `SELECT id, user_id, name, key_prefix, created_at, last_used_at
         FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId]
      );
      return result.rows.map(toApiKeyRecord);
    },

    async revokeForUser(id: string, userId: string): Promise<boolean> {
      const result = await db.query(`DELETE FROM api_keys WHERE id = $1 AND user_id = $2`, [
        id,
        userId,
      ]);
      return (result.rowCount ?? 0) > 0;
    },
  };
}

export type ApiKeyRepository = ReturnType<typeof createApiKeyRepository>;
