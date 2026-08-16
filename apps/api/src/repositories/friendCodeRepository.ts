import { randomBytes } from "node:crypto";
import type { Database } from "../db/pool.js";

export interface FriendCodeRecord {
  code: string;
  createdAt: string;
}

/** Codes are shown to humans and retyped, so the alphabet deliberately
 * excludes characters that are easy to confuse (0/O, 1/I/l). 8 characters
 * from a 32-symbol alphabet is ~40 bits -- far beyond guessing range for a
 * value that is single-use and rotates the moment it's redeemed. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function generateFriendCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length];
  return code;
}

export function createFriendCodeRepository(db: Database) {
  return {
    /** Returns the user's active code, creating one if they don't have a
     * live one yet. Safe to call repeatedly. */
    async getOrCreateActive(userId: string): Promise<FriendCodeRecord> {
      const existing = await db.query<{ code: string; created_at: Date }>(
        `SELECT code, created_at FROM friend_codes
         WHERE user_id = $1 AND consumed_at IS NULL`,
        [userId]
      );
      const row = existing.rows[0];
      if (row) return { code: row.code, createdAt: row.created_at.toISOString() };

      const inserted = await db.query<{ code: string; created_at: Date }>(
        `INSERT INTO friend_codes (user_id, code) VALUES ($1, $2)
         RETURNING code, created_at`,
        [userId, generateFriendCode()]
      );
      const created = inserted.rows[0];
      if (!created) throw new Error("Insert returned no row");
      return { code: created.code, createdAt: created.created_at.toISOString() };
    },

    /**
     * Resolves a code to its owner and consumes it in the same transaction,
     * then issues the owner a fresh one. Returns null if the code is
     * unknown or already spent -- callers must not distinguish those two
     * cases to the caller, or the endpoint becomes a code oracle.
     */
    async redeem(code: string, redeemerId: string): Promise<{ ownerId: string } | null> {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        // The conditional UPDATE is what makes this atomic: two people
        // racing to redeem the same code, only one wins.
        const consumed = await client.query<{ user_id: string }>(
          `UPDATE friend_codes SET consumed_at = now(), consumed_by = $2
           WHERE code = $1 AND consumed_at IS NULL
           RETURNING user_id`,
          [code, redeemerId]
        );
        const owner = consumed.rows[0];
        if (!owner) {
          await client.query("ROLLBACK");
          return null;
        }
        // Someone can't redeem their own code to no purpose.
        if (owner.user_id === redeemerId) {
          await client.query("ROLLBACK");
          return null;
        }
        await client.query(`INSERT INTO friend_codes (user_id, code) VALUES ($1, $2)`, [
          owner.user_id,
          generateFriendCode(),
        ]);
        await client.query("COMMIT");
        return { ownerId: owner.user_id };
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    /** Discards the current code and issues a new one, for when a user
     * thinks a code has leaked. */
    async rotate(userId: string): Promise<FriendCodeRecord> {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE friend_codes SET consumed_at = now()
           WHERE user_id = $1 AND consumed_at IS NULL`,
          [userId]
        );
        const inserted = await client.query<{ code: string; created_at: Date }>(
          `INSERT INTO friend_codes (user_id, code) VALUES ($1, $2)
           RETURNING code, created_at`,
          [userId, generateFriendCode()]
        );
        await client.query("COMMIT");
        const row = inserted.rows[0];
        if (!row) throw new Error("Insert returned no row");
        return { code: row.code, createdAt: row.created_at.toISOString() };
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

export type FriendCodeRepository = ReturnType<typeof createFriendCodeRepository>;
