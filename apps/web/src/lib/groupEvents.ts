import {
  deriveSharedWrapKey,
  wrapKey,
  unwrapKey,
  generateSymmetricKey,
  encryptEnvelope,
  decryptEnvelope,
} from "@schedule-app/crypto";
import type { GroupEventContent, Slot } from "@schedule-app/shared";
import type { Session } from "./session.js";

const API_BASE = "/api";

async function parseJsonOrThrow(response: Response): Promise<any> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error ?? `Request failed with status ${response.status}`);
  }
  return body;
}

function authHeaders(session: Session) {
  return { authorization: `Bearer ${session.token}` };
}

export interface DirectoryUser {
  id: string;
  username: string;
  displayName: string;
  publicKey: string;
}

export async function lookupUser(session: Session, username: string): Promise<DirectoryUser> {
  const response = await fetch(`${API_BASE}/users/${encodeURIComponent(username)}`, {
    headers: authHeaders(session),
  });
  const body = await parseJsonOrThrow(response);
  return body.user;
}

export interface DecryptedGroupEvent {
  id: string;
  organizerId: string;
  status: "open" | "resolved";
  resolvedSlotId: string | null;
  slotIds: string[];
  myVotes: { slotId: string; rank: number }[];
  createdAt: string;
  title: string;
  description?: string;
  slots: Record<string, Slot>;
}

interface RawGroupEventRecord {
  id: string;
  organizerId: string;
  organizerPublicKey: string;
  slotIds: string[];
  contentEnvelope: Parameters<typeof decryptEnvelope>[0];
  status: "open" | "resolved";
  resolvedSlotId: string | null;
  createdAt: string;
  myWrappedKey: Parameters<typeof unwrapKey>[0];
  myVotes: { slotId: string; rank: number }[];
}

function decryptRecord(session: Session, record: RawGroupEventRecord): DecryptedGroupEvent {
  const myWrapKey = deriveSharedWrapKey(session.identitySecretKey, record.organizerPublicKey);
  const eventKey = unwrapKey(record.myWrappedKey, myWrapKey);
  const content = decryptEnvelope<GroupEventContent>(record.contentEnvelope, eventKey);
  return {
    id: record.id,
    organizerId: record.organizerId,
    status: record.status,
    resolvedSlotId: record.resolvedSlotId,
    slotIds: record.slotIds,
    myVotes: record.myVotes,
    createdAt: record.createdAt,
    title: content.title,
    description: content.description,
    slots: content.slots,
  };
}

export interface CreateGroupEventInput {
  title: string;
  description?: string;
  slots: Record<string, Slot>;
  inviteeUsernames: string[];
}

export async function createGroupEvent(
  session: Session,
  input: CreateGroupEventInput
): Promise<DecryptedGroupEvent> {
  const invitees = await Promise.all(
    input.inviteeUsernames.map((username) => lookupUser(session, username))
  );

  const eventKey = generateSymmetricKey();
  const contentEnvelope = encryptEnvelope(
    { title: input.title, description: input.description, slots: input.slots },
    eventKey,
    "group-event-key"
  );

  const participants = [
    {
      userId: session.userId,
      wrappedKey: wrapKey(eventKey, deriveSharedWrapKey(session.identitySecretKey, session.identityPublicKey)),
    },
    ...invitees.map((invitee) => ({
      userId: invitee.id,
      wrappedKey: wrapKey(eventKey, deriveSharedWrapKey(session.identitySecretKey, invitee.publicKey)),
    })),
  ];

  const response = await fetch(`${API_BASE}/group-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(session) },
    body: JSON.stringify({ slotIds: Object.keys(input.slots), contentEnvelope, participants }),
  });
  const body = await parseJsonOrThrow(response);
  return decryptRecord(session, body.groupEvent);
}

export async function listGroupEvents(session: Session): Promise<DecryptedGroupEvent[]> {
  const response = await fetch(`${API_BASE}/group-events`, { headers: authHeaders(session) });
  const body = await parseJsonOrThrow(response);
  return body.groupEvents.map((record: RawGroupEventRecord) => decryptRecord(session, record));
}

export async function submitVotes(
  session: Session,
  groupEventId: string,
  rankings: { slotId: string; rank: number }[]
): Promise<void> {
  const response = await fetch(`${API_BASE}/group-events/${groupEventId}/votes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(session) },
    body: JSON.stringify({ rankings }),
  });
  if (!response.ok && response.status !== 204) {
    await parseJsonOrThrow(response);
  }
}

export async function resolveGroupEvent(
  session: Session,
  groupEventId: string
): Promise<DecryptedGroupEvent> {
  const response = await fetch(`${API_BASE}/group-events/${groupEventId}/resolve`, {
    method: "POST",
    headers: authHeaders(session),
  });
  const body = await parseJsonOrThrow(response);
  return decryptRecord(session, body.groupEvent);
}
