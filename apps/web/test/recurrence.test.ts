import { describe, it, expect } from "vitest";
import {
  expandOccurrences,
  describeRecurrence,
  withSkippedOccurrence,
  withoutSkippedOccurrence,
} from "../src/lib/recurrence.js";

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

  it("caps the number of occurrences for a high-frequency rule over a wide window, instead of freezing on hundreds of thousands of rows", () => {
    const event = {
      startTime: "2026-01-01T00:00:00.000Z",
      endTime: "2026-01-01T00:01:00.000Z",
      recurrence: { freq: "MINUTELY" as const, interval: 1 },
    };
    // A 120-day window at 1-minute intervals would be ~172,800 occurrences
    // without a cap.
    const occurrences = expandOccurrences(
      event,
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-05-01T00:00:00.000Z")
    );
    expect(occurrences.length).toBeLessThanOrEqual(500);
    expect(occurrences.length).toBeGreaterThan(0);
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

describe("skipped occurrences", () => {
  const daily = {
    startTime: "2026-08-01T09:00:00.000Z",
    endTime: "2026-08-01T09:30:00.000Z",
    recurrence: { freq: "DAILY" as const, interval: 1, count: 5 },
  };

  it("omits a skipped occurrence from the series without touching the rule", () => {
    const withSkip = { ...daily, skippedOccurrences: ["2026-08-03T09:00:00.000Z"] };
    const occurrences = expandOccurrences(
      withSkip,
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-10T00:00:00.000Z")
    );
    // 5 in the series, one skipped. The rule still says 5 -- no rows were
    // created or destroyed, the occurrence is simply excluded on expansion.
    expect(occurrences).toHaveLength(4);
    expect(occurrences.map((o) => o.start.toISOString())).not.toContain("2026-08-03T09:00:00.000Z");
  });

  it("can include skipped occurrences, flagged, for a 'view skipped' mode", () => {
    const withSkip = { ...daily, skippedOccurrences: ["2026-08-03T09:00:00.000Z"] };
    const occurrences = expandOccurrences(
      withSkip,
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-10T00:00:00.000Z"),
      { includeSkipped: true }
    );
    expect(occurrences).toHaveLength(5);
    expect(occurrences.filter((o) => o.skipped)).toHaveLength(1);
  });

  it("matches an exception by timestamp, not string, so ISO formatting can't break it", () => {
    // "+00:00" and "Z" denote the same instant; an exception written by one
    // client must still match an occurrence generated by another.
    const withSkip = { ...daily, skippedOccurrences: ["2026-08-03T09:00:00+00:00"] };
    const occurrences = expandOccurrences(
      withSkip,
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-10T00:00:00.000Z")
    );
    expect(occurrences).toHaveLength(4);
  });

  it("skips a non-recurring event too, rather than ignoring the exception", () => {
    const single = {
      startTime: "2026-08-01T09:00:00.000Z",
      endTime: "2026-08-01T09:30:00.000Z",
      skippedOccurrences: ["2026-08-01T09:00:00.000Z"],
    };
    expect(
      expandOccurrences(single, new Date("2026-07-01T00:00:00.000Z"), new Date("2026-09-01T00:00:00.000Z"))
    ).toHaveLength(0);
  });

  it("adds and removes exceptions without duplicating them", () => {
    const when = new Date("2026-08-03T09:00:00.000Z");
    const once = withSkippedOccurrence(undefined, when);
    expect(once).toHaveLength(1);
    // Skipping the same occurrence twice must not grow the list.
    expect(withSkippedOccurrence(once, when)).toHaveLength(1);
    expect(withoutSkippedOccurrence(once, when)).toHaveLength(0);
  });

  it("leaves other exceptions alone when restoring one", () => {
    const a = new Date("2026-08-03T09:00:00.000Z");
    const b = new Date("2026-08-04T09:00:00.000Z");
    const both = withSkippedOccurrence(withSkippedOccurrence(undefined, a), b);
    const afterRestore = withoutSkippedOccurrence(both, a);
    expect(afterRestore).toHaveLength(1);
    expect(new Date(afterRestore[0]!).getTime()).toBe(b.getTime());
  });
});
