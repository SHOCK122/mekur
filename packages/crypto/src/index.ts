import { x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { scryptAsync } from "@noble/hashes/scrypt";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { randomBytes as nobleRandomBytes } from "@noble/hashes/utils";
import type { EncryptedEnvelope } from "@schedule-app/shared";

const NONCE_LENGTH = 24; // bytes, required by xchacha20poly1305
const KEY_LENGTH = 32; // bytes, 256-bit symmetric key

/** Cross-environment base64 encode (works in Node and browsers). */
export function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  // eslint-disable-next-line no-undef
  return btoa(binary);
}

/** Cross-environment base64 decode (works in Node and browsers). */
export function fromBase64(str: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(str, "base64"));
  }
  // eslint-disable-next-line no-undef
  const binary = atob(str);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function randomBytes(length: number): Uint8Array {
  return nobleRandomBytes(length);
}

export interface KeyPair {
  publicKey: string; // base64
  secretKey: string; // base64 — NEVER sent to the server
}

/** Generates an X25519 key pair, used for wrapping per-event keys to invitees. */
export function generateKeyPair(): KeyPair {
  const secretKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(secretKey);
  return { publicKey: toBase64(publicKey), secretKey: toBase64(secretKey) };
}

export interface DerivedKey {
  key: string; // base64, 32-byte symmetric key
  salt: string; // base64, must be stored to re-derive the same key later
}

/**
 * Derives a symmetric master key from a user's password using scrypt.
 * This happens entirely client-side; the password and derived key are
 * never transmitted to the server.
 */
export async function deriveKeyFromPassword(
  password: string,
  salt?: Uint8Array
): Promise<DerivedKey> {
  const usedSalt = salt ?? randomBytes(16);
  const key = await scryptAsync(password.normalize("NFKC"), usedSalt, {
    N: 2 ** 17, // ~131k iterations-equivalent cost factor; tuned for interactive login
    r: 8,
    p: 1,
    dkLen: KEY_LENGTH,
  });
  return { key: toBase64(key), salt: toBase64(usedSalt) };
}

/**
 * Derives two independent keys from one password: an `authKey` (proves
 * knowledge of the password to the server during login) and an
 * `encryptionKey` (encrypts the user's data, and is NEVER sent to the
 * server in any form). Both come from a single expensive scrypt run
 * (cheap on low-end devices to only pay that cost once), then split via
 * HKDF with different domain-separation labels so neither key can be
 * derived from the other.
 */
export interface AuthAndEncryptionKeys {
  authKey: string; // base64 — sent to the server only at login, over TLS
  encryptionKey: string; // base64 — never leaves the client
  salt: string; // base64 — must be stored to re-derive the same keys later
}

export async function deriveAuthAndEncryptionKeys(
  password: string,
  salt?: Uint8Array
): Promise<AuthAndEncryptionKeys> {
  const usedSalt = salt ?? randomBytes(16);
  const master = await scryptAsync(password.normalize("NFKC"), usedSalt, {
    N: 2 ** 17,
    r: 8,
    p: 1,
    dkLen: 32,
  });
  const authKey = hkdf(sha256, master, usedSalt, "schedule-app:auth-key:v1", KEY_LENGTH);
  const encryptionKey = hkdf(
    sha256,
    master,
    usedSalt,
    "schedule-app:encryption-key:v1",
    KEY_LENGTH
  );
  return {
    authKey: toBase64(authKey),
    encryptionKey: toBase64(encryptionKey),
    salt: toBase64(usedSalt),
  };
}

/** Hashes a base64 key with SHA-256, for server-side storage of the auth verifier. */
export function sha256Base64(keyBase64: string): string {
  return toBase64(sha256(fromBase64(keyBase64)));
}

/**
 * Encrypts an arbitrary JSON-serializable payload into an EncryptedEnvelope.
 * `keyId` is opaque metadata identifying which key was used (so the client
 * knows which key to use on decrypt); it carries no key material itself.
 */
export function encryptEnvelope(
  payload: unknown,
  keyBase64: string,
  keyId: string
): EncryptedEnvelope {
  const key = fromBase64(keyBase64);
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Encryption key must be ${KEY_LENGTH} bytes`);
  }
  const nonce = randomBytes(NONCE_LENGTH);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(plaintext);
  return {
    v: 1,
    algo: "xchacha20poly1305",
    keyId,
    nonce: toBase64(nonce),
    ciphertext: toBase64(ciphertext),
  };
}

/**
 * Decrypts an EncryptedEnvelope produced by encryptEnvelope, returning the
 * original JSON payload. Throws if the key is wrong or the data was tampered
 * with (Poly1305 authentication tag mismatch).
 */
export function decryptEnvelope<T = unknown>(
  envelope: EncryptedEnvelope,
  keyBase64: string
): T {
  const key = fromBase64(keyBase64);
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Decryption key must be ${KEY_LENGTH} bytes`);
  }
  const nonce = fromBase64(envelope.nonce);
  const ciphertext = fromBase64(envelope.ciphertext);
  const plaintext = xchacha20poly1305(key, nonce).decrypt(ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
