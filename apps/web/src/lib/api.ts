import {
  deriveAuthAndEncryptionKeys,
  generateKeyPair,
  encryptEnvelope,
  decryptEnvelope,
} from "@schedule-app/crypto";
import type { EventContent } from "@schedule-app/shared";
import type { Session } from "./session.js";

const API_BASE = "/api";

async function parseJsonOrThrow(response: Response): Promise<any> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error ?? `Request failed with status ${response.status}`);
  }
  return body;
}

export async function register(
  username: string,
  displayName: string,
  password: string
): Promise<Session> {
  const keys = await deriveAuthAndEncryptionKeys(password);
  const { publicKey } = generateKeyPair();
  const response = await fetch(`${API_BASE}/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      displayName,
      publicKey,
      authKey: keys.authKey,
      authSalt: keys.salt,
    }),
  });
  const body = await parseJsonOrThrow(response);
  return {
    userId: body.user.id,
    username: body.user.username,
    token: body.token,
    encryptionKey: keys.encryptionKey,
  };
}

export async function login(username: string, password: string): Promise<Session> {
  const saltResponse = await fetch(`${API_BASE}/users/${encodeURIComponent(username)}/salt`);
  const saltBody = await parseJsonOrThrow(saltResponse);
  const salt = Uint8Array.from(atob(saltBody.authSalt), (c) => c.charCodeAt(0));

  const keys = await deriveAuthAndEncryptionKeys(password, salt);
  const response = await fetch(`${API_BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, authKey: keys.authKey }),
  });
  const body = await parseJsonOrThrow(response);
  return {
    userId: body.user.id,
    username: body.user.username,
    token: body.token,
    encryptionKey: keys.encryptionKey,
  };
}

export interface DecryptedEvent extends EventContent {
  id: string;
}

export async function listEvents(session: Session): Promise<DecryptedEvent[]> {
  const response = await fetch(`${API_BASE}/events`, {
    headers: { authorization: `Bearer ${session.token}` },
  });
  const body = await parseJsonOrThrow(response);
  return body.events.map((record: { id: string; envelope: Parameters<typeof decryptEnvelope>[0] }) => ({
    id: record.id,
    ...decryptEnvelope<EventContent>(record.envelope, session.encryptionKey),
  }));
}

export async function createEvent(
  session: Session,
  content: EventContent
): Promise<DecryptedEvent> {
  const envelope = encryptEnvelope(content, session.encryptionKey, "user-key-1");
  const response = await fetch(`${API_BASE}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ envelope }),
  });
  const body = await parseJsonOrThrow(response);
  return { id: body.event.id, ...content };
}

export async function updateEvent(
  session: Session,
  id: string,
  content: EventContent
): Promise<DecryptedEvent> {
  const envelope = encryptEnvelope(content, session.encryptionKey, "user-key-1");
  const response = await fetch(`${API_BASE}/events/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ envelope }),
  });
  const body = await parseJsonOrThrow(response);
  return { id: body.event.id, ...content };
}

export async function deleteEvent(session: Session, id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/events/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${session.token}` },
  });
  if (!response.ok && response.status !== 204) {
    await parseJsonOrThrow(response);
  }
}
