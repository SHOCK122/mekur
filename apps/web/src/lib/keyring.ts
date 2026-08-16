import { encryptEnvelope, decryptEnvelope, generateSymmetricKey } from "@schedule-app/crypto";
import { parseJsonOrThrow } from "./http.js";
import type { Session } from "./session.js";

const API_BASE = "/api";

/**
 * The keyring is the client-side index of which events this account can
 * reach. It exists because the server deliberately stores no user->event
 * association, which makes "list my events" unanswerable server-side (see
 * docs/ARCHITECTURE.md).
 *
 * It is stored server-side as a single opaque encrypted blob. Losing it
 * means losing access to every event in it -- the events remain on the
 * server, intact and permanently unreachable. Hence the version checking
 * and merge-on-conflict below: a silently dropped write is data loss, not
 * an inconvenience.
 */
export interface KeyringEntry {
  eventId: string;
  /** Always present: the minimum needed to read the event. */
  viewToken: string;
  /** Present only when this account may modify the event. */
  editToken?: string;
  /** Symmetric key for the event's content. Per-event rather than
   * per-user, so an event can be shared without sharing anything else. */
  eventKey: string;
  addedAt: string;
}

export interface Keyring {
  entries: KeyringEntry[];
  version: number;
}

function authHeaders(session: Session) {
  return { authorization: `Bearer ${session.token}` };
}

export async function loadKeyring(session: Session): Promise<Keyring> {
  const response = await fetch(`${API_BASE}/keyring`, { headers: authHeaders(session) });
  const body = await parseJsonOrThrow(response);
  if (!body.keyring) return { entries: [], version: 0 };
  const decrypted = decryptEnvelope<{ entries: KeyringEntry[] }>(
    body.keyring,
    session.encryptionKey
  );
  return { entries: decrypted.entries ?? [], version: body.version };
}

async function writeKeyring(
  session: Session,
  entries: KeyringEntry[],
  expectedVersion: number
): Promise<number> {
  const envelope = encryptEnvelope({ entries }, session.encryptionKey, "keyring");
  const response = await fetch(`${API_BASE}/keyring`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders(session) },
    body: JSON.stringify({ envelope, expectedVersion }),
  });
  if (response.status === 409) {
    const conflict = new Error("keyring-conflict");
    conflict.name = "KeyringConflict";
    throw conflict;
  }
  const body = await parseJsonOrThrow(response);
  return body.version as number;
}

/**
 * Applies a change to the keyring, retrying on conflict by reloading and
 * re-applying against the newer state rather than overwriting it. Two
 * devices adding different events concurrently must end up with *both*,
 * not whichever wrote last.
 */
export async function mutateKeyring(
  session: Session,
  mutate: (entries: KeyringEntry[]) => KeyringEntry[],
  attempts = 3
): Promise<KeyringEntry[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const current = await loadKeyring(session);
    const next = mutate(current.entries);
    try {
      await writeKeyring(session, next, current.version);
      return next;
    } catch (err) {
      if ((err as Error).name !== "KeyringConflict") throw err;
      lastError = err;
      // Loop: reload and re-apply against whatever the other device wrote.
    }
  }
  throw lastError ?? new Error("Could not save your keyring after several attempts.");
}

export async function addKeyringEntry(
  session: Session,
  entry: Omit<KeyringEntry, "addedAt">
): Promise<void> {
  await mutateKeyring(session, (entries) => [
    // Replace rather than duplicate if the same event arrives twice, e.g.
    // an invite for something already held. Keep the stronger capability.
    ...entries.filter((e) => e.eventId !== entry.eventId),
    {
      ...entry,
      editToken: entry.editToken ?? entries.find((e) => e.eventId === entry.eventId)?.editToken,
      addedAt: new Date().toISOString(),
    },
  ]);
}

export async function removeKeyringEntry(session: Session, eventId: string): Promise<void> {
  await mutateKeyring(session, (entries) => entries.filter((e) => e.eventId !== eventId));
}

export function newEventKey(): string {
  return generateSymmetricKey();
}
