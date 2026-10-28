import { describe, it, expect } from "vitest";
import {
  generateKeyPair,
  deriveAuthAndEncryptionKeys,
  sha256Base64,
  generateSymmetricKey,
  sealToRecipient,
  openSealed,
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

  it("derives a deterministic identity keypair usable for ECDH", async () => {
    const salt = randomBytes(16);
    const a = await deriveAuthAndEncryptionKeys("correct horse battery staple", salt);
    const b = await deriveAuthAndEncryptionKeys("correct horse battery staple", salt);
    expect(a.identityKeyPair.publicKey).toEqual(b.identityKeyPair.publicKey);
    expect(a.identityKeyPair.secretKey).toEqual(b.identityKeyPair.secretKey);
    expect(fromBase64(a.identityKeyPair.publicKey)).toHaveLength(32);
  });

  it("the derived identity keypair can receive sealed envelopes", async () => {
    const alice = await deriveAuthAndEncryptionKeys("alice's password");
    const bob = await deriveAuthAndEncryptionKeys("bob's password");

    const sealed = sealToRecipient({ hello: "bob" }, bob.identityKeyPair.publicKey, alice.identityKeyPair);
    const opened = openSealed(sealed, bob.identityKeyPair.secretKey);
    expect(opened.payload).toEqual({ hello: "bob" });
    expect(opened.senderPublicKey).toBe(alice.identityKeyPair.publicKey);
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

describe("generateSymmetricKey", () => {
  it("produces a 32-byte key", () => {
    expect(fromBase64(generateSymmetricKey())).toHaveLength(32);
  });

  it("produces a different key each call", () => {
    expect(generateSymmetricKey()).not.toEqual(generateSymmetricKey());
  });
});

describe("sealToRecipient / openSealed", () => {
  it("lets the recipient open an anonymous envelope with only their own secret key", () => {
    const recipient = generateKeyPair();
    const sealed = sealToRecipient({ eventId: "e1" }, recipient.publicKey);
    const opened = openSealed(sealed, recipient.secretKey);
    expect(opened.payload).toEqual({ eventId: "e1" });
    expect(opened.senderPublicKey).toBeNull();
  });

  it("uses a fresh ephemeral key per message, so two envelopes can't be linked", () => {
    const recipient = generateKeyPair();
    const sender = generateKeyPair();
    const a = sealToRecipient({ n: 1 }, recipient.publicKey, sender);
    const b = sealToRecipient({ n: 1 }, recipient.publicKey, sender);
    expect(a.epk).not.toEqual(b.epk);
    // The sender's identity must not appear anywhere outside the ciphertext.
    expect(JSON.stringify(a)).not.toContain(sender.publicKey);
  });

  it("cannot be opened by anyone else", () => {
    const recipient = generateKeyPair();
    const eavesdropper = generateKeyPair();
    const sealed = sealToRecipient({ secret: true }, recipient.publicKey);
    expect(() => openSealed(sealed, eavesdropper.secretKey)).toThrow();
  });

  it("verifies a named sender", () => {
    const recipient = generateKeyPair();
    const sender = generateKeyPair();
    const opened = openSealed(sealToRecipient("hi", recipient.publicKey, sender), recipient.secretKey);
    expect(opened.senderPublicKey).toBe(sender.publicKey);
  });

  it("rejects a sender identity claimed without the matching private key", () => {
    const recipient = generateKeyPair();
    const victim = generateKeyPair();
    const forger = generateKeyPair();
    // The forger signs with their own secret but claims the victim's key.
    const sealed = sealToRecipient("trust me", recipient.publicKey, {
      publicKey: victim.publicKey,
      secretKey: forger.secretKey,
    });
    expect(() => openSealed(sealed, recipient.secretKey)).toThrow(/Sender proof/);
  });

  it("rejects a tampered envelope", () => {
    const recipient = generateKeyPair();
    const sealed = sealToRecipient("x", recipient.publicKey);
    const bytes = fromBase64(sealed.ciphertext);
    bytes[0] = bytes[0]! ^ 1;
    expect(() => openSealed({ ...sealed, ciphertext: toBase64(bytes) }, recipient.secretKey)).toThrow();
  });
});

describe("encryptEnvelope / decryptEnvelope", () => {
  it("round-trips arbitrary JSON payloads", async () => {
    const derived = { key: generateSymmetricKey() };
    const payload = { title: "Team sync", startTime: "2026-08-01T10:00:00.000Z" };
    const envelope = encryptEnvelope(payload, derived.key, "user-key-1");
    const decrypted = decryptEnvelope(envelope, derived.key);
    expect(decrypted).toEqual(payload);
  });

  it("fails to decrypt with the wrong key", async () => {
    const derivedA = { key: generateSymmetricKey() };
    const derivedB = { key: generateSymmetricKey() };
    const envelope = encryptEnvelope({ secret: true }, derivedA.key, "user-key-1");
    expect(() => decryptEnvelope(envelope, derivedB.key)).toThrow();
  });

  it("fails to decrypt if ciphertext is tampered with", async () => {
    const derived = { key: generateSymmetricKey() };
    const envelope = encryptEnvelope({ secret: true }, derived.key, "user-key-1");
    const tampered = { ...envelope, ciphertext: toBase64(randomBytes(fromBase64(envelope.ciphertext).length)) };
    expect(() => decryptEnvelope(tampered, derived.key)).toThrow();
  });

  it("never leaks plaintext into the envelope's serialized form", async () => {
    const derived = { key: generateSymmetricKey() };
    const secretMarker = "MY_SECRET_MARKER_VALUE";
    const envelope = encryptEnvelope({ note: secretMarker }, derived.key, "user-key-1");
    expect(JSON.stringify(envelope)).not.toContain(secretMarker);
  });
}, 20_000);
