import { describe, it, expect } from "vitest";
import {
  generateKeyPair,
  deriveAuthAndEncryptionKeys,
  sha256Base64,
  generateSymmetricKey,
  deriveSharedWrapKey,
  wrapKey,
  unwrapKey,
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

  it("the derived identity keypair actually works for ECDH key wrapping", async () => {
    const alice = await deriveAuthAndEncryptionKeys("alice's password");
    const bob = await deriveAuthAndEncryptionKeys("bob's password");

    const eventKey = generateSymmetricKey();
    const aliceSideKey = deriveSharedWrapKey(alice.identityKeyPair.secretKey, bob.identityKeyPair.publicKey);
    const wrapped = wrapKey(eventKey, aliceSideKey);

    const bobSideKey = deriveSharedWrapKey(bob.identityKeyPair.secretKey, alice.identityKeyPair.publicKey);
    expect(unwrapKey(wrapped, bobSideKey)).toEqual(eventKey);
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

describe("deriveSharedWrapKey / wrapKey / unwrapKey", () => {
  it("two parties derive the identical shared key from each other's keypairs (ECDH symmetry)", () => {
    const organizer = generateKeyPair();
    const invitee = generateKeyPair();

    const organizerSide = deriveSharedWrapKey(organizer.secretKey, invitee.publicKey);
    const inviteeSide = deriveSharedWrapKey(invitee.secretKey, organizer.publicKey);

    expect(organizerSide).toEqual(inviteeSide);
  });

  it("a third party's keypair derives a different shared key", () => {
    const organizer = generateKeyPair();
    const invitee = generateKeyPair();
    const eavesdropper = generateKeyPair();

    const real = deriveSharedWrapKey(organizer.secretKey, invitee.publicKey);
    const wrong = deriveSharedWrapKey(eavesdropper.secretKey, invitee.publicKey);

    expect(real).not.toEqual(wrong);
  });

  it("wraps and unwraps a symmetric key end to end between two parties", () => {
    const organizer = generateKeyPair();
    const invitee = generateKeyPair();
    const eventKey = generateSymmetricKey();

    const wrapKeyForInvitee = deriveSharedWrapKey(organizer.secretKey, invitee.publicKey);
    const wrapped = wrapKey(eventKey, wrapKeyForInvitee);

    const unwrapKeyOnInviteeSide = deriveSharedWrapKey(invitee.secretKey, organizer.publicKey);
    const recovered = unwrapKey(wrapped, unwrapKeyOnInviteeSide);

    expect(recovered).toEqual(eventKey);
  });

  it("fails to unwrap with a key derived from the wrong keypair", () => {
    const organizer = generateKeyPair();
    const invitee = generateKeyPair();
    const eavesdropper = generateKeyPair();
    const eventKey = generateSymmetricKey();

    const wrapped = wrapKey(eventKey, deriveSharedWrapKey(organizer.secretKey, invitee.publicKey));
    const eavesdropperKey = deriveSharedWrapKey(eavesdropper.secretKey, invitee.publicKey);

    expect(() => unwrapKey(wrapped, eavesdropperKey)).toThrow();
  });

  it("lets the wrapped key encrypt/decrypt real event content end to end", () => {
    const organizer = generateKeyPair();
    const invitee = generateKeyPair();
    const eventKey = generateSymmetricKey();

    const content = { slots: { slot_1: "2026-08-10T10:00:00.000Z" }, title: "Team offsite" };
    const contentEnvelope = encryptEnvelope(content, eventKey, "group-event-key");

    const wrapped = wrapKey(eventKey, deriveSharedWrapKey(organizer.secretKey, invitee.publicKey));
    const recoveredEventKey = unwrapKey(wrapped, deriveSharedWrapKey(invitee.secretKey, organizer.publicKey));
    const decryptedContent = decryptEnvelope(contentEnvelope, recoveredEventKey);

    expect(decryptedContent).toEqual(content);
  });
});

describe("encryptEnvelope / decryptEnvelope", () => {
  it("round-trips arbitrary JSON payloads", () => {
    const key = generateSymmetricKey();
    const payload = { title: "Team sync", startTime: "2026-08-01T10:00:00.000Z" };
    const envelope = encryptEnvelope(payload, key, "user-key-1");
    const decrypted = decryptEnvelope(envelope, key);
    expect(decrypted).toEqual(payload);
  });

  it("fails to decrypt with the wrong key", () => {
    const keyA = generateSymmetricKey();
    const keyB = generateSymmetricKey();
    const envelope = encryptEnvelope({ secret: true }, keyA, "user-key-1");
    expect(() => decryptEnvelope(envelope, keyB)).toThrow();
  });

  it("fails to decrypt if ciphertext is tampered with", () => {
    const key = generateSymmetricKey();
    const envelope = encryptEnvelope({ secret: true }, key, "user-key-1");
    const tampered = { ...envelope, ciphertext: toBase64(randomBytes(fromBase64(envelope.ciphertext).length)) };
    expect(() => decryptEnvelope(tampered, key)).toThrow();
  });

  it("never leaks plaintext into the envelope's serialized form", () => {
    const key = generateSymmetricKey();
    const secretMarker = "MY_SECRET_MARKER_VALUE";
    const envelope = encryptEnvelope({ note: secretMarker }, key, "user-key-1");
    expect(JSON.stringify(envelope)).not.toContain(secretMarker);
  });

  it("rejects an envelope whose nonce is the wrong length", () => {
    const key = generateSymmetricKey();
    const envelope = encryptEnvelope({ secret: true }, key, "user-key-1");
    const tampered = { ...envelope, nonce: toBase64(randomBytes(12)) };
    expect(() => decryptEnvelope(tampered, key)).toThrow(/nonce must be/);
  });
});
