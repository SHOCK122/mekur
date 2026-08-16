import type { Database } from "../db/pool.js";
import { generateCapabilityToken, hashCapabilityToken } from "../lib/capability.js";

export type CapabilityLevel = "view" | "edit";

export interface EventRecord {
  id: string;
  envelope: unknown;
  slotIds: string[];
  status: "open" | "resolved";
  resolvedSlotId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EventRow {
  id: string;
  envelope: unknown;
  slot_ids: string[];
  status: "open" | "resolved";
  resolved_slot_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function toEventRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    envelope: row.envelope,
    slotIds: row.slot_ids,
    status: row.status,
    resolvedSlotId: row.resolved_slot_id,
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
  async function resolveCapability(
    eventId: string,
    token: string,
    required: CapabilityLevel
  ): Promise<boolean> {
    const result = await db.query<{ level: CapabilityLevel }>(
      `SELECT level FROM event_capabilities
       WHERE event_id = $1 AND token_hash = $2
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())`,
      [eventId, hashCapabilityToken(token)]
    );
    const level = result.rows[0]?.level;
    if (!level) return false;
    // An edit capability implies view; the reverse must never hold.
    return required === "view" ? true : level === "edit";
  }

  return {
    resolveCapability,

    async create(envelope: unknown, slotIds: string[] = []): Promise<CreatedEvent> {
      const viewToken = generateCapabilityToken();
      const editToken = generateCapabilityToken();
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const inserted = await client.query<EventRow>(
          `INSERT INTO events (envelope, slot_ids) VALUES ($1, $2)
           RETURNING id, envelope, slot_ids, status, resolved_slot_id, created_at, updated_at`,
          [envelope, slotIds]
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
        `SELECT id, envelope, slot_ids, status, resolved_slot_id, created_at, updated_at
         FROM events WHERE id = $1`,
        [eventId]
      );
      const row = result.rows[0];
      return row ? toEventRecord(row) : null;
    },

    /** Batch read for the timeline: the client presents the capabilities it
     * holds from its keyring. Bounded so one request can't ask for
     * unlimited work. */
    async findManyByCapabilities(
      entries: { eventId: string; token: string }[]
    ): Promise<EventRecord[]> {
      const found: EventRecord[] = [];
      for (const entry of entries.slice(0, 500)) {
        const event = await this.findByCapability(entry.eventId, entry.token);
        if (event) found.push(event);
      }
      return found;
    },

    async update(eventId: string, token: string, envelope: unknown): Promise<EventRecord | null> {
      if (!(await resolveCapability(eventId, token, "edit"))) return null;
      const result = await db.query<EventRow>(
        `UPDATE events SET envelope = $2, updated_at = now() WHERE id = $1
         RETURNING id, envelope, slot_ids, status, resolved_slot_id, created_at, updated_at`,
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
