import { encryptEnvelope, decryptEnvelope, deriveSharedWrapKey, generateKeyPair } from "@schedule-app/crypto";
import { authHeaders, parseJsonOrThrow } from "./http.js";
import type { Session } from "./session.js";
import { acceptSharedEvent } from "./events.js";

const API_BASE = "/api";

export interface FriendCode {
  code: string;
  createdAt: string;
}

export async function getFriendCode(session: Session): Promise<FriendCode> {
  const response = await fetch(`${API_BASE}/friend-code`, { headers: authHeaders(session, { hasBody: false }) });
  return (await parseJsonOrThrow(response)).friendCode;
}

export async function rotateFriendCode(session: Session): Promise<FriendCode> {
  const response = await fetch(`${API_BASE}/friend-code/rotate`, {
    method: "POST",
    headers: authHeaders(session, { hasBody: false }),
  });
  return (await parseJsonOrThrow(response)).friendCode;
}

export interface ResolvedTarget {
  userId: string;
  publicKey: string;
  displayName: string;
  username?: string;
  viaCode: boolean;
}

/** Resolves a username or one-time friend code to someone invitable.
 * Resolving a CODE consumes it, which is why this is a POST. */
export async function resolveTag(session: Session, tag: string): Promise<ResolvedTarget> {
  const response = await fetch(`${API_BASE}/tags/resolve`, {
    method: "POST",
    headers: authHeaders(session),
    body: JSON.stringify({ tag: tag.trim() }),
  });
  return (await parseJsonOrThrow(response)).target;
}

/** What an invite carries, encrypted to the recipient. The capability and
 * the event key travel together -- without both the recipient can't read
 * anything, and the server can read neither. */
export interface InvitePayload {
  kind: "event-invite";
  eventId: string;
  viewToken: string;
  editToken?: string;
  eventKey: string;
  /** Who sent it. Present only for username invites: an anonymous code
   * invite deliberately withholds this, and it is what lets the client
   * decide whether to offer "add as connection". */
  fromDisplayName?: string;
  fromUsername?: string;
  fromFriendCode?: string;
  viaCode: boolean;
}

/**
 * Shares an event by delivering a capability to someone's inbox, encrypted
 * to their public key using a fresh ephemeral keypair (the same
 * hybrid-encryption pattern noted in docs/ARCHITECTURE.md).
 *
 * This is deliberately NOT `deriveSharedWrapKey(session.identitySecretKey,
 * target.publicKey)` -- that derives a key from the *sender's* persistent
 * identity, which only the sender and someone who already knows the
 * sender's public key can reproduce. The recipient has no way to learn an
 * unknown sender's public key in advance (that's the whole point of the
 * capability model's inbox), so a message "encrypted to the sender" is
 * undecryptable by anyone but the sender themselves. Using a one-off
 * ephemeral keypair instead means the wrap key only ever depends on the
 * recipient's own (persistent) key plus the ephemeral public key travelling
 * alongside the ciphertext -- which the recipient always has both halves of.
 */
export async function sendInvite(
  session: Session,
  target: ResolvedTarget,
  payload: Omit<InvitePayload, "kind" | "viaCode">
): Promise<void> {
  const ephemeral = generateKeyPair();
  const wrapKey = deriveSharedWrapKey(ephemeral.secretKey, target.publicKey);
  const invite: InvitePayload = {
    kind: "event-invite",
    viaCode: target.viaCode,
    ...payload,
    // Never disclose who sent it when the recipient was reached
    // anonymously -- that is the whole purpose of a one-time code.
    fromDisplayName: target.viaCode ? undefined : payload.fromDisplayName,
    fromUsername: target.viaCode ? undefined : payload.fromUsername,
    fromFriendCode: target.viaCode ? undefined : payload.fromFriendCode,
  };
  const payloadEnvelope = encryptEnvelope(invite, wrapKey, "invite");
  const response = await fetch(`${API_BASE}/inbox/deliver`, {
    method: "POST",
    headers: authHeaders(session),
    body: JSON.stringify({
      recipientId: target.userId,
      envelope: { ephemeralPublicKey: ephemeral.publicKey, payload: payloadEnvelope },
    }),
  });
  if (!response.ok && response.status !== 204) await parseJsonOrThrow(response);
}

export interface Invitation {
  messageId: string;
  payload: InvitePayload;
  receivedAt: string;
}

/**
 * Reads the inbox and decrypts every message using the recipient's own
 * identity key plus the ephemeral public key each message carries -- see
 * sendInvite for why that's the only combination the recipient can always
 * reproduce. Malformed or foreign-shaped messages are skipped rather than
 * failing the whole list.
 */
export async function listInvitations(session: Session): Promise<Invitation[]> {
  const response = await fetch(`${API_BASE}/inbox`, { headers: authHeaders(session, { hasBody: false }) });
  const body = await parseJsonOrThrow(response);
  const invitations: Invitation[] = [];

  type InboxMessage = {
    id: string;
    envelope: { ephemeralPublicKey: string; payload: Parameters<typeof decryptEnvelope>[0] };
    createdAt: string;
  };
  for (const message of body.messages as InboxMessage[]) {
    try {
      const wrapKey = deriveSharedWrapKey(session.identitySecretKey, message.envelope.ephemeralPublicKey);
      const payload = decryptEnvelope<InvitePayload>(message.envelope.payload, wrapKey);
      if (payload.kind === "event-invite") {
        invitations.push({ messageId: message.id, payload, receivedAt: message.createdAt });
      }
    } catch {
      // Malformed message, or not an event-invite this client understands.
    }
  }
  return invitations;
}

export async function acceptInvitation(session: Session, invitation: Invitation): Promise<void> {
  await acceptSharedEvent(session, {
    eventId: invitation.payload.eventId,
    viewToken: invitation.payload.viewToken,
    editToken: invitation.payload.editToken,
    eventKey: invitation.payload.eventKey,
  });
  await dismissInvitation(session, invitation.messageId);
}

export async function dismissInvitation(session: Session, messageId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/inbox/${messageId}`, {
    method: "DELETE",
    headers: authHeaders(session, { hasBody: false }),
  });
  if (!response.ok && response.status !== 204) await parseJsonOrThrow(response);
}

/** Connections and blocks live only on this device: the server cannot
 * filter for you without learning who contacts whom. */
export interface Connection {
  friendCode: string;
  displayName: string;
  username?: string;
  state: "connected" | "blocked";
}

const CONNECTIONS_KEY = (userId: string) => `schedule-app:connections:${userId}`;

export function loadConnections(userId: string): Connection[] {
  try {
    const raw = localStorage.getItem(CONNECTIONS_KEY(userId));
    return raw ? (JSON.parse(raw) as Connection[]) : [];
  } catch {
    return [];
  }
}

export function saveConnection(userId: string, connection: Connection): void {
  const existing = loadConnections(userId).filter((c) => c.friendCode !== connection.friendCode);
  try {
    localStorage.setItem(CONNECTIONS_KEY(userId), JSON.stringify([...existing, connection]));
  } catch {
    // Storage failures must not break the app.
  }
}

export function isBlocked(userId: string, friendCode?: string): boolean {
  if (!friendCode) return false;
  return loadConnections(userId).some(
    (c) => c.friendCode === friendCode && c.state === "blocked"
  );
}
