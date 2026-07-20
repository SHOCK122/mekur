import { describe, it, expect } from "vitest";
import {
  EncryptedEnvelopeSchema,
  UserPublicSchema,
  EventRecordSchema,
  EventContentSchema,
} from "../src/index.js";

describe("EncryptedEnvelopeSchema", () => {
  it("accepts a well-formed envelope", () => {
    const envelope = {
      v: 1,
      algo: "xchacha20poly1305",
      keyId: "user-key-1",
      nonce: "bm9uY2U=",
      ciphertext: "Y2lwaGVydGV4dA==",
    };
    expect(EncryptedEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it("rejects an envelope missing ciphertext", () => {
    const bad = {
      v: 1,
      algo: "xchacha20poly1305",
      keyId: "user-key-1",
      nonce: "bm9uY2U=",
    };
    expect(() => EncryptedEnvelopeSchema.parse(bad)).toThrow();
  });

  it("rejects an unknown algo", () => {
    const bad = {
      v: 1,
      algo: "aes-cbc",
      keyId: "user-key-1",
      nonce: "bm9uY2U=",
      ciphertext: "Y2lwaGVydGV4dA==",
    };
    expect(() => EncryptedEnvelopeSchema.parse(bad)).toThrow();
  });
});

describe("UserPublicSchema", () => {
  it("accepts a valid public user record", () => {
    const user = {
      id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      displayName: "Ada Lovelace",
      publicKey: "cHVibGljS2V5",
      createdAt: new Date().toISOString(),
    };
    expect(UserPublicSchema.parse(user)).toEqual(user);
  });

  it("rejects an invalid uuid", () => {
    expect(() =>
      UserPublicSchema.parse({
        id: "not-a-uuid",
        displayName: "Ada",
        publicKey: "cHVibGljS2V5",
        createdAt: new Date().toISOString(),
      })
    ).toThrow();
  });
});

describe("EventRecordSchema", () => {
  it("accepts a valid opaque event record", () => {
    const record = {
      id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      ownerId: "6c84fb90-12c4-11e1-840d-7b25c5ee775a",
      envelope: {
        v: 1,
        algo: "xchacha20poly1305",
        keyId: "user-key-1",
        nonce: "bm9uY2U=",
        ciphertext: "Y2lwaGVydGV4dA==",
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(EventRecordSchema.parse(record)).toEqual(record);
  });
});

describe("EventContentSchema", () => {
  it("accepts valid plaintext event content", () => {
    const content = {
      title: "Team sync",
      startTime: new Date().toISOString(),
      endTime: new Date(Date.now() + 3600_000).toISOString(),
    };
    expect(EventContentSchema.parse(content)).toEqual(content);
  });

  it("rejects an empty title", () => {
    expect(() =>
      EventContentSchema.parse({
        title: "",
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
      })
    ).toThrow();
  });
});
