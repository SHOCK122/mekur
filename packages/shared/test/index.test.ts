import { describe, it, expect } from "vitest";
import {
  EncryptedEnvelopeSchema,
  EventContentSchema,
  SealedEnvelopeSchema,
  KeyringEnvelopeSchema,
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

  it("rejects an end time before the start time", () => {
    expect(() =>
      EventContentSchema.parse({
        title: "Backwards event",
        startTime: "2026-08-01T10:00:00.000Z",
        endTime: "2026-08-01T09:00:00.000Z",
      })
    ).toThrow(/endTime must be after startTime/);
  });

  it("rejects an end time equal to the start time", () => {
    expect(() =>
      EventContentSchema.parse({
        title: "Zero-length event",
        startTime: "2026-08-01T10:00:00.000Z",
        endTime: "2026-08-01T10:00:00.000Z",
      })
    ).toThrow();
  });

  it("accepts a recurrence rule for an arbitrary interval (every 37 minutes)", () => {
    const parsed = EventContentSchema.parse({
      title: "Custom interval reminder",
      startTime: "2026-08-01T09:00:00.000Z",
      endTime: "2026-08-01T09:05:00.000Z",
      recurrence: { freq: "MINUTELY", interval: 37 },
    });
    expect(parsed.recurrence).toEqual({ freq: "MINUTELY", interval: 37 });
  });

  it("accepts a recurrence rule for every weekday", () => {
    const parsed = EventContentSchema.parse({
      title: "Daily standup",
      startTime: "2026-08-03T09:00:00.000Z",
      endTime: "2026-08-03T09:15:00.000Z",
      recurrence: { freq: "WEEKLY", interval: 1, byDay: ["MO", "TU", "WE", "TH", "FR"] },
    });
    expect(parsed.recurrence?.byDay).toEqual(["MO", "TU", "WE", "TH", "FR"]);
  });

  it("rejects a recurrence with a non-positive interval", () => {
    expect(() =>
      EventContentSchema.parse({
        title: "Bad recurrence",
        startTime: "2026-08-01T09:00:00.000Z",
        endTime: "2026-08-01T09:15:00.000Z",
        recurrence: { freq: "DAILY", interval: 0 },
      })
    ).toThrow();
  });
});

describe("optional end time", () => {
  it("accepts an event with no end time", () => {
    const parsed = EventContentSchema.parse({
      title: "Open ended",
      startTime: "2026-08-01T09:00:00.000Z",
    });
    expect(parsed.endTime).toBeUndefined();
  });

  it("still rejects an end before the start when one is given", () => {
    expect(() =>
      EventContentSchema.parse({
        title: "Backwards",
        startTime: "2026-08-01T10:00:00.000Z",
        endTime: "2026-08-01T09:00:00.000Z",
      })
    ).toThrow(/endTime must be after startTime/);
  });

  it("accepts a fractional rank and an important flag", () => {
    const parsed = EventContentSchema.parse({
      title: "Ranked",
      startTime: "2026-08-01T09:00:00.000Z",
      rank: "V",
      important: true,
    });
    expect(parsed.rank).toBe("V");
    expect(parsed.important).toBe(true);
  });
});

describe("SealedEnvelopeSchema", () => {
  const envelope = {
    v: 1,
    algo: "xchacha20poly1305",
    keyId: "sealed",
    nonce: "bm9uY2U=",
    ciphertext: "Y2lwaGVydGV4dA==",
  };

  it("requires the ephemeral public key", () => {
    expect(() => SealedEnvelopeSchema.parse(envelope)).toThrow();
    expect(SealedEnvelopeSchema.parse({ ...envelope, epk: "ZXBr" }).epk).toBe("ZXBr");
  });
});

describe("KeyringEnvelopeSchema", () => {
  it("allows a keyring larger than a single event's cap", () => {
    const big = "A".repeat(200 * 1024);
    const envelope = { v: 1, algo: "xchacha20poly1305", keyId: "keyring", nonce: "bm9uY2U=", ciphertext: big };
    expect(() => EncryptedEnvelopeSchema.parse(envelope)).toThrow();
    expect(KeyringEnvelopeSchema.parse(envelope).ciphertext).toHaveLength(big.length);
  });
});
