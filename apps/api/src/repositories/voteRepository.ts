import type { Database } from "../db/pool.js";
import type { Vote } from "../services/slotSelection.js";

export function createVoteRepository(db: Database) {
  return {
    /** Replaces this voter's entire set of rankings for the event with
     * exactly what's submitted -- if they drop a slot from their ranking,
     * the stale vote for it is removed too, rather than lingering. */
    async setVotesForVoter(
      groupEventId: string,
      voterId: string,
      rankings: { slotId: string; rank: number }[]
    ): Promise<void> {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `DELETE FROM group_event_votes WHERE group_event_id = $1 AND voter_id = $2`,
          [groupEventId, voterId]
        );
        for (const { slotId, rank } of rankings) {
          await client.query(
            `INSERT INTO group_event_votes (group_event_id, voter_id, slot_id, rank)
             VALUES ($1, $2, $3, $4)`,
            [groupEventId, voterId, slotId, rank]
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async listVotes(groupEventId: string): Promise<Vote[]> {
      const result = await db.query<{ voter_id: string; slot_id: string; rank: number }>(
        `SELECT voter_id, slot_id, rank FROM group_event_votes WHERE group_event_id = $1`,
        [groupEventId]
      );
      return result.rows.map((row) => ({ voterId: row.voter_id, slotId: row.slot_id, rank: row.rank }));
    },
  };
}

export type VoteRepository = ReturnType<typeof createVoteRepository>;
