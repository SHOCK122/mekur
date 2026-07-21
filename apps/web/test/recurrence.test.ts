import { describe, it, expect } from "vitest";
import { expandOccurrences, describeRecurrence } from "../src/lib/recurrence.js";

describe("expandOccurrences", () => {
  it("returns a single occurrence for a non-recurring event within range", () => {
    const event = { startTime: "2026-08-01T09:00:00.000Z", endTime: "2026-08-01T09:30:00.000Z" };
    const occurrences = expandOccurrences(
      event,
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-02T00:00:00.000Z")
    );
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].start.toISOString()).toBe("2026-08-01T09:00:00.000Z");
    expect(occurrences[0].end.toISOString()).toBe("2026-08-01T09:30:00.000Z");
  });

  it("returns nothing for a non-recurring event outside the range", () => {
    const event = { startTime: "2026-01-01T09:00:00.000Z", endTime: "2026-01-01T09:30:00.000Z" };
    const occurrences = expandOccurrences(
      event,
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-02T00:00:00.000Z")
    );
    expect(occurrences).toHaveLength(0);
  });

  it("expands an arbitrary custom interval (every 37 minutes)", () => {
    const event = {
      startTime: "2026-08-01T09:00:00.000Z",
      endTime: "2026-08-01T09:05:00.000Z",
      recurrence: { freq: "MINUTELY" as const, interval: 37 },
    };
    const occurrences = expandOccurrences(
      event,
      new Date("2026-08-01T09:00:00.000Z"),
      new Date("2026-08-01T12:00:00.000Z")
    );
    // 09:00, 09:37, 10:14, 10:51, 11:28, 12:05(excluded, past range) -> 5 within [09:00, 12:00]
    expect(occurrences).toHaveLength(5);
    expect(occurrences[1].start.toISOString()).toBe("2026-08-01T09:37:00.000Z");
    // duration preserved
    expect(occurrences[1].end.getTime() - occurrences[1].start.getTime()).toBe(5 * 60_000);
  });

  it("expands every weekday within a range", () => {
    const event = {
      // 2026-08-03 is a Monday
      startTime: "2026-08-03T09:00:00.000Z",
      endTime: "2026-08-03T09:15:00.000Z",
      recurrence: { freq: "WEEKLY" as const, interval: 1, byDay: ["MO", "TU", "WE", "TH", "FR"] as const },
    };
    const occurrences = expandOccurrences(
      event,
      new Date("2026-08-03T00:00:00.000Z"),
      new Date("2026-08-10T00:00:00.000Z")
    );
    // Mon Aug 3 - Fri Aug 7 = 5 weekday occurrences (weekend Aug 8-9 excluded)
    expect(occurrences).toHaveLength(5);
  });

  it("respects a count limit", () => {
    const event = {
      startTime: "2026-08-01T09:00:00.000Z",
      endTime: "2026-08-01T09:15:00.000Z",
      recurrence: { freq: "DAILY" as const, interval: 1, count: 3 },
    };
    const occurrences = expandOccurrences(
      event,
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-31T00:00:00.000Z")
    );
    expect(occurrences).toHaveLength(3);
  });
});

describe("describeRecurrence", () => {
  it("describes a simple daily repeat", () => {
    expect(describeRecurrence({ freq: "DAILY", interval: 1 })).toBe("Repeats every day");
  });

  it("describes a custom interval", () => {
    expect(describeRecurrence({ freq: "MINUTELY", interval: 37 })).toBe("Repeats every 37 minutes");
  });

  it("describes every weekday specially", () => {
    expect(
      describeRecurrence({ freq: "WEEKLY", interval: 1, byDay: ["MO", "TU", "WE", "TH", "FR"] })
    ).toBe("Repeats every weekday");
  });

  it("describes an arbitrary set of weekly days", () => {
    expect(describeRecurrence({ freq: "WEEKLY", interval: 1, byDay: ["MO", "WE"] })).toBe(
      "Repeats weekly on MO, WE"
    );
  });
});
