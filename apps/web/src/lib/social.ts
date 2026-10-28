import { sealToRecipient, openSealed } from "@schedule-app/crypto";
import type { SealedEnvelope } from "@schedule-app/shared";
import { apiFetch } from "./http.js";
import type { Session } from "./session.js";
import { acceptSharedEvent } from "./events.js";

export interface FriendCode {
  code: string;
  createdAt: string;
}

export async function getFriendCode(session: Session): Promise<FriendCode> {
  return (await apiFetch(session, "/friend-code")).friendCode;
}

export async function rotateFriendCode(session: Session): Promise<FriendCode> {
  return (await apiFetch(session, "/friend-code/rotate", { method: "POST" })).friendCode;
}

export interface ResolvedTarget {
  userId: string;
  publicKey: string;
  displayName: string;
  username?: string;
  /** True when reached through a one-time code: the recipient stays
   * anonymous to the sender, and the sender stays anonymous in return. */
  viaCode: boolean;
}

/** Resolves a username or one-time friend code to someone invitable.
 * Resolving a CODE consumes it, which is why this is a POST. */
export async function resolveTag(session: Session, tag: string): Promise<ResolvedTarget> {
  return (await apiFetch(session, "/tags/resolve", { method: "POST", body: { tag: tag.trim() } })).target;
}

/** What an invite carries, sealed to the recipient. The capability and the
 * event key travel together -- without both the recipient can't read
 * anything, and the server can read neither. */
export interface InvitePayload {
  kind: "event-invite";
  eventId: string;
  viewToken: string;
  editToken?: string;
  eventKey: string;
  /** Self-described name, present only on named invites. Bound to the
   * sender's verified key, but the *name* is whatever they chose to send. */
  fromDisplayName?: string;
  fromUsername?: string;
  viaCode: boolean;
}

/**
 * Shares an event by sealing a capability to someone's public key and
 * dropping it in their inbox. The server relays an opaque blob, records no
 * sender, and -- because each envelope uses a fresh ephemeral key -- can't
 * link two invites from the same person either.
 *
 * Named invites prove who sent them, inside the encryption, so the
 * recipient can connect with or block a real identity. Invites to someone
 * reached by one-time code stay anonymous both ways: that is the code's
 * whole purpose.
 */
export async function sendInvite(
  session: Session,
  target: ResolvedTarget,
  capability: { eventId: string; viewToken: string; editToken?: string; eventKey: string }
): Promise<void> {
  const invite: InvitePayload = {
    kind: "event-invite",
    ...capability,
    viaCode: target.viaCode,
    ...(target.viaCode ? {} : { fromDisplayName: session.username, fromUsername: session.username }),
  };
  const sender = target.viaCode
    ? undefined
    : { publicKey: session.identityPublicKey, secretKey: session.identitySecretKey };
  await apiFetch(session, "/inbox/deliver", {
    method: "POST",
    body: { recipientId: target.userId, envelope: sealToRecipient(invite, target.publicKey, sender) },
  });
}

export interface Invitation {
  messageId: string;
  payload: InvitePayload;
  receivedAt: string;
  /** The sender's *verified* public key, or null for an anonymous invite.
   * This, not any name, is what connections and blocks are keyed by. */
  senderPublicKey: string | null;
}

export interface Inbox {
  invitations: Invitation[];
  /** Messages that can never be opened: corrupt, a forged sender proof, or
   * sealed to a stale key. Returned so the caller can delete them -- left
   * in place they'd count toward the server's inbox cap forever. */
  unreadable: string[];
}

/**
 * Reads the inbox. Every message is sealed to this account's public key, so
 * it opens with our own secret key alone -- no need to know, or guess, who
 * sent it. A message that fails to open is reported, not thrown, so one bad
 * message can't break the whole list.
 */
export async function readInbox(session: Session): Promise<Inbox> {
  const body = await apiFetch(session, "/inbox");
  const invitations: Invitation[] = [];
  const unreadable: string[] = [];
  for (const message of body.messages as { id: string; envelope: SealedEnvelope; createdAt: string }[]) {
    try {
      const opened = openSealed<InvitePayload>(message.envelope, session.identitySecretKey);
      if (opened.payload.kind !== "event-invite") {
        unreadable.push(message.id);
        continue;
      }
      invitations.push({
        messageId: message.id,
        payload: opened.payload,
        receivedAt: message.createdAt,
        senderPublicKey: opened.senderPublicKey,
      });
    } catch {
      unreadable.push(message.id);
    }
  }
  return { invitations, unreadable };
}

export async function acceptInvitation(session: Session, invitation: Invitation): Promise<void> {
  const { eventId, viewToken, editToken, eventKey } = invitation.payload;
  await acceptSharedEvent(session, { eventId, viewToken, editToken, eventKey });
  await dismissInvitation(session, invitation.messageId);
}

export async function dismissInvitation(session: Session, messageId: string): Promise<void> {
  await apiFetch(session, `/inbox/${messageId}`, { method: "DELETE" });
}

/**
 * Connections and blocks live only on this device: the server cannot
 * filter for you without learning who contacts whom.
 *
 * Keyed by the sender's verified public key. (They used to be keyed by the
 * sender's friend code, which replaces itself the moment anyone uses it --
 * so a block stopped working almost immediately.)
 */
export interface Connection {
  publicKey: string;
  displayName: string;
  username?: string;
  state: "connected" | "blocked";
}

const CONNECTIONS_KEY = (userId: string) => `schedule-app:connections:${userId}`;

export function loadConnections(userId: string): Connection[] {
  try {
    const raw = localStorage.getItem(CONNECTIONS_KEY(userId));
    const parsed = raw ? (JSON.parse(raw) as Connection[]) : [];
    // Entries from the friend-code era have no public key and can't match
    // anything; drop them.
    return parsed.filter((c) => typeof c.publicKey === "string");
  } catch {
    return [];
  }
}

export function saveConnection(userId: string, connection: Connection): void {
  const others = loadConnections(userId).filter((c) => c.publicKey !== connection.publicKey);
  try {
    localStorage.setItem(CONNECTIONS_KEY(userId), JSON.stringify([...others, connection]));
  } catch {
    // Storage failures must not break the app.
  }
}

export function findConnection(userId: string, publicKey: string | null): Connection | null {
  if (!publicKey) return null;
  return loadConnections(userId).find((c) => c.publicKey === publicKey) ?? null;
}
