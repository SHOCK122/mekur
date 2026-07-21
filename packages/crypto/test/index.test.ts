import { describe, it, expect } from "vitest";
import {
  generateKeyPair,
  deriveKeyFromPassword,
  deriveAuthAndEncryptionKeys,
  sha256Base64,
  encryptEnvelope,
  decryptEnvelope,
  toBase64,
  fromBase64,
  randomBytes,
} from "../src/index.js";

describe("base64 round-trip", () => {
  it("encodes and decodes bytes losslessly", () => {
    const bytes = randomBytes(32);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});

describe("generateKeyPair", () => {
  it("produces distinct public/secret keys of expected length", () => {
    const pair = generateKeyPair();
    expect(fromBase64(pair.publicKey)).toHaveLength(32);
    expect(fromBase64(pair.secretKey)).toHaveLength(32);
    expect(pair.publicKey).not.toEqual(pair.secretKey);
  });

  it("produces a different key pair on every call", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    expect(a.secretKey).not.toEqual(b.secretKey);
  });
});

describe("deriveKeyFromPassword", () => {
  it("derives the same key for the same password and salt", async () => {
    const salt = randomBytes(16);
    const a = await deriveKeyFromPassword("correct horse battery staple", salt);
    const b = await deriveKeyFromPassword("correct horse battery staple", salt);
    expect(a.key).toEqual(b.key);
  });

  it("derives a different key for a different password", async () => {
    const salt = randomBytes(16);
    const a = await deriveKeyFromPassword("password one", salt);
    const b = await deriveKeyFromPassword("password two", salt);
    expect(a.key).not.toEqual(b.key);
  });

  it("produces a 32-byte key", async () => {
    const derived = await deriveKeyFromPassword("some password");
    expect(fromBase64(derived.key)).toHaveLength(32);
  });
}, 20_000);

describe("deriveAuthAndEncryptionKeys", () => {
  it("derives distinct authKey and encryptionKey from the same password", async () => {
    const keys = await deriveAuthAndEncryptionKeys("correct horse battery staple");
    expect(keys.authKey).not.toEqual(keys.encryptionKey);
    expect(fromBase64(keys.authKey)).toHaveLength(32);
    expect(fromBase64(keys.encryptionKey)).toHaveLength(32);
  });

  it("is deterministic given the same password and salt", async () => {
    const salt = randomBytes(16);
    const a = await deriveAuthAndEncryptionKeys("hunter2", salt);
    const b = await deriveAuthAndEncryptionKeys("hunter2", salt);
    expect(a.authKey).toEqual(b.authKey);
    expect(a.encryptionKey).toEqual(b.encryptionKey);
  });

  it("produces different keys for different passwords", async () => {
    const salt = randomBytes(16);
    const a = await deriveAuthAndEncryptionKeys("password one", salt);
    const b = await deriveAuthAndEncryptionKeys("password two", salt);
    expect(a.authKey).not.toEqual(b.authKey);
    expect(a.encryptionKey).not.toEqual(b.encryptionKey);
  });
}, 20_000);

describe("sha256Base64", () => {
  it("is deterministic", () => {
    const input = toBase64(randomBytes(32));
    expect(sha256Base64(input)).toEqual(sha256Base64(input));
  });

  it("produces different output for different input", () => {
    const a = toBase64(randomBytes(32));
    const b = toBase64(randomBytes(32));
    expect(sha256Base64(a)).not.toEqual(sha256Base64(b));
  });
});

describe("encryptEnvelope / decryptEnvelope", () => {
  it("round-trips arbitrary JSON payloads", async () => {
    const derived = await deriveKeyFromPassword("test password");
    const payload = { title: "Team sync", startTime: "2026-08-01T10:00:00.000Z" };
    const envelope = encryptEnvelope(payload, derived.key, "user-key-1");
    const decrypted = decryptEnvelope(envelope, derived.key);
    expect(decrypted).toEqual(payload);
  });

  it("fails to decrypt with the wrong key", async () => {
    const derivedA = await deriveKeyFromPassword("password A");
    const derivedB = await deriveKeyFromPassword("password B");
    const envelope = encryptEnvelope({ secret: true }, derivedA.key, "user-key-1");
    expect(() => decryptEnvelope(envelope, derivedB.key)).toThrow();
  });

  it("fails to decrypt if ciphertext is tampered with", async () => {
    const derived = await deriveKeyFromPassword("test password");
    const envelope = encryptEnvelope({ secret: true }, derived.key, "user-key-1");
    const tampered = { ...envelope, ciphertext: toBase64(randomBytes(fromBase64(envelope.ciphertext).length)) };
    expect(() => decryptEnvelope(tampered, derived.key)).toThrow();
  });

  it("never leaks plaintext into the envelope's serialized form", async () => {
    const derived = await deriveKeyFromPassword("test password");
    const secretMarker = "MY_SECRET_MARKER_VALUE";
    const envelope = encryptEnvelope({ note: secretMarker }, derived.key, "user-key-1");
    expect(JSON.stringify(envelope)).not.toContain(secretMarker);
  });
}, 20_000);
