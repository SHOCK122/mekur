import { describe, it, expect } from "vitest";
import {
  generateKeyPair,
  deriveKeyFromPassword,
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
