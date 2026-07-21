import type { Database } from "../db/pool.js";
import type { EncryptedEnvelope, EventRecord } from "@schedule-app/shared";

interface EventRow {
  id: string;
  owner_id: string;
  envelope: EncryptedEnvelope;
  created_at: Date;
  updated_at: Date;
}

function toEventRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    envelope: row.envelope,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function createEventRepository(db: Database) {
  return {
    async create(ownerId: string, envelope: EncryptedEnvelope): Promise<EventRecord> {
      const result = await db.query<EventRow>(
        `INSERT INTO events (owner_id, envelope)
         VALUES ($1, $2)
         RETURNING id, owner_id, envelope, created_at, updated_at`,
        [ownerId, envelope]
      );
      const row = result.rows[0];
      if (!row) throw new Error("Insert returned no row");
      return toEventRecord(row);
    },

    async listByOwner(ownerId: string): Promise<EventRecord[]> {
      const result = await db.query<EventRow>(
        `SELECT id, owner_id, envelope, created_at, updated_at
         FROM events WHERE owner_id = $1 ORDER BY created_at DESC`,
        [ownerId]
      );
      return result.rows.map(toEventRecord);
    },

    async findByIdForOwner(id: string, ownerId: string): Promise<EventRecord | null> {
      const result = await db.query<EventRow>(
        `SELECT id, owner_id, envelope, created_at, updated_at
         FROM events WHERE id = $1 AND owner_id = $2`,
        [id, ownerId]
      );
      const row = result.rows[0];
      return row ? toEventRecord(row) : null;
    },

    async updateForOwner(
      id: string,
      ownerId: string,
      envelope: EncryptedEnvelope
    ): Promise<EventRecord | null> {
      const result = await db.query<EventRow>(
        `UPDATE events SET envelope = $1, updated_at = now()
         WHERE id = $2 AND owner_id = $3
         RETURNING id, owner_id, envelope, created_at, updated_at`,
        [envelope, id, ownerId]
      );
      const row = result.rows[0];
      return row ? toEventRecord(row) : null;
    },

    async deleteForOwner(id: string, ownerId: string): Promise<boolean> {
      const result = await db.query(`DELETE FROM events WHERE id = $1 AND owner_id = $2`, [
        id,
        ownerId,
      ]);
      return (result.rowCount ?? 0) > 0;
    },
  };
}

export type EventRepository = ReturnType<typeof createEventRepository>;
