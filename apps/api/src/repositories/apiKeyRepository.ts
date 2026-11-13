import type { Database } from "../db/pool.js";

/**
 * The one API-key query the TS server still needs: the auth plugin's
 * lookup. Minting, listing and revoking keys moved to the Rust server
 * (crates/api/src/api_keys.rs, step 3c of docs/RUST_MIGRATION.md), which
 * stores keys in the same format.
 */
export function createApiKeyRepository(db: Database) {
  return {
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
  };
}

export type ApiKeyRepository = ReturnType<typeof createApiKeyRepository>;
