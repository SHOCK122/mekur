import { deriveAuthAndEncryptionKeys } from "@schedule-app/crypto";
import type { Session } from "./session.js";
import { parseJsonOrThrow } from "./http.js";

const API_BASE = "/api";

export async function register(
  username: string,
  displayName: string,
  password: string
): Promise<Session> {
  const keys = await deriveAuthAndEncryptionKeys(password);
  const response = await fetch(`${API_BASE}/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      displayName,
      publicKey: keys.identityKeyPair.publicKey,
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
    identityPublicKey: keys.identityKeyPair.publicKey,
    identitySecretKey: keys.identityKeyPair.secretKey,
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
  const session: Session = {
    userId: body.user.id,
    username: body.user.username,
    token: body.token,
    encryptionKey: keys.encryptionKey,
    identityPublicKey: keys.identityKeyPair.publicKey,
    identitySecretKey: keys.identityKeyPair.secretKey,
  };

  // Self-heal a stale public key. Accounts created before the
  // identity-keypair fix registered a RANDOM public key whose private half
  // was discarded, so anything wrapped to it could never be opened -- which
  // surfaced as a cryptic "invalid tag" error the moment you tagged anyone
  // into a group event. If the server's copy disagrees with what this
  // password actually derives, the derived one is authoritative: it's the
  // only one we hold the private half for.
  if (body.user.publicKey && body.user.publicKey !== keys.identityKeyPair.publicKey) {
    await repairPublicKey(session);
  }

  return session;
}

/** Best-effort repair; a failure here must not block an otherwise valid
 * login, since the person can still read anything encrypted to their
 * personal key (only sharing depends on the identity keypair). */
async function repairPublicKey(session: Session): Promise<void> {
  try {
    await fetch(`${API_BASE}/users/me/public-key`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ publicKey: session.identityPublicKey }),
    });
  } catch {
    // Ignored deliberately -- see above.
  }
}
