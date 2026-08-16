import type { Database } from "../db/pool.js";

export interface InboxMessage {
  id: string;
  envelope: unknown;
  createdAt: string;
}

/**
 * Delivery channel for capabilities. Note the absence of a sender column:
 * recording who wrote to whom would rebuild in this table exactly the
 * social graph the capability model exists to avoid. Sender identity, when
 * disclosed at all, travels inside the encrypted envelope where only the
 * recipient can read it.
 */
export function createInboxRepository(db: Database) {
  return {
    async deliver(recipientId: string, envelope: unknown): Promise<void> {
      await db.query(`INSERT INTO inbox_messages (recipient_id, envelope) VALUES ($1, $2)`, [
        recipientId,
        envelope,
      ]);
    },

    async list(recipientId: string): Promise<InboxMessage[]> {
      const result = await db.query<{ id: string; envelope: unknown; created_at: Date }>(
        `SELECT id, envelope, created_at FROM inbox_messages
         WHERE recipient_id = $1 ORDER BY created_at DESC LIMIT 200`,
        [recipientId]
      );
      return result.rows.map((row) => ({
        id: row.id,
        envelope: row.envelope,
        createdAt: row.created_at.toISOString(),
      }));
    },

    async remove(recipientId: string, messageId: string): Promise<boolean> {
      const result = await db.query(
        `DELETE FROM inbox_messages WHERE id = $1 AND recipient_id = $2`,
        [messageId, recipientId]
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}

export type InboxRepository = ReturnType<typeof createInboxRepository>;
