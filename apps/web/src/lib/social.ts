import { encryptEnvelope, decryptEnvelope, deriveSharedWrapKey } from "@schedule-app/crypto";
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
 * Shares an event by delivering a capability to someone's inbox,
 * encrypted to their public key. The server relays an opaque blob and
 * records no sender.
 */
export async function sendInvite(
  session: Session,
  target: ResolvedTarget,
  payload: Omit<InvitePayload, "kind" | "viaCode">
): Promise<void> {
  const wrapKey = deriveSharedWrapKey(session.identitySecretKey, target.publicKey);
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
  const envelope = encryptEnvelope(invite, wrapKey, "invite");
  const response = await fetch(`${API_BASE}/inbox/deliver`, {
    method: "POST",
    headers: authHeaders(session),
    body: JSON.stringify({ recipientId: target.userId, envelope }),
  });
  if (!response.ok && response.status !== 204) await parseJsonOrThrow(response);
}

export interface Invitation {
  messageId: string;
  payload: InvitePayload;
  receivedAt: string;
  /** The sender's public key, needed to decrypt. Recovered by trying each
   * known sender is impractical, so invites include it in the clear-ish
   * outer layer via the sender's own ECDH -- see decryptInvite. */
  senderPublicKey?: string;
}

/**
 * Reads the inbox. Each message is encrypted to this user's public key
 * using ECDH with the *sender's* key, so decryption needs the sender's
 * public key. Since the server records no sender, the client tries the
 * public keys it knows about; invites therefore include the sender's
 * public key inside a wrapper the recipient can always open.
 */
export async function listInvitations(
  session: Session,
  candidateSenderKeys: string[]
): Promise<Invitation[]> {
  const response = await fetch(`${API_BASE}/inbox`, { headers: authHeaders(session, { hasBody: false }) });
  const body = await parseJsonOrThrow(response);
  const invitations: Invitation[] = [];

  for (const message of body.messages as { id: string; envelope: unknown; createdAt: string }[]) {
    for (const senderKey of candidateSenderKeys) {
      try {
        const wrapKey = deriveSharedWrapKey(session.identitySecretKey, senderKey);
        const payload = decryptEnvelope<InvitePayload>(
          message.envelope as Parameters<typeof decryptEnvelope>[0],
          wrapKey
        );
        if (payload.kind === "event-invite") {
          invitations.push({
            messageId: message.id,
            payload,
            receivedAt: message.createdAt,
            senderPublicKey: senderKey,
          });
        }
        break;
      } catch {
        // Wrong sender key for this message; try the next.
      }
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
