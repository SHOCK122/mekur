import { x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { scryptAsync } from "@noble/hashes/scrypt";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { randomBytes as nobleRandomBytes } from "@noble/hashes/utils";
import type { EncryptedEnvelope } from "@schedule-app/shared";

const NONCE_LENGTH = 24; // bytes, required by xchacha20poly1305
const KEY_LENGTH = 32; // bytes, 256-bit symmetric key

// scrypt cost params shared by every password-derived key in this module.
// N is tuned for interactive login (~131k iterations-equivalent); revisit
// against real low-end device timing per docs/ROADMAP.md.
const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1, dkLen: KEY_LENGTH } as const;

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

/**
 * Derives three independent things from one password: an `authKey`
 * (proves knowledge of the password to the server during login), an
 * `encryptionKey` (encrypts the user's data, and is NEVER sent to the
 * server in any form), and an `identityKeyPair` (X25519, used to wrap
 * per-event keys for group scheduling -- see wrapKey/unwrapKey below).
 * All three come from a single expensive scrypt run (cheap on low-end
 * devices to only pay that cost once), then split via HKDF with
 * different domain-separation labels so none can be derived from another.
 * Deriving the identity keypair from the password (rather than generating
 * it randomly at registration) means the private key never needs separate
 * backup/storage -- it's always re-derivable from the password + salt,
 * the same way encryptionKey is.
 */
export interface AuthAndEncryptionKeys {
  authKey: string; // base64 — sent to the server only at login, over TLS
  encryptionKey: string; // base64 — never leaves the client
  identityKeyPair: KeyPair; // X25519 — publicKey is registered with the server, secretKey never leaves the client
  salt: string; // base64 — must be stored to re-derive the same keys later
}

export async function deriveAuthAndEncryptionKeys(
  password: string,
  salt?: Uint8Array
): Promise<AuthAndEncryptionKeys> {
  const usedSalt = salt ?? randomBytes(16);
  const master = await scryptAsync(password.normalize("NFKC"), usedSalt, SCRYPT_PARAMS);
  const authKey = hkdf(sha256, master, usedSalt, "schedule-app:auth-key:v1", KEY_LENGTH);
  const encryptionKey = hkdf(
    sha256,
    master,
    usedSalt,
    "schedule-app:encryption-key:v1",
    KEY_LENGTH
  );
  const identitySeed = hkdf(sha256, master, usedSalt, "schedule-app:identity-key:v1", KEY_LENGTH);
  // X25519 clamps the scalar internally on every use, so any 32-byte seed
  // is a valid private key input -- no separate "is this a valid key"
  // check is needed here.
  const identityPublicKey = x25519.getPublicKey(identitySeed);
  return {
    authKey: toBase64(authKey),
    encryptionKey: toBase64(encryptionKey),
    identityKeyPair: {
      publicKey: toBase64(identityPublicKey),
      secretKey: toBase64(identitySeed),
    },
    salt: toBase64(usedSalt),
  };
}

/** Hashes a base64 key with SHA-256, for server-side storage of the auth verifier. */
export function sha256Base64(keyBase64: string): string {
  return toBase64(sha256(fromBase64(keyBase64)));
}

/** Generates a fresh random 32-byte symmetric key (e.g. a per-event key to be
 * wrapped and shared with invitees -- see wrapKey/unwrapKey below). */
export function generateSymmetricKey(): string {
  return toBase64(randomBytes(KEY_LENGTH));
}

/**
 * Derives a shared wrapping key between two people from an X25519 ECDH
 * exchange: my private key + their public key. By ECDH's symmetry, the
 * other person computes the identical key from their private key + my
 * public key -- neither side ever transmits it, and the server (which
 * only ever sees public keys) can't derive it either.
 */
export function deriveSharedWrapKey(myPrivateKeyBase64: string, theirPublicKeyBase64: string): string {
  const shared = x25519.getSharedSecret(fromBase64(myPrivateKeyBase64), fromBase64(theirPublicKeyBase64));
  const derived = hkdf(sha256, shared, undefined, "schedule-app:wrap-key:v1", KEY_LENGTH);
  return toBase64(derived);
}

/** Encrypts a symmetric key (e.g. a per-event key) under a shared wrap key,
 * so it can be handed to one specific invitee via the (untrusted) server. */
export function wrapKey(keyToWrapBase64: string, wrapKeyBase64: string): EncryptedEnvelope {
  return encryptEnvelope({ key: keyToWrapBase64 }, wrapKeyBase64, "wrap-key");
}

/** Recovers a symmetric key previously wrapped with wrapKey(). Throws if the
 * wrap key is wrong or the envelope was tampered with (same AEAD guarantee
 * as decryptEnvelope). */
export function unwrapKey(envelope: EncryptedEnvelope, wrapKeyBase64: string): string {
  return decryptEnvelope<{ key: string }>(envelope, wrapKeyBase64).key;
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
  if (nonce.length !== NONCE_LENGTH) {
    throw new Error(`Envelope nonce must be ${NONCE_LENGTH} bytes`);
  }
  const ciphertext = fromBase64(envelope.ciphertext);
  const plaintext = xchacha20poly1305(key, nonce).decrypt(ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
