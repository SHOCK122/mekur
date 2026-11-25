import { randomBytes } from "node:crypto";
import type { Database } from "../db/pool.js";

export interface FriendCodeRecord {
  code: string;
  createdAt: string;
}

/** Codes are shown to humans and retyped, so the alphabet deliberately
 * excludes characters that are easy to confuse (0/O, 1/I/l). 8 characters
 * from a 31-symbol alphabet is ~39 bits -- far beyond guessing range for a
 * value that is single-use, rate-limited, and replaced the moment it's
 * redeemed. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Codes are uppercase from ALPHABET and usernames are lowercase, so a tag
 * can be told apart without asking which kind it is. */
export const FRIEND_CODE_PATTERN = new RegExp(`^[${ALPHABET}]{8}$`);

export function generateFriendCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length];
  return code;
}

function toRecord(row: { code: string; created_at: Date }): FriendCodeRecord {
  return { code: row.code, createdAt: row.created_at.toISOString() };
}

/**
 * Each user has exactly one row: their current code. A spent code is
 * replaced in place, so nothing records who redeemed whose code -- that
 * would be a plaintext edge in the social graph the capability model
 * exists to avoid storing.
 */
export function createFriendCodeRepository(db: Database) {
  return {
    /** Returns the user's code, creating one on first use. Safe to call
     * repeatedly. */
    async getOrCreate(userId: string): Promise<FriendCodeRecord> {
      // DO UPDATE with a no-op rather than DO NOTHING so RETURNING yields
      // the existing row too, keeping this a single round trip.
      const result = await db.query<{ code: string; created_at: Date }>(
        `INSERT INTO friend_codes (user_id, code) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
         RETURNING code, created_at`,
        [userId, generateFriendCode()]
      );
      const row = result.rows[0];
      if (!row) throw new Error("Upsert returned no row");
      return toRecord(row);
    },

    /**
     * Resolves a code to its owner and replaces it in one statement. Returns
     * null if the code is unknown, already spent, or the redeemer's own --
     * callers must not distinguish those cases, or the endpoint becomes a
     * code oracle.
     *
     * The conditional UPDATE is what makes this atomic: two people racing
     * to redeem the same code, only one matches.
     */
    async redeem(code: string, redeemerId: string): Promise<{ ownerId: string } | null> {
      const result = await db.query<{ user_id: string }>(
        `UPDATE friend_codes SET code = $3, created_at = now()
         WHERE code = $1 AND user_id <> $2
         RETURNING user_id`,
        [code, redeemerId, generateFriendCode()]
      );
      const row = result.rows[0];
      return row ? { ownerId: row.user_id } : null;
    },

    /** Replaces the current code, for when a user thinks it has leaked. */
    async rotate(userId: string): Promise<FriendCodeRecord> {
      const result = await db.query<{ code: string; created_at: Date }>(
        `INSERT INTO friend_codes (user_id, code) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET code = EXCLUDED.code, created_at = now()
         RETURNING code, created_at`,
        [userId, generateFriendCode()]
      );
      const row = result.rows[0];
      if (!row) throw new Error("Upsert returned no row");
      return toRecord(row);
    },
  };
}

export type FriendCodeRepository = ReturnType<typeof createFriendCodeRepository>;
