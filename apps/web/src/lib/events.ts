import { encryptEnvelope, decryptEnvelope } from "@schedule-app/crypto";
import type { EventContent } from "@schedule-app/shared";
import { parseJsonOrThrow } from "./http.js";
import type { Session } from "./session.js";
import {
  loadKeyring,
  addKeyringEntry,
  removeKeyringEntry,
  newEventKey,
  type KeyringEntry,
} from "./keyring.js";

const API_BASE = "/api";

/** `hasBody` matters: sending Content-Type: application/json with no body
 * makes Fastify reject the request outright (FST_ERR_CTP_EMPTY_JSON_BODY),
 * which is what broke DELETE. */
function authHeaders(session: Session, capability?: string, hasBody = true) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${session.token}`,
  };
  if (hasBody) headers["Content-Type"] = "application/json";
  if (capability) headers["x-event-capability"] = capability;
  return headers;
}

export interface DecryptedEvent extends EventContent {
  id: string;
  updatedAt?: string;
  /** Whether this account holds an edit capability. The UI uses this to
   * decide what to offer; the server enforces it regardless. */
  canEdit: boolean;
}

/**
 * Events under the capability model. Note there is no "list my events"
 * call: the server cannot answer that. The keyring supplies which events
 * exist and the tokens to read them, and this batch-reads them.
 */
export async function listEvents(session: Session): Promise<DecryptedEvent[]> {
  const keyring = await loadKeyring(session);
  if (keyring.entries.length === 0) return [];

  const response = await fetch(`${API_BASE}/events/batch-read`, {
    method: "POST",
    headers: authHeaders(session),
    body: JSON.stringify({
      events: keyring.entries.map((e) => ({ eventId: e.eventId, token: e.viewToken })),
    }),
  });
  const body = await parseJsonOrThrow(response);

  const byId = new Map<string, KeyringEntry>(keyring.entries.map((e) => [e.eventId, e]));
  const decrypted: DecryptedEvent[] = [];
  for (const record of body.events as { id: string; envelope: unknown; updatedAt?: string }[]) {
    const entry = byId.get(record.id);
    if (!entry) continue;
    try {
      const content = decryptEnvelope<EventContent>(
        record.envelope as Parameters<typeof decryptEnvelope>[0],
        entry.eventKey
      );
      decrypted.push({
        ...content,
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

export async function createEvent(
  session: Session,
  content: EventContent
): Promise<DecryptedEvent> {
  // A fresh per-event key, so this event can later be shared without
  // exposing anything else the account holds.
  const eventKey = newEventKey();
  const envelope = encryptEnvelope(content, eventKey, "event");

  const response = await fetch(`${API_BASE}/events`, {
    method: "POST",
    headers: authHeaders(session),
    body: JSON.stringify({ envelope }),
  });
  const body = await parseJsonOrThrow(response);

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

async function entryFor(session: Session, eventId: string): Promise<KeyringEntry | null> {
  const keyring = await loadKeyring(session);
  return keyring.entries.find((e) => e.eventId === eventId) ?? null;
}

export async function updateEvent(
  session: Session,
  eventId: string,
  content: EventContent
): Promise<DecryptedEvent> {
  const entry = await entryFor(session, eventId);
  if (!entry?.editToken) {
    throw new Error("You don't have permission to edit this event.");
  }
  const envelope = encryptEnvelope(content, entry.eventKey, "event");
  const response = await fetch(`${API_BASE}/events/${eventId}`, {
    method: "PUT",
    headers: authHeaders(session, entry.editToken),
    body: JSON.stringify({ envelope }),
  });
  await parseJsonOrThrow(response);
  return { ...content, id: eventId, canEdit: true };
}

export async function deleteEvent(session: Session, eventId: string): Promise<void> {
  const entry = await entryFor(session, eventId);
  if (!entry?.editToken) {
    throw new Error("You don't have permission to delete this event.");
  }
  const response = await fetch(`${API_BASE}/events/${eventId}`, {
    method: "DELETE",
    headers: authHeaders(session, entry.editToken, false),
  });
  if (!response.ok && response.status !== 204) await parseJsonOrThrow(response);
  await removeKeyringEntry(session, eventId);
}

/** Mints a reusable join capability -- the "event code" for inviting. */
export async function mintJoinCode(
  session: Session,
  eventId: string,
  level: "view" | "edit" = "view",
  expiresAt: string | null = null
): Promise<string> {
  const entry = await entryFor(session, eventId);
  if (!entry?.editToken) {
    throw new Error("You don't have permission to share this event.");
  }
  const response = await fetch(`${API_BASE}/events/${eventId}/capabilities`, {
    method: "POST",
    headers: authHeaders(session, entry.editToken),
    body: JSON.stringify({ level, expiresAt }),
  });
  const body = await parseJsonOrThrow(response);
  return body.token as string;
}

/**
 * Accepts an event shared by someone else. The capability and key arrive
 * out of band (an inbox message or a share link's fragment); this records
 * them so the event shows up like any other.
 */
export async function acceptSharedEvent(
  session: Session,
  shared: { eventId: string; viewToken: string; editToken?: string; eventKey: string }
): Promise<void> {
  await addKeyringEntry(session, shared);
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
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeShareCode(code: string): ShareCodePayload {
  const normalised = code.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised + "=".repeat((4 - (normalised.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as ShareCodePayload;
  if (!parsed.eventId || !parsed.viewToken || !parsed.eventKey) {
    throw new Error("That doesn't look like a valid event code.");
  }
  return parsed;
}

/** Mints a reusable join capability and packages it with the event key. */
export async function createShareCode(session: Session, eventId: string): Promise<string> {
  const entry = await entryFor(session, eventId);
  if (!entry?.editToken) {
    throw new Error("You don't have permission to share this event.");
  }
  const joinToken = await mintJoinCode(session, eventId, "view");
  return encodeShareCode({ eventId, viewToken: joinToken, eventKey: entry.eventKey });
}

/** Redeems a share code by recording its capability in the keyring. */
export async function redeemShareCode(session: Session, code: string): Promise<string> {
  const payload = decodeShareCode(code);
  // Verify the capability actually works before storing it, so a bad code
  // fails now with a clear message rather than appearing to succeed and
  // then silently producing an unreadable event.
  const response = await fetch(`${API_BASE}/events/${payload.eventId}`, {
    headers: authHeaders(session, payload.viewToken, false),
  });
  if (!response.ok) {
    throw new Error("That code isn't valid, or the event is no longer shared.");
  }
  await acceptSharedEvent(session, payload);
  return payload.eventId;
}
