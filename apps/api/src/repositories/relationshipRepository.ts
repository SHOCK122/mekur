import type { Database } from "../db/pool.js";

export type RelationshipState = "connected" | "blocked";

export interface RelationshipRecord {
  otherUserId: string;
  otherUsername: string;
  otherDisplayName: string;
  state: RelationshipState;
  createdAt: string;
}

export function createRelationshipRepository(db: Database) {
  return {
    /** Upserts, so connecting to someone you'd blocked (or vice versa)
     * replaces the previous state rather than erroring. */
    async set(userId: string, otherUserId: string, state: RelationshipState): Promise<void> {
      await db.query(
        `INSERT INTO user_relationships (user_id, other_user_id, state)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, other_user_id) DO UPDATE SET state = $3`,
        [userId, otherUserId, state]
      );
    },

    async remove(userId: string, otherUserId: string): Promise<boolean> {
      const result = await db.query(
        `DELETE FROM user_relationships WHERE user_id = $1 AND other_user_id = $2`,
        [userId, otherUserId]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async list(userId: string, state?: RelationshipState): Promise<RelationshipRecord[]> {
      const result = await db.query<{
        other_user_id: string;
        username: string;
        display_name: string;
        state: RelationshipState;
        created_at: Date;
      }>(
        `SELECT r.other_user_id, u.username, u.display_name, r.state, r.created_at
         FROM user_relationships r
         JOIN users u ON u.id = r.other_user_id
         WHERE r.user_id = $1 ${state ? "AND r.state = $2" : ""}
         ORDER BY r.created_at DESC`,
        state ? [userId, state] : [userId]
      );
      return result.rows.map((row) => ({
        otherUserId: row.other_user_id,
        otherUsername: row.username,
        otherDisplayName: row.display_name,
        state: row.state,
        createdAt: row.created_at.toISOString(),
      }));
    },

    /**
     * True if `blockerId` has blocked `blockedId`. Used to refuse invites:
     * a block is worthless if the blocked person can still put things on
     * your calendar.
     */
    async hasBlocked(blockerId: string, blockedId: string): Promise<boolean> {
      const result = await db.query(
        `SELECT 1 FROM user_relationships
         WHERE user_id = $1 AND other_user_id = $2 AND state = 'blocked'`,
        [blockerId, blockedId]
      );
      return (result.rowCount ?? 0) > 0;
    },

    /** Bulk form of hasBlocked, so inviting N people doesn't cost N
     * queries. Returns the subset of `candidateIds` who have blocked
     * `actorId`. */
    async whoHasBlocked(actorId: string, candidateIds: string[]): Promise<Set<string>> {
      if (candidateIds.length === 0) return new Set();
      const result = await db.query<{ user_id: string }>(
        `SELECT user_id FROM user_relationships
         WHERE other_user_id = $1 AND state = 'blocked' AND user_id = ANY($2::uuid[])`,
        [actorId, candidateIds]
      );
      return new Set(result.rows.map((r) => r.user_id));
    },
  };
}

export type RelationshipRepository = ReturnType<typeof createRelationshipRepository>;
