import type { Database } from "../db/pool.js";
import { generateCapabilityToken, hashCapabilityToken } from "../lib/capability.js";

export type CapabilityLevel = "view" | "edit";

/** Maximum capabilities one batch read may present. */
export const BATCH_READ_LIMIT = 500;

const EVENT_COLUMNS = "id, envelope, created_at, updated_at";

export interface EventRecord {
  id: string;
  envelope: unknown;
  createdAt: string;
  updatedAt: string;
}

interface EventRow {
  id: string;
  envelope: unknown;
  created_at: Date;
  updated_at: Date;
}

function toEventRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    envelope: row.envelope,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface CreatedEvent {
  event: EventRecord;
  viewToken: string;
  editToken: string;
}

/**
 * Events under the capability model. Nothing here takes a user id:
 * authorisation is proven by presenting a token, never by matching an
 * identity against an access list.
 */
export function createEventRepository(db: Database) {
  // A capability counts only while unrevoked and unexpired. Shared by
  // every lookup so the rule can't drift between single and batch reads.
  const LIVE = "c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > now())";

  async function resolveCapability(
    eventId: string,
    token: string,
    required: CapabilityLevel
  ): Promise<boolean> {
    const result = await db.query<{ level: CapabilityLevel }>(
      `SELECT c.level FROM event_capabilities c
       WHERE c.event_id = $1 AND c.token_hash = $2 AND ${LIVE}`,
      [eventId, hashCapabilityToken(token)]
    );
    const level = result.rows[0]?.level;
    if (!level) return false;
    // An edit capability implies view; the reverse must never hold.
    return required === "view" ? true : level === "edit";
  }

  return {
    resolveCapability,

    async create(envelope: unknown): Promise<CreatedEvent> {
      const viewToken = generateCapabilityToken();
      const editToken = generateCapabilityToken();
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const inserted = await client.query<EventRow>(
          `INSERT INTO events (envelope) VALUES ($1) RETURNING ${EVENT_COLUMNS}`,
          [envelope]
        );
        const row = inserted.rows[0];
        if (!row) throw new Error("Insert returned no row");
        for (const [token, level] of [
          [viewToken, "view"],
          [editToken, "edit"],
        ] as const) {
          await client.query(
            `INSERT INTO event_capabilities (event_id, token_hash, level) VALUES ($1, $2, $3)`,
            [row.id, hashCapabilityToken(token), level]
          );
        }
        await client.query("COMMIT");
        return { event: toEventRecord(row), viewToken, editToken };
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async findByCapability(eventId: string, token: string): Promise<EventRecord | null> {
      if (!(await resolveCapability(eventId, token, "view"))) return null;
      const result = await db.query<EventRow>(
        `SELECT ${EVENT_COLUMNS} FROM events WHERE id = $1`,
        [eventId]
      );
      const row = result.rows[0];
      return row ? toEventRecord(row) : null;
    },

    /** Batch read for the timeline: the client presents the capabilities it
     * holds from its keyring. One query regardless of how many are
     * presented (it used to be two per event), and bounded so one request
     * can't ask for unlimited work. Entries whose capability is missing,
     * revoked or expired are simply absent from the result. */
    async findManyByCapabilities(
      entries: { eventId: string; token: string }[]
    ): Promise<EventRecord[]> {
      const bounded = entries.slice(0, BATCH_READ_LIMIT);
      if (bounded.length === 0) return [];
      const result = await db.query<EventRow>(
        `SELECT DISTINCT e.id, e.envelope, e.created_at, e.updated_at
         FROM unnest($1::uuid[], $2::text[]) AS presented(event_id, token_hash)
         JOIN event_capabilities c
           ON c.event_id = presented.event_id AND c.token_hash = presented.token_hash
         JOIN events e ON e.id = c.event_id
         WHERE ${LIVE}`,
        [bounded.map((e) => e.eventId), bounded.map((e) => hashCapabilityToken(e.token))]
      );
      return result.rows.map(toEventRecord);
    },

    async update(eventId: string, token: string, envelope: unknown): Promise<EventRecord | null> {
      if (!(await resolveCapability(eventId, token, "edit"))) return null;
      const result = await db.query<EventRow>(
        `UPDATE events SET envelope = $2, updated_at = now() WHERE id = $1
         RETURNING ${EVENT_COLUMNS}`,
        [eventId, envelope]
      );
      const row = result.rows[0];
      return row ? toEventRecord(row) : null;
    },

    async remove(eventId: string, token: string): Promise<boolean> {
      if (!(await resolveCapability(eventId, token, "edit"))) return false;
      const result = await db.query(`DELETE FROM events WHERE id = $1`, [eventId]);
      return (result.rowCount ?? 0) > 0;
    },

    /** Mints an additional capability, e.g. a reusable join code. */
    async mintCapability(
      eventId: string,
      editToken: string,
      level: CapabilityLevel,
      expiresAt: Date | null
    ): Promise<string | null> {
      if (!(await resolveCapability(eventId, editToken, "edit"))) return null;
      const token = generateCapabilityToken();
      await db.query(
        `INSERT INTO event_capabilities (event_id, token_hash, level, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [eventId, hashCapabilityToken(token), level, expiresAt]
      );
      return token;
    },

    /** Revokes a specific capability. Stops future use; cannot retract a
     * token already copied -- real revocation means re-keying the event. */
    async revokeCapability(eventId: string, editToken: string, target: string): Promise<boolean> {
      if (!(await resolveCapability(eventId, editToken, "edit"))) return false;
      const result = await db.query(
        `UPDATE event_capabilities SET revoked_at = now()
         WHERE event_id = $1 AND token_hash = $2 AND revoked_at IS NULL`,
        [eventId, hashCapabilityToken(target)]
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}

export type EventRepository = ReturnType<typeof createEventRepository>;
