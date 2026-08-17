import { describe, it, expect } from "vitest";
import {
  EncryptedEnvelopeSchema,
  UserPublicSchema,
  EventRecordSchema,
  EventContentSchema,
  SlotSchema,
  GroupEventContentSchema,
  GroupEventRecordSchema,
  SubmitVotesRequestSchema,
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
    expect(EventContentSchema.parse(content)).toEqual({ ...content, priority: 0 });
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

  it("defaults priority to 0 when not specified", () => {
    const parsed = EventContentSchema.parse({
      title: "Standup",
      startTime: "2026-08-01T09:00:00.000Z",
      endTime: "2026-08-01T09:15:00.000Z",
    });
    expect(parsed.priority).toBe(0);
  });

  it("accepts an explicit integer priority", () => {
    const parsed = EventContentSchema.parse({
      title: "Launch",
      startTime: "2026-08-01T09:00:00.000Z",
      endTime: "2026-08-01T09:15:00.000Z",
      priority: 5,
    });
    expect(parsed.priority).toBe(5);
  });

  it("accepts a negative priority", () => {
    const parsed = EventContentSchema.parse({
      title: "Low-stakes reminder",
      startTime: "2026-08-01T09:00:00.000Z",
      endTime: "2026-08-01T09:15:00.000Z",
      priority: -2,
    });
    expect(parsed.priority).toBe(-2);
  });

  it("rejects a non-integer priority", () => {
    expect(() =>
      EventContentSchema.parse({
        title: "Bad priority",
        startTime: "2026-08-01T09:00:00.000Z",
        endTime: "2026-08-01T09:15:00.000Z",
        priority: 1.5,
      })
    ).toThrow();
  });

  it("rejects a non-numeric priority", () => {
    expect(() =>
      EventContentSchema.parse({
        title: "Bad priority",
        startTime: "2026-08-01T09:00:00.000Z",
        endTime: "2026-08-01T09:15:00.000Z",
        priority: "high",
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

describe("SlotSchema", () => {
  it("accepts a valid slot", () => {
    const slot = { startTime: "2026-08-10T10:00:00.000Z", endTime: "2026-08-10T10:30:00.000Z" };
    expect(SlotSchema.parse(slot)).toEqual(slot);
  });

  it("rejects a slot with endTime before startTime", () => {
    expect(() =>
      SlotSchema.parse({ startTime: "2026-08-10T10:30:00.000Z", endTime: "2026-08-10T10:00:00.000Z" })
    ).toThrow();
  });
});

describe("GroupEventContentSchema", () => {
  it("accepts valid content with candidate slots", () => {
    const content = {
      title: "Team offsite",
      slots: {
        slot_1: { startTime: "2026-08-10T10:00:00.000Z", endTime: "2026-08-10T11:00:00.000Z" },
        slot_2: { startTime: "2026-08-11T10:00:00.000Z", endTime: "2026-08-11T11:00:00.000Z" },
      },
    };
    expect(GroupEventContentSchema.parse(content)).toEqual(content);
  });

  it("rejects content with zero candidate slots", () => {
    expect(() => GroupEventContentSchema.parse({ title: "Empty", slots: {} })).toThrow();
  });
});

describe("GroupEventRecordSchema", () => {
  it("accepts a valid open group event record", () => {
    const record = {
      id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      organizerId: "6c84fb90-12c4-11e1-840d-7b25c5ee775a",
      organizerPublicKey: "cHVibGljS2V5",
      slotIds: ["slot_1", "slot_2"],
      contentEnvelope: {
        v: 1,
        algo: "xchacha20poly1305",
        keyId: "group-event-key",
        nonce: "bm9uY2U=",
        ciphertext: "Y2lwaGVydGV4dA==",
      },
      status: "open",
      resolvedSlotId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      myWrappedKey: {
        v: 1,
        algo: "xchacha20poly1305",
        keyId: "wrap-key",
        nonce: "bm9uY2U=",
        ciphertext: "Y2lwaGVydGV4dA==",
      },
      myVotes: [{ slotId: "slot_1", rank: 1 }],
    };
    expect(GroupEventRecordSchema.parse(record)).toEqual(record);
  });
});

describe("SubmitVotesRequestSchema", () => {
  it("accepts a valid ranking", () => {
    const request = { rankings: [{ slotId: "slot_1", rank: 1 }, { slotId: "slot_2", rank: 2 }] };
    expect(SubmitVotesRequestSchema.parse(request)).toEqual(request);
  });

  it("rejects duplicate slotIds", () => {
    expect(() =>
      SubmitVotesRequestSchema.parse({
        rankings: [{ slotId: "slot_1", rank: 1 }, { slotId: "slot_1", rank: 2 }],
      })
    ).toThrow();
  });

  it("rejects an empty ranking list", () => {
    expect(() => SubmitVotesRequestSchema.parse({ rankings: [] })).toThrow();
  });

  it("rejects a non-positive rank", () => {
    expect(() =>
      SubmitVotesRequestSchema.parse({ rankings: [{ slotId: "slot_1", rank: 0 }] })
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
