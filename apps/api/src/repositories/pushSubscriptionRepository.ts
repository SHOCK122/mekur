import type { Database } from "../db/pool.js";

export interface PushSubscriptionRecord {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

interface Row {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

function toRecord(row: Row): PushSubscriptionRecord {
  return { id: row.id, userId: row.user_id, endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth };
}

export function createPushSubscriptionRepository(db: Database) {
  return {
    /** Re-subscribing the same browser/device (same endpoint) updates its
     * keys rather than creating a duplicate row. */
    async upsert(
      userId: string,
      endpoint: string,
      p256dh: string,
      auth: string
    ): Promise<PushSubscriptionRecord> {
      const result = await db.query<Row>(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4
         RETURNING id, user_id, endpoint, p256dh, auth`,
        [userId, endpoint, p256dh, auth]
      );
      const row = result.rows[0];
      if (!row) throw new Error("Insert returned no row");
      return toRecord(row);
    },

    async listForUser(userId: string): Promise<PushSubscriptionRecord[]> {
      const result = await db.query<Row>(
        `SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
        [userId]
      );
      return result.rows.map(toRecord);
    },

    async deleteByEndpoint(endpoint: string): Promise<void> {
      await db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
    },

    async deleteForUser(endpoint: string, userId: string): Promise<boolean> {
      const result = await db.query(
        `DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`,
        [endpoint, userId]
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}

export type PushSubscriptionRepository = ReturnType<typeof createPushSubscriptionRepository>;
