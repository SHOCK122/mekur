import type { Database } from "../db/pool.js";
import type { EncryptedEnvelope, GroupEventStatus } from "@schedule-app/shared";

export interface GroupEventParticipantInput {
  userId: string;
  wrappedKey: EncryptedEnvelope;
  /** True when this person was reached via a one-time anonymous code.
   * Recorded so the UI can refuse to offer "add as connection" for them --
   * the code existed precisely so no lasting identity was exchanged. */
  invitedViaCode?: boolean;
}

export interface VoteRankingRow {
  slotId: string;
  rank: number;
}

export interface GroupEventRow {
  id: string;
  organizerId: string;
  organizerPublicKey: string;
  slotIds: string[];
  contentEnvelope: EncryptedEnvelope;
  status: GroupEventStatus;
  resolvedSlotId: string | null;
  createdAt: string;
  updatedAt: string;
  myWrappedKey: EncryptedEnvelope;
  myVotes: VoteRankingRow[];
  myInviteStatus: "pending" | "accepted" | "rejected";
  invitedViaCode: boolean;
}

interface RawRow {
  id: string;
  organizer_id: string;
  organizer_public_key: string;
  slot_ids: string[];
  content_envelope: EncryptedEnvelope;
  status: GroupEventStatus;
  resolved_slot_id: string | null;
  created_at: Date;
  updated_at: Date;
  my_wrapped_key: EncryptedEnvelope;
  my_votes: VoteRankingRow[];
  my_invite_status: "pending" | "accepted" | "rejected";
  invited_via_code: boolean;
}

function toGroupEventRow(row: RawRow): GroupEventRow {
  return {
    id: row.id,
    organizerId: row.organizer_id,
    organizerPublicKey: row.organizer_public_key,
    slotIds: row.slot_ids,
    contentEnvelope: row.content_envelope,
    status: row.status,
    resolvedSlotId: row.resolved_slot_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    myWrappedKey: row.my_wrapped_key,
    myVotes: row.my_votes,
    myInviteStatus: row.my_invite_status,
    invitedViaCode: row.invited_via_code,
  };
}

// $1 is always the requesting userId (used both to find their participant
// row and to find their own votes).
const SELECT_FOR_USER = `
  SELECT ge.id, ge.organizer_id, u.public_key AS organizer_public_key,
         ge.slot_ids, ge.content_envelope, ge.status,
         ge.resolved_slot_id, ge.created_at, ge.updated_at,
         gep.wrapped_key AS my_wrapped_key,
         gep.invite_status AS my_invite_status,
         gep.invited_via_code,
         COALESCE(votes.my_votes, '[]'::json) AS my_votes
  FROM group_events ge
  JOIN group_event_participants gep
    ON gep.group_event_id = ge.id AND gep.user_id = $1
  JOIN users u ON u.id = ge.organizer_id
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object('slotId', gev.slot_id, 'rank', gev.rank)) AS my_votes
    FROM group_event_votes gev
    WHERE gev.group_event_id = ge.id AND gev.voter_id = $1
  ) votes ON true
`;

export function createGroupEventRepository(db: Database) {
  return {
    async create(
      organizerId: string,
      slotIds: string[],
      contentEnvelope: EncryptedEnvelope,
      participants: GroupEventParticipantInput[]
    ): Promise<GroupEventRow> {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const insertResult = await client.query<{ id: string }>(
          `INSERT INTO group_events (organizer_id, slot_ids, content_envelope)
           VALUES ($1, $2, $3) RETURNING id`,
          [organizerId, slotIds, contentEnvelope]
        );
        const groupEventId = insertResult.rows[0]?.id;
        if (!groupEventId) throw new Error("Insert returned no id");

        for (const participant of participants) {
          await client.query(
            `INSERT INTO group_event_participants
               (group_event_id, user_id, wrapped_key, invited_via_code, invite_status)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              groupEventId,
              participant.userId,
              participant.wrappedKey,
              participant.invitedViaCode ?? false,
              // The organizer never has to accept their own invitation.
              participant.userId === organizerId ? "accepted" : "pending",
            ]
          );
        }
        await client.query("COMMIT");

        const result = await db.query<RawRow>(`${SELECT_FOR_USER} AND ge.id = $2`, [
          organizerId,
          groupEventId,
        ]);
        const created = result.rows[0];
        if (!created) throw new Error("Failed to load newly created group event");
        return toGroupEventRow(created);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    // Same reasoning as eventRepository's listByOwner LIMIT -- caught by
    // the same load-testing pass.
    async listForUser(userId: string): Promise<GroupEventRow[]> {
      const result = await db.query<RawRow>(
        `${SELECT_FOR_USER} ORDER BY ge.created_at DESC LIMIT 200`,
        [userId]
      );
      return result.rows.map(toGroupEventRow);
    },

    async findByIdForUser(groupEventId: string, userId: string): Promise<GroupEventRow | null> {
      const result = await db.query<RawRow>(`${SELECT_FOR_USER} AND ge.id = $2`, [
        userId,
        groupEventId,
      ]);
      const row = result.rows[0];
      return row ? toGroupEventRow(row) : null;
    },

    async isParticipant(groupEventId: string, userId: string): Promise<boolean> {
      const result = await db.query(
        `SELECT 1 FROM group_event_participants WHERE group_event_id = $1 AND user_id = $2`,
        [groupEventId, userId]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async isOrganizer(groupEventId: string, userId: string): Promise<boolean> {
      const result = await db.query(
        `SELECT 1 FROM group_events WHERE id = $1 AND organizer_id = $2`,
        [groupEventId, userId]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async getSlotIds(groupEventId: string): Promise<string[] | null> {
      const result = await db.query<{ slot_ids: string[] }>(
        `SELECT slot_ids FROM group_events WHERE id = $1`,
        [groupEventId]
      );
      return result.rows[0]?.slot_ids ?? null;
    },

    async listParticipantUserIds(groupEventId: string): Promise<string[]> {
      const result = await db.query<{ user_id: string }>(
        `SELECT user_id FROM group_event_participants WHERE group_event_id = $1`,
        [groupEventId]
      );
      return result.rows.map((r) => r.user_id);
    },

    async respondToInvite(
      groupEventId: string,
      userId: string,
      status: "accepted" | "rejected"
    ): Promise<boolean> {
      const result = await db.query(
        `UPDATE group_event_participants SET invite_status = $3
         WHERE group_event_id = $1 AND user_id = $2`,
        [groupEventId, userId, status]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async resolve(groupEventId: string, resolvedSlotId: string): Promise<void> {
      await db.query(
        `UPDATE group_events SET status = 'resolved', resolved_slot_id = $2, updated_at = now()
         WHERE id = $1`,
        [groupEventId, resolvedSlotId]
      );
    },
  };
}

export type GroupEventRepository = ReturnType<typeof createGroupEventRepository>;
