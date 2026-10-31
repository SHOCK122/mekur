import { describe, it, expect } from "vitest";
import { expandOccurrences } from "../src/lib/recurrence.js";

describe("bounded expansion", () => {
  it("only materialises occurrences inside the view window", () => {
    // An indefinite series started years ago. Expanding it wholesale would
    // be hundreds of thousands of dates; only the visible day may be built.
    const event = {
      startTime: "2020-01-01T09:00:00.000Z",
      endTime: "2020-01-01T09:15:00.000Z",
      recurrence: { freq: "HOURLY" as const, interval: 1 },
    };
    const occurrences = expandOccurrences(
      event,
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-06-02T00:00:00.000Z")
    );
    // 25, not 24: the window is inclusive at both ends, so an hourly
    // series produces a boundary at 00:00 through 24:00. The point is
    // that it's a day's worth, not six years' worth.
    expect(occurrences).toHaveLength(25);
    for (const occurrence of occurrences) {
      expect(occurrence.start.getTime()).toBeGreaterThanOrEqual(
        new Date("2026-06-01T00:00:00.000Z").getTime()
      );
      expect(occurrence.start.getTime()).toBeLessThanOrEqual(
        new Date("2026-06-02T00:00:00.000Z").getTime()
      );
    }
  });

  it("returns quickly for an indefinite series far from its start", () => {
    // If expansion walked from the series start it would take a long time;
    // this asserts the bounded iterator is actually doing its job.
    const event = {
      startTime: "2000-01-01T00:00:00.000Z",
      endTime: "2000-01-01T00:01:00.000Z",
      recurrence: { freq: "MINUTELY" as const, interval: 1 },
    };
    const began = performance.now();
    const occurrences = expandOccurrences(
      event,
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-06-01T01:00:00.000Z")
    );
    const elapsed = performance.now() - began;
    expect(occurrences.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(3000);
  });

  it("bounds the look-back for a long event that repeats far more often than it lasts", () => {
    // A year-long event every minute: half a million repeats overlap any
    // window. Expansion must neither walk them nor return them.
    const event = {
      startTime: "2000-01-01T00:00:00.000Z",
      endTime: "2001-01-01T00:00:00.000Z",
      recurrence: { freq: "MINUTELY" as const, interval: 1 },
    };
    const began = performance.now();
    const occurrences = expandOccurrences(
      event,
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-06-01T01:00:00.000Z")
    );
    const elapsed = performance.now() - began;
    // One in progress at the window's start, then 61 starting inside it.
    expect(occurrences).toHaveLength(62);
    expect(occurrences[0]!.start.toISOString()).toBe("2026-05-31T23:59:00.000Z");
    expect(elapsed).toBeLessThan(3000);
  });

  it("respects an until date, stopping the series there", () => {
    const event = {
      startTime: "2026-06-01T09:00:00.000Z",
      endTime: "2026-06-01T09:30:00.000Z",
      recurrence: {
        freq: "DAILY" as const,
        interval: 1,
        until: "2026-06-03T23:59:59.000Z",
      },
    };
    const occurrences = expandOccurrences(
      event,
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-06-30T00:00:00.000Z")
    );
    // Three days, then it stops -- not the whole month.
    expect(occurrences).toHaveLength(3);
  });

  it("continues indefinitely into the future when no until is set", () => {
    const event = {
      startTime: "2026-06-01T09:00:00.000Z",
      endTime: "2026-06-01T09:30:00.000Z",
      recurrence: { freq: "DAILY" as const, interval: 1 },
    };
    // A window years later must still produce occurrences.
    const occurrences = expandOccurrences(
      event,
      new Date("2030-01-01T00:00:00.000Z"),
      new Date("2030-01-08T00:00:00.000Z")
    );
    expect(occurrences.length).toBeGreaterThanOrEqual(7);
  });
});
