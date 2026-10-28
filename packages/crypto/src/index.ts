import { x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { scryptAsync } from "@noble/hashes/scrypt";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { hmac } from "@noble/hashes/hmac";
import { randomBytes as nobleRandomBytes } from "@noble/hashes/utils";
import type { EncryptedEnvelope, SealedEnvelope } from "@schedule-app/shared";

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

/** Generates a random X25519 key pair. Used for the ephemeral half of a
 * sealed envelope (see sealToRecipient). */
export function generateKeyPair(): KeyPair {
  const secretKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(secretKey);
  return { publicKey: toBase64(publicKey), secretKey: toBase64(secretKey) };
}

/**
 * Derives three independent things from one password: an `authKey`
 * (proves knowledge of the password to the server during login), an
 * `encryptionKey` (encrypts the user's keyring, and is NEVER sent to the
 * server in any form), and an `identityKeyPair` (X25519, the address
 * others seal invitations to -- see sealToRecipient below).
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

/** Generates a fresh random 32-byte symmetric key, e.g. a per-event key. */
export function generateSymmetricKey(): string {
  return toBase64(randomBytes(KEY_LENGTH));
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

// ---------------------------------------------------------------------------
// Sealed envelopes (inbox delivery)
// ---------------------------------------------------------------------------

function sealKey(sharedSecret: Uint8Array, epk: Uint8Array, recipientPublicKey: Uint8Array): string {
  // Binding both public keys into the salt ties the derived key to this
  // exact pair, the same construction libsodium's sealed boxes use.
  const salt = new Uint8Array(epk.length + recipientPublicKey.length);
  salt.set(epk);
  salt.set(recipientPublicKey, epk.length);
  return toBase64(hkdf(sha256, sharedSecret, salt, "schedule-app:seal:v1", KEY_LENGTH));
}

function senderProof(
  staticSharedSecret: Uint8Array,
  epk: Uint8Array,
  body: string
): string {
  const key = hkdf(sha256, staticSharedSecret, undefined, "schedule-app:sender-proof:v1", KEY_LENGTH);
  const message = new Uint8Array([...epk, ...new TextEncoder().encode(body)]);
  return toBase64(hmac(sha256, key, message));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface SealedInner {
  body: string;
  sender?: { publicKey: string; proof: string };
}

/**
 * Encrypts a payload so only the holder of `recipientPublicKey`'s private
 * half can read it, without the envelope revealing who sent it.
 *
 * A fresh ephemeral keypair is generated per message; its public half
 * travels in the clear as `epk` and is linked to no account. That is what
 * lets the inbox work with no sender column: the recipient can always open
 * the message using only their own secret key.
 *
 * Optionally, `sender` adds an authenticated identity *inside* the
 * ciphertext: the sender's static public key plus an HMAC keyed by
 * ECDH(sender, recipient) over the ephemeral key and body. Only the real
 * sender (or the recipient) can compute it, so the recipient learns a
 * verifiable sender while the server learns nothing. Omit it for anonymous
 * invitations.
 */
export function sealToRecipient(
  payload: unknown,
  recipientPublicKeyBase64: string,
  sender?: KeyPair
): SealedEnvelope {
  const recipientPublicKey = fromBase64(recipientPublicKeyBase64);
  const ephemeral = x25519.utils.randomPrivateKey();
  const epk = x25519.getPublicKey(ephemeral);
  const key = sealKey(x25519.getSharedSecret(ephemeral, recipientPublicKey), epk, recipientPublicKey);

  const body = JSON.stringify(payload);
  const inner: SealedInner = { body };
  if (sender) {
    const staticShared = x25519.getSharedSecret(fromBase64(sender.secretKey), recipientPublicKey);
    inner.sender = { publicKey: sender.publicKey, proof: senderProof(staticShared, epk, body) };
  }
  return { ...encryptEnvelope(inner, key, "sealed"), epk: toBase64(epk) };
}

export interface OpenedEnvelope<T> {
  payload: T;
  /** The sender's verified static public key, or null if the sender chose
   * to stay anonymous. Never a value the sender merely claimed. */
  senderPublicKey: string | null;
}

/**
 * Opens an envelope produced by sealToRecipient. Throws if it wasn't sealed
 * to this key, was tampered with, or carries a sender proof that doesn't
 * verify -- a forged sender identity is an error, never silently dropped.
 */
export function openSealed<T = unknown>(
  sealed: SealedEnvelope,
  recipientSecretKeyBase64: string
): OpenedEnvelope<T> {
  const recipientSecretKey = fromBase64(recipientSecretKeyBase64);
  const recipientPublicKey = x25519.getPublicKey(recipientSecretKey);
  const epk = fromBase64(sealed.epk);
  const key = sealKey(x25519.getSharedSecret(recipientSecretKey, epk), epk, recipientPublicKey);
  const inner = decryptEnvelope<SealedInner>(sealed, key);

  let senderPublicKey: string | null = null;
  if (inner.sender) {
    const staticShared = x25519.getSharedSecret(recipientSecretKey, fromBase64(inner.sender.publicKey));
    const expected = senderProof(staticShared, epk, inner.body);
    if (!constantTimeEqual(expected, inner.sender.proof)) {
      throw new Error("Sender proof does not verify");
    }
    senderPublicKey = inner.sender.publicKey;
  }
  return { payload: JSON.parse(inner.body) as T, senderPublicKey };
}
