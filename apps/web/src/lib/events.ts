import { encryptEnvelope, decryptEnvelope } from "@schedule-app/crypto";
import type { EncryptedEnvelope, EventContent } from "@schedule-app/shared";
import { apiFetch } from "./http.js";
import type { Session } from "./session.js";
import {
  loadKeyring,
  findEntry,
  addKeyringEntry,
  removeKeyringEntry,
  newEventKey,
  type KeyringEntry,
} from "./keyring.js";

export interface DecryptedEvent extends EventContent {
  id: string;
  updatedAt?: string;
  /** Whether this account holds an edit capability. The UI uses this to
   * decide what to offer; the server enforces it regardless. */
  canEdit: boolean;
}

/** Strips the client-side bookkeeping, leaving exactly what gets encrypted. */
export function toContent(event: DecryptedEvent): EventContent {
  const { id: _id, updatedAt: _updatedAt, canEdit: _canEdit, ...content } = event;
  return content;
}

/**
 * Events under the capability model. Note there is no "list my events"
 * call: the server cannot answer that. The keyring supplies which events
 * exist and the tokens to read them, and this batch-reads them.
 */
export async function listEvents(session: Session): Promise<DecryptedEvent[]> {
  const keyring = await loadKeyring(session);
  if (keyring.entries.length === 0) return [];

  const body = await apiFetch(session, "/events/batch-read", {
    method: "POST",
    body: { events: keyring.entries.map((e) => ({ eventId: e.eventId, token: e.viewToken })) },
  });

  const byId = new Map<string, KeyringEntry>(keyring.entries.map((e) => [e.eventId, e]));
  const decrypted: DecryptedEvent[] = [];
  for (const record of body.events as { id: string; envelope: EncryptedEnvelope; updatedAt?: string }[]) {
    const entry = byId.get(record.id);
    if (!entry) continue;
    try {
      decrypted.push({
        ...decryptEnvelope<EventContent>(record.envelope, entry.eventKey),
        id: record.id,
        updatedAt: record.updatedAt,
        canEdit: Boolean(entry.editToken),
      });
    } catch {
      // One undecryptable event must not blank the whole calendar. Skip it
      // and keep going; the keyring entry is stale or the key is wrong.
    }
  }
  return decrypted;
}

export async function createEvent(session: Session, content: EventContent): Promise<DecryptedEvent> {
  // A fresh per-event key, so this event can later be shared without
  // exposing anything else the account holds.
  const eventKey = newEventKey();
  const body = await apiFetch(session, "/events", {
    method: "POST",
    body: { envelope: encryptEnvelope(content, eventKey, "event") },
  });

  // The tokens are returned exactly once and cannot be re-fetched, so the
  // keyring write must happen now.
  await addKeyringEntry(session, {
    eventId: body.event.id,
    viewToken: body.viewToken,
    editToken: body.editToken,
    eventKey,
  });

  return { ...content, id: body.event.id, canEdit: true };
}

async function editableEntry(session: Session, eventId: string, action: string): Promise<KeyringEntry> {
  const entry = await findEntry(session, eventId);
  if (!entry?.editToken) throw new Error(`You don't have permission to ${action} this event.`);
  return entry;
}

export async function updateEvent(session: Session, eventId: string, content: EventContent): Promise<void> {
  const entry = await editableEntry(session, eventId, "edit");
  await apiFetch(session, `/events/${eventId}`, {
    method: "PUT",
    capability: entry.editToken,
    body: { envelope: encryptEnvelope(content, entry.eventKey, "event") },
  });
}

/** Deletes the event for everyone who holds it. */
export async function deleteEvent(session: Session, eventId: string): Promise<void> {
  const entry = await editableEntry(session, eventId, "delete");
  await apiFetch(session, `/events/${eventId}`, { method: "DELETE", capability: entry.editToken });
  await removeKeyringEntry(session, eventId);
}

/**
 * Removes an event from this account's schedule only, by dropping the
 * keyring entry. The event is untouched for everyone else -- this is what a
 * view-only holder gets instead of "delete".
 */
export async function leaveEvent(session: Session, eventId: string): Promise<void> {
  await removeKeyringEntry(session, eventId);
}

/**
 * Share codes carry the capability AND the event key together, because the
 * server holds neither and so cannot supply the key to a late joiner (see
 * docs/ARCHITECTURE.md). That makes the code itself the secret: anyone it
 * is forwarded to gains the same access, which is why the UI must present
 * it as sensitive rather than as a convenience link.
 */
export interface ShareCodePayload {
  eventId: string;
  viewToken: string;
  eventKey: string;
}

export function encodeShareCode(payload: ShareCodePayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeShareCode(code: string): ShareCodePayload {
  let parsed: Partial<ShareCodePayload>;
  try {
    const normalised = code.trim().replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalised + "=".repeat((4 - (normalised.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    parsed = {};
  }
  if (!parsed.eventId || !parsed.viewToken || !parsed.eventKey) {
    throw new Error("That doesn't look like a valid event code.");
  }
  return parsed as ShareCodePayload;
}

/** Mints a reusable view capability and packages it with the event key. */
export async function createShareCode(session: Session, eventId: string): Promise<string> {
  const entry = await editableEntry(session, eventId, "share");
  const body = await apiFetch(session, `/events/${eventId}/capabilities`, {
    method: "POST",
    capability: entry.editToken,
    body: { level: "view", expiresAt: null },
  });
  return encodeShareCode({ eventId, viewToken: body.token, eventKey: entry.eventKey });
}

/** Records a capability received from someone else -- via an invitation or
 * an event code -- so the event shows up like any other. */
export async function acceptSharedEvent(
  session: Session,
  shared: { eventId: string; viewToken: string; editToken?: string; eventKey: string }
): Promise<void> {
  await addKeyringEntry(session, shared);
}

/** Redeems an event code. */
export async function redeemShareCode(session: Session, code: string): Promise<string> {
  const payload = decodeShareCode(code);
  // Verify the capability actually works before storing it, so a bad code
  // fails now with a clear message rather than appearing to succeed and
  // then silently producing an unreadable event.
  try {
    await apiFetch(session, `/events/${payload.eventId}`, { capability: payload.viewToken });
  } catch {
    throw new Error("That code isn't valid, or the event is no longer shared.");
  }
  await acceptSharedEvent(session, payload);
  return payload.eventId;
}
