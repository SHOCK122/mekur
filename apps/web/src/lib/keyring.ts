import { encryptEnvelope, decryptEnvelope, generateSymmetricKey } from "@schedule-app/crypto";
import { apiFetch, ApiError } from "./http.js";
import type { Session } from "./session.js";

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

/**
 * The last keyring this tab loaded or wrote, keyed by session token so a
 * sign-out/sign-in never serves one account's keyring to another. Reads
 * that only need a token or key (editing, sharing) use it instead of
 * re-downloading and re-decrypting the whole keyring every time. Writes
 * always reload first, because the version check needs the server's copy.
 */
let cache: { token: string; keyring: Keyring } | null = null;

export function clearKeyringCache(): void {
  cache = null;
}

/** Fetches the keyring from the server. */
export async function loadKeyring(session: Session): Promise<Keyring> {
  const body = await apiFetch(session, "/keyring");
  const keyring: Keyring = body.keyring
    ? {
        entries:
          decryptEnvelope<{ entries: KeyringEntry[] }>(body.keyring, session.encryptionKey).entries ?? [],
        version: body.version,
      }
    : { entries: [], version: 0 };
  cache = { token: session.token, keyring };
  return keyring;
}

/** This account's entry for an event, from the cached keyring if one is
 * loaded. */
export async function findEntry(session: Session, eventId: string): Promise<KeyringEntry | null> {
  const keyring = cache?.token === session.token ? cache.keyring : await loadKeyring(session);
  return keyring.entries.find((e) => e.eventId === eventId) ?? null;
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
  for (let attempt = 0; attempt < attempts; attempt++) {
    const current = await loadKeyring(session);
    const entries = mutate(current.entries);
    const envelope = encryptEnvelope({ entries }, session.encryptionKey, "keyring");
    try {
      const body = await apiFetch(session, "/keyring", {
        method: "PUT",
        body: { envelope, expectedVersion: current.version },
      });
      cache = { token: session.token, keyring: { entries, version: body.version } };
      return entries;
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409)) throw err;
      // Another device wrote first: loop, reload, and re-apply on top of it.
    }
  }
  throw new Error("Could not save your keyring after several attempts.");
}

export async function addKeyringEntry(
  session: Session,
  entry: Omit<KeyringEntry, "addedAt">
): Promise<void> {
  await mutateKeyring(session, (entries) => {
    // Replace rather than duplicate if the same event arrives twice, e.g.
    // an invite for something already held -- but never downgrade: keep an
    // edit token we already had.
    const existing = entries.find((e) => e.eventId === entry.eventId);
    return [
      ...entries.filter((e) => e.eventId !== entry.eventId),
      {
        ...entry,
        editToken: entry.editToken ?? existing?.editToken,
        addedAt: existing?.addedAt ?? new Date().toISOString(),
      },
    ];
  });
}

export async function removeKeyringEntry(session: Session, eventId: string): Promise<void> {
  await mutateKeyring(session, (entries) => entries.filter((e) => e.eventId !== eventId));
}

export function newEventKey(): string {
  return generateSymmetricKey();
}
