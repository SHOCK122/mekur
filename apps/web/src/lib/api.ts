import { deriveAuthAndEncryptionKeys, fromBase64, type AuthAndEncryptionKeys } from "@schedule-app/crypto";
import type { Session } from "./session.js";
import { apiFetch } from "./http.js";

function toSession(user: { id: string; username: string }, token: string, keys: AuthAndEncryptionKeys): Session {
  return {
    userId: user.id,
    username: user.username,
    token,
    encryptionKey: keys.encryptionKey,
    identityPublicKey: keys.identityKeyPair.publicKey,
    identitySecretKey: keys.identityKeyPair.secretKey,
  };
}

export async function register(username: string, displayName: string, password: string): Promise<Session> {
  const keys = await deriveAuthAndEncryptionKeys(password);
  const body = await apiFetch(null, "/users", {
    method: "POST",
    body: {
      username,
      displayName,
      publicKey: keys.identityKeyPair.publicKey,
      authKey: keys.authKey,
      authSalt: keys.salt,
    },
  });
  return toSession(body.user, body.token, keys);
}

export async function login(username: string, password: string): Promise<Session> {
  const { authSalt } = await apiFetch(null, `/users/${encodeURIComponent(username)}/salt`);
  const keys = await deriveAuthAndEncryptionKeys(password, fromBase64(authSalt));
  // Sending the derived public key lets the server repair a stale one from
  // before identity keys were derived from the password. It only does so
  // here, where the password has just been proven.
  const body = await apiFetch(null, "/sessions", {
    method: "POST",
    body: { username, authKey: keys.authKey, publicKey: keys.identityKeyPair.publicKey },
  });
  return toSession(body.user, body.token, keys);
}
