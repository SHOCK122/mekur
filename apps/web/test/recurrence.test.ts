import { describe, it, expect } from "vitest";
import {
  expandOccurrences,
  describeRecurrence,
  withSkippedOccurrence,
  withoutSkippedOccurrence,
  repeatPatterns,
  usesPattern,
  withPattern,
  followStart,
  withOverride,
  withoutOverride,
  findOverride,
  activeOverrides,
  exceptionsFollowingStart,
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

  it("keeps a non-recurring event that is in progress at the start of the range", () => {
    // Regression: only events *starting* inside the range were kept, so an
    // 11:00-13:00 event vanished once the view was panned to start at 12:00.
    const event = { startTime: "2026-08-01T11:00:00.000Z", endTime: "2026-08-01T13:00:00.000Z" };
    const occurrences = expandOccurrences(
      event,
      new Date("2026-08-01T12:00:00.000Z"),
      new Date("2026-08-01T18:00:00.000Z")
    );
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].start.toISOString()).toBe("2026-08-01T11:00:00.000Z");
  });

  it("drops an event that ends exactly where the range begins", () => {
    const event = { startTime: "2026-08-01T11:00:00.000Z", endTime: "2026-08-01T12:00:00.000Z" };
    expect(
      expandOccurrences(event, new Date("2026-08-01T12:00:00.000Z"), new Date("2026-08-01T18:00:00.000Z"))
    ).toHaveLength(0);
  });

  it("keeps a zero-length event starting exactly at the range start", () => {
    const event = { startTime: "2026-08-01T12:00:00.000Z", endTime: "2026-08-01T12:00:00.000Z" };
    expect(
      expandOccurrences(event, new Date("2026-08-01T12:00:00.000Z"), new Date("2026-08-01T18:00:00.000Z"))
    ).toHaveLength(1);
  });

  it("does not treat an open-ended event that began earlier as in progress", () => {
    // Without an end there is nothing to overlap with; counting it would
    // keep every open-ended event that ever started on screen forever.
    const event = { startTime: "2026-08-01T11:00:00.000Z" };
    expect(
      expandOccurrences(event, new Date("2026-08-01T12:00:00.000Z"), new Date("2026-08-01T18:00:00.000Z"))
    ).toHaveLength(0);
  });

  it("keeps the occurrence of a series that is in progress at the start of the range", () => {
    const event = {
      startTime: "2026-08-01T11:00:00.000Z",
      endTime: "2026-08-01T13:00:00.000Z",
      recurrence: { freq: "DAILY" as const, interval: 1 },
    };
    const occurrences = expandOccurrences(
      event,
      new Date("2026-08-05T12:00:00.000Z"),
      new Date("2026-08-07T00:00:00.000Z")
    );
    expect(occurrences.map((o) => o.start.toISOString())).toEqual([
      "2026-08-05T11:00:00.000Z",
      "2026-08-06T11:00:00.000Z",
    ]);
  });

  it("returns only the latest in-progress repeat when several overlap the range start", () => {
    // Two-hour event every 30 minutes: four repeats are in progress at
    // 12:00, but each earlier one lies entirely under the latest in the
    // series' single row.
    const event = {
      startTime: "2026-08-01T08:00:00.000Z",
      endTime: "2026-08-01T10:00:00.000Z",
      recurrence: { freq: "MINUTELY" as const, interval: 30 },
    };
    const occurrences = expandOccurrences(
      event,
      new Date("2026-08-01T12:00:00.000Z"),
      new Date("2026-08-01T13:00:00.000Z")
    );
    expect(occurrences.map((o) => o.start.toISOString())).toEqual([
      "2026-08-01T11:30:00.000Z",
      "2026-08-01T12:00:00.000Z",
      "2026-08-01T12:30:00.000Z",
      "2026-08-01T13:00:00.000Z",
    ]);
  });

  it("falls back to an earlier in-progress repeat when the latest was skipped", () => {
    const event = {
      startTime: "2026-08-01T08:00:00.000Z",
      endTime: "2026-08-01T10:00:00.000Z",
      recurrence: { freq: "MINUTELY" as const, interval: 30 },
      skippedOccurrences: ["2026-08-01T11:30:00.000Z"],
    };
    const occurrences = expandOccurrences(
      event,
      new Date("2026-08-01T12:00:00.000Z"),
      new Date("2026-08-01T12:00:00.000Z")
    );
    expect(occurrences.map((o) => o.start.toISOString())).toEqual([
      "2026-08-01T11:00:00.000Z",
      "2026-08-01T12:00:00.000Z",
    ]);
  });

  it("with includeSkipped, shows a skipped in-progress repeat alongside, not instead of, the real one", () => {
    const event = {
      startTime: "2026-08-01T08:00:00.000Z",
      endTime: "2026-08-01T10:00:00.000Z",
      recurrence: { freq: "MINUTELY" as const, interval: 30 },
      skippedOccurrences: ["2026-08-01T11:30:00.000Z"],
    };
    const occurrences = expandOccurrences(
      event,
      new Date("2026-08-01T12:00:00.000Z"),
      new Date("2026-08-01T12:00:00.000Z"),
      { includeSkipped: true }
    );
    expect(occurrences.map((o) => [o.start.toISOString(), o.skipped])).toEqual([
      ["2026-08-01T11:00:00.000Z", false],
      ["2026-08-01T11:30:00.000Z", true],
      ["2026-08-01T12:00:00.000Z", false],
    ]);
  });

  it("finds an in-progress occurrence of a monthly series", () => {
    // Months vary in length, so this path walks rather than jumping ahead.
    const event = {
      startTime: "2026-01-10T00:00:00.000Z",
      endTime: "2026-01-20T00:00:00.000Z",
      recurrence: { freq: "MONTHLY" as const, interval: 1 },
    };
    const occurrences = expandOccurrences(
      event,
      new Date("2026-05-15T00:00:00.000Z"),
      new Date("2026-05-16T00:00:00.000Z")
    );
    expect(occurrences.map((o) => o.start.toISOString())).toEqual(["2026-05-10T00:00:00.000Z"]);
  });

  it("respects count when looking for an in-progress occurrence", () => {
    const event = {
      startTime: "2026-08-01T11:00:00.000Z",
      endTime: "2026-08-01T13:00:00.000Z",
      recurrence: { freq: "DAILY" as const, interval: 1, count: 2 },
    };
    // The series' last occurrence is on 2 Aug; nothing is in progress on the 3rd.
    expect(
      expandOccurrences(event, new Date("2026-08-03T12:00:00.000Z"), new Date("2026-08-04T00:00:00.000Z"))
    ).toHaveLength(0);
    expect(
      expandOccurrences(event, new Date("2026-08-02T12:00:00.000Z"), new Date("2026-08-03T00:00:00.000Z"))
    ).toHaveLength(1);
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

describe("calendar patterns (byMonthDay, byMonth, bySetPos)", () => {
  const starts = (event: Parameters<typeof expandOccurrences>[0], from: string, to: string) =>
    expandOccurrences(event, new Date(from), new Date(to)).map((o) => o.start.toISOString());

  it("repeats on the first Monday of every month", () => {
    const event = {
      startTime: "2026-01-05T09:00:00.000Z",
      endTime: "2026-01-05T10:00:00.000Z",
      recurrence: { freq: "MONTHLY" as const, interval: 1, byDay: ["MO" as const], bySetPos: [1] },
    };
    expect(starts(event, "2026-01-01T00:00:00Z", "2026-04-30T00:00:00Z")).toEqual([
      "2026-01-05T09:00:00.000Z",
      "2026-02-02T09:00:00.000Z",
      "2026-03-02T09:00:00.000Z",
      "2026-04-06T09:00:00.000Z",
    ]);
  });

  it("repeats on the last day of every month", () => {
    const event = {
      startTime: "2026-01-31T12:00:00.000Z",
      recurrence: { freq: "MONTHLY" as const, interval: 1, byMonthDay: [-1] },
    };
    expect(starts(event, "2026-01-01T00:00:00Z", "2026-04-01T00:00:00Z")).toEqual([
      "2026-01-31T12:00:00.000Z",
      "2026-02-28T12:00:00.000Z",
      "2026-03-31T12:00:00.000Z",
    ]);
  });

  it("repeats on the last Friday of March, yearly", () => {
    const event = {
      startTime: "2026-03-27T18:00:00.000Z",
      recurrence: { freq: "YEARLY" as const, interval: 1, byMonth: [3], byDay: ["FR" as const], bySetPos: [-1] },
    };
    expect(starts(event, "2026-01-01T00:00:00Z", "2029-01-01T00:00:00Z")).toEqual([
      "2026-03-27T18:00:00.000Z",
      "2027-03-26T18:00:00.000Z",
      "2028-03-31T18:00:00.000Z",
    ]);
  });

  it("evaluates the weekday on the rule's own wall clock, not UTC", () => {
    // 09:00 on the first Monday in Sydney is 22:00 UTC the Sunday before.
    // Evaluated in UTC, "Monday" would land a day late, at 09:00 Tuesday.
    const event = {
      startTime: "2026-01-04T22:00:00.000Z",
      recurrence: {
        freq: "MONTHLY" as const,
        interval: 1,
        byDay: ["MO" as const],
        bySetPos: [1],
        tzid: "Australia/Sydney",
      },
    };
    expect(starts(event, "2026-01-01T00:00:00Z", "2026-05-01T00:00:00Z")).toEqual([
      "2026-01-04T22:00:00.000Z", // Mon 5 Jan, 09:00 AEDT
      "2026-02-01T22:00:00.000Z", // Mon 2 Feb
      "2026-03-01T22:00:00.000Z", // Mon 2 Mar
      "2026-04-05T23:00:00.000Z", // Mon 6 Apr, 09:00 AEST: clocks went back on 5 Apr
    ]);
  });

  it("keeps skipped occurrences matching in a time zone", () => {
    const event = {
      startTime: "2026-01-04T22:00:00.000Z",
      recurrence: { freq: "MONTHLY" as const, interval: 1, byDay: ["MO" as const], bySetPos: [1], tzid: "Australia/Sydney" },
      skippedOccurrences: ["2026-02-01T22:00:00.000Z"],
    };
    expect(starts(event, "2026-01-01T00:00:00Z", "2026-03-15T00:00:00Z")).toEqual([
      "2026-01-04T22:00:00.000Z",
      "2026-03-01T22:00:00.000Z",
    ]);
  });

  it("returns nothing, quickly, for a valid rule that never occurs", () => {
    // Every 12 months from January, but only in February: never. The
    // schema can't see that (it depends on the start); rrule alone walks
    // to the year 9999 looking.
    const event = {
      startTime: "2026-01-05T09:00:00.000Z",
      recurrence: { freq: "MONTHLY" as const, interval: 12, byMonth: [2] },
    };
    expect(starts(event, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")).toEqual([]);
    const began = performance.now();
    for (let i = 0; i < 50; i++) starts(event, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z");
    expect(performance.now() - began).toBeLessThan(250);
  });

  it("drops only the calendar fields that fail, and a position together with its weekday", () => {
    // An until with an offset fails the schema, but has always worked;
    // it mustn't take the "third Tuesday" with it.
    const withOffset = {
      startTime: "2026-01-20T09:00:00.000Z",
      recurrence: {
        freq: "MONTHLY" as const,
        interval: 1,
        byDay: ["TU" as const],
        bySetPos: [3],
        until: "2026-12-31T23:59:59+01:00",
      },
    };
    expect(starts(withOffset, "2026-01-01T00:00:00Z", "2026-04-01T00:00:00Z")).toEqual([
      "2026-01-20T09:00:00.000Z",
      "2026-02-17T09:00:00.000Z",
      "2026-03-17T09:00:00.000Z",
    ]);
    // Without its (invalid) position, "the sixth Tuesday" must not turn
    // into every Tuesday: it falls back to the plain monthly date.
    const sixth = {
      startTime: "2026-01-20T09:00:00.000Z",
      recurrence: { freq: "MONTHLY" as const, interval: 1, byDay: ["TU" as const], bySetPos: [6] },
    };
    expect(starts(sixth, "2026-01-01T00:00:00Z", "2026-04-01T00:00:00Z")).toEqual([
      "2026-01-20T09:00:00.000Z",
      "2026-02-20T09:00:00.000Z",
      "2026-03-20T09:00:00.000Z",
    ]);
  });

  it("ignores calendar parts that don't validate instead of walking forever", () => {
    // Content comes from whoever holds the edit capability; a daily rule
    // for February 30th is invalid and would walk ~3 million days.
    const event = {
      startTime: "2026-01-05T09:00:00.000Z",
      recurrence: { freq: "DAILY" as const, interval: 1, byMonth: [2], byMonthDay: [30] },
    };
    const began = performance.now();
    expect(starts(event, "2026-01-05T00:00:00Z", "2026-01-08T00:00:00Z")).toEqual([
      "2026-01-05T09:00:00.000Z",
      "2026-01-06T09:00:00.000Z",
      "2026-01-07T09:00:00.000Z",
    ]);
    expect(performance.now() - began).toBeLessThan(250);
  });

  it("ignores an unknown time zone and falls back to UTC", () => {
    const event = {
      startTime: "2026-01-05T09:00:00.000Z",
      recurrence: { freq: "MONTHLY" as const, interval: 1, byDay: ["MO" as const], bySetPos: [1], tzid: "Nowhere/Nope" },
    };
    expect(starts(event, "2026-01-01T00:00:00Z", "2026-02-15T00:00:00Z")).toEqual([
      "2026-01-05T09:00:00.000Z",
      "2026-02-02T09:00:00.000Z",
    ]);
  });
});

describe("repeatPatterns", () => {
  // Starts are built on the local clock, so read them in the local zone.
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const labels = (freq: "MONTHLY" | "YEARLY", start: Date) =>
    repeatPatterns(freq, start, zone).map((p) => p.label);

  it("offers the date and the nth weekday", () => {
    // Tuesday 20 January 2026 (local time).
    expect(labels("MONTHLY", new Date(2026, 0, 20, 9))).toEqual(["On day 20", "On the third Tuesday"]);
  });

  it("offers the last weekday in a month's final week, and the last day on it", () => {
    // Saturday 31 January 2026: the fifth Saturday, so no "nth" option.
    // The last day differs from day 31, which skips shorter months.
    expect(labels("MONTHLY", new Date(2026, 0, 31, 9))).toEqual([
      "On day 31 (skips months without one)",
      "On the last Saturday",
      "On the last day",
    ]);
    // Monday 30 November 2026: both the last Monday and the last day.
    expect(labels("MONTHLY", new Date(2026, 10, 30, 9))).toEqual([
      "On day 30 (skips months without one)",
      "On the last Monday",
      "On the last day",
    ]);
    // Thursday 26 February 2026: fourth and last Thursday.
    expect(labels("MONTHLY", new Date(2026, 1, 26, 9))).toEqual([
      "On day 26",
      "On the fourth Thursday",
      "On the last Thursday",
    ]);
  });

  it("reads the start in the given zone, not the device's", () => {
    // 22:00 UTC on Sunday 4 January is Monday 5 January in Sydney.
    const start = new Date("2026-01-04T22:00:00Z");
    expect(repeatPatterns("MONTHLY", start, "Australia/Sydney").map((p) => p.label)).toEqual([
      "On day 5",
      "On the first Monday",
    ]);
    expect(repeatPatterns("MONTHLY", start, "UTC").map((p) => p.label)).toEqual(["On day 4", "On the first Sunday"]);
  });

  it("offers the last day yearly only for February, where it isn't a fixed date", () => {
    expect(labels("YEARLY", new Date(2026, 3, 30, 9))).toEqual(["On April 30", "On the last Thursday of April"]);
    expect(labels("YEARLY", new Date(2026, 1, 28, 9))).toEqual([
      "On February 28",
      "On the fourth Saturday of February",
      "On the last Saturday of February",
      "On the last day of February",
    ]);
  });

  it("names the month for yearly series", () => {
    expect(labels("YEARLY", new Date(2026, 2, 27, 9))).toEqual([
      "On March 27",
      "On the fourth Friday of March",
      "On the last Friday of March",
    ]);
    expect(labels("YEARLY", new Date(2028, 1, 29, 9))).toEqual([
      "On February 29 (leap years only)",
      "On the last Tuesday of February",
      "On the last day of February",
    ]);
  });

  it("offers nothing for other frequencies", () => {
    expect(repeatPatterns("WEEKLY", new Date(2026, 0, 20), "UTC")).toEqual([]);
  });

  it("every pattern carries the time zone, and the start is an occurrence of each", () => {
    const start = new Date(2026, 10, 30, 9);
    for (const freq of ["MONTHLY", "YEARLY"] as const) {
      for (const pattern of repeatPatterns(freq, start, zone)) {
        expect(pattern.fields.tzid).toBe(zone);
        const rule = withPattern({ freq, interval: 1 }, pattern.fields);
        const [first] = expandOccurrences(
          { startTime: start.toISOString(), recurrence: rule },
          new Date(start.getTime() - 1000),
          new Date(start.getTime() + 1000)
        );
        expect(first?.start.toISOString()).toBe(start.toISOString());
      }
    }
  });

  it("withPattern replaces every calendar field, and usesPattern recognises the result", () => {
    const [date, nth] = repeatPatterns("MONTHLY", new Date(2026, 0, 20, 9), "UTC");
    const rule = withPattern({ freq: "MONTHLY", interval: 2, until: "2027-01-01T00:00:00.000Z" }, nth!.fields);
    expect(usesPattern(rule, nth!)).toBe(true);
    expect(usesPattern(rule, date!)).toBe(false);
    expect(withPattern(rule, date!.fields)).toEqual({
      freq: "MONTHLY",
      interval: 2,
      until: "2027-01-01T00:00:00.000Z",
      tzid: "UTC",
    });
  });
});

describe("followStart", () => {
  const thirdTuesday = { freq: "MONTHLY" as const, interval: 1, byDay: ["TU" as const], bySetPos: [3], tzid: "UTC" };
  const at = (iso: string) => new Date(iso);

  it("keeps the kind of pattern on the new date", () => {
    // Tue 20 Jan -> Wed 7 Jan: the first Wednesday.
    expect(followStart(thirdTuesday, at("2026-01-20T09:00Z"), at("2026-01-07T09:00Z"))).toEqual({
      ...thirdTuesday,
      byDay: ["WE"],
      bySetPos: [1],
    });
  });

  it("turns a fifth weekday into the last one, and a last day mid-month into the date", () => {
    expect(followStart(thirdTuesday, at("2026-01-20T09:00Z"), at("2026-03-31T09:00Z"))).toEqual({
      ...thirdTuesday,
      bySetPos: [-1],
    });
    const lastDay = { freq: "MONTHLY" as const, interval: 1, byMonthDay: [-1], tzid: "UTC" };
    expect(followStart(lastDay, at("2026-01-31T09:00Z"), at("2026-02-12T09:00Z"))).toEqual({
      freq: "MONTHLY",
      interval: 1,
      tzid: "UTC",
    });
  });

  it("reads both dates in the rule's own zone", () => {
    const sydney = { ...thirdTuesday, byDay: ["MO" as const], bySetPos: [1], tzid: "Australia/Sydney" };
    // Mon 5 Jan 09:00 Sydney -> Mon 2 Feb 09:00 Sydney (Sundays in UTC): unchanged.
    expect(followStart(sydney, at("2026-01-04T22:00Z"), at("2026-02-01T22:00Z"))).toBe(sydney);
  });

  it("doesn't throw on a time zone this runtime doesn't know", () => {
    const bogus = { ...thirdTuesday, tzid: "Nowhere/Nope" };
    expect(() => followStart(bogus, at("2026-01-20T09:00Z"), at("2026-01-21T09:00Z"))).not.toThrow();
  });

  it("leaves alone rules it can't place, and other frequencies", () => {
    const custom = { freq: "MONTHLY" as const, interval: 1, byMonthDay: [1, 15] };
    expect(followStart(custom, at("2026-01-01T09:00Z"), at("2026-01-02T09:00Z"))).toBe(custom);
    const weekly = { freq: "WEEKLY" as const, interval: 1, byDay: ["MO" as const] };
    expect(followStart(weekly, at("2026-01-05T09:00Z"), at("2026-01-06T09:00Z"))).toBe(weekly);
  });
});

describe("describeRecurrence with calendar patterns", () => {
  it("describes nth weekdays, last days and months", () => {
    expect(describeRecurrence({ freq: "MONTHLY", interval: 1, byDay: ["TU"], bySetPos: [3] })).toBe(
      "Repeats every month on the third Tuesday"
    );
    expect(describeRecurrence({ freq: "MONTHLY", interval: 2, byMonthDay: [-1] })).toBe(
      "Repeats every 2 months on the last day"
    );
    expect(
      describeRecurrence({ freq: "YEARLY", interval: 1, byMonth: [3], byDay: ["FR"], bySetPos: [-1] })
    ).toBe("Repeats every year on the last Friday of March");
    expect(describeRecurrence({ freq: "MONTHLY", interval: 1, byMonthDay: [1, 15] })).toBe(
      "Repeats every month on day 1 and day 15"
    );
    expect(describeRecurrence({ freq: "YEARLY", interval: 1, byMonth: [6, 7] })).toBe(
      "Repeats every year in June and July"
    );
  });

  it("describes a monthly rule with weekdays as monthly, not weekly", () => {
    expect(describeRecurrence({ freq: "MONTHLY", interval: 1, byDay: ["MO"] })).toBe(
      "Repeats every month on Monday"
    );
  });
});

describe("moved occurrences (occurrenceOverrides)", () => {
  // 09:00-09:30 every day from Monday 3 August.
  const daily = {
    startTime: "2026-08-03T09:00:00.000Z",
    endTime: "2026-08-03T09:30:00.000Z",
    recurrence: { freq: "DAILY" as const, interval: 1 },
  };
  const wednesday = "2026-08-05T09:00:00.000Z";
  const movedWednesday = {
    ...daily,
    occurrenceOverrides: [
      { occurrence: wednesday, startTime: "2026-08-05T15:00:00.000Z", endTime: "2026-08-05T16:00:00.000Z" },
    ],
  };
  const iso = (d: Date | null) => d?.toISOString() ?? null;

  it("shows a moved occurrence at its new times, and not at its old ones", () => {
    const occurrences = expandOccurrences(
      movedWednesday,
      new Date("2026-08-05T00:00:00.000Z"),
      new Date("2026-08-06T00:00:00.000Z")
    );
    expect(occurrences.map((o) => [iso(o.start), iso(o.end), iso(o.recurrenceId), o.moved])).toEqual([
      ["2026-08-05T15:00:00.000Z", "2026-08-05T16:00:00.000Z", wednesday, true],
    ]);
  });

  it("leaves the other occurrences of the series alone", () => {
    const occurrences = expandOccurrences(
      movedWednesday,
      new Date("2026-08-04T00:00:00.000Z"),
      new Date("2026-08-07T00:00:00.000Z")
    );
    expect(occurrences.map((o) => [iso(o.start), iso(o.recurrenceId), o.moved])).toEqual([
      ["2026-08-04T09:00:00.000Z", "2026-08-04T09:00:00.000Z", false],
      ["2026-08-05T15:00:00.000Z", wednesday, true],
      ["2026-08-06T09:00:00.000Z", "2026-08-06T09:00:00.000Z", false],
    ]);
  });

  it("shows an occurrence moved into the window from outside it", () => {
    const toThursday = {
      ...daily,
      occurrenceOverrides: [{ occurrence: wednesday, startTime: "2026-08-06T12:00:00.000Z" }],
    };
    const occurrences = expandOccurrences(
      toThursday,
      new Date("2026-08-06T10:00:00.000Z"),
      new Date("2026-08-06T13:00:00.000Z")
    );
    // Open-ended override, starting inside the window.
    expect(occurrences.map((o) => [iso(o.start), iso(o.end), iso(o.recurrenceId)])).toEqual([
      ["2026-08-06T12:00:00.000Z", null, wednesday],
    ]);
  });

  it("keeps a moved occurrence that is in progress at the window's start", () => {
    const occurrences = expandOccurrences(
      movedWednesday,
      new Date("2026-08-05T15:30:00.000Z"),
      new Date("2026-08-05T18:00:00.000Z")
    );
    expect(occurrences.map((o) => iso(o.start))).toEqual(["2026-08-05T15:00:00.000Z"]);
  });

  it("drops an occurrence moved out of the window", () => {
    expect(
      expandOccurrences(movedWednesday, new Date("2026-08-05T08:00:00.000Z"), new Date("2026-08-05T10:00:00.000Z"))
    ).toEqual([]);
  });

  it("does not count a moved occurrence as the one in progress at the window's start", () => {
    // Without the move, Wednesday 09:00-09:30 is in progress at 09:15.
    expect(
      expandOccurrences(movedWednesday, new Date("2026-08-05T09:15:00.000Z"), new Date("2026-08-05T10:00:00.000Z"))
    ).toEqual([]);
  });

  it("ignores an override of a time the series doesn't occur at", () => {
    // E.g. left behind when the series itself was moved.
    const orphaned = {
      ...daily,
      occurrenceOverrides: [{ occurrence: "2026-08-05T10:00:00.000Z", startTime: "2026-08-05T15:00:00.000Z" }],
    };
    const occurrences = expandOccurrences(
      orphaned,
      new Date("2026-08-05T00:00:00.000Z"),
      new Date("2026-08-06T00:00:00.000Z")
    );
    expect(occurrences.map((o) => [iso(o.start), o.moved])).toEqual([["2026-08-05T09:00:00.000Z", false]]);
  });

  it("ignores an override past the end of the series", () => {
    const ended = {
      ...movedWednesday,
      recurrence: { freq: "DAILY" as const, interval: 1, count: 2 },
    };
    expect(
      expandOccurrences(ended, new Date("2026-08-05T00:00:00.000Z"), new Date("2026-08-06T00:00:00.000Z"))
    ).toEqual([]);
  });

  it("lets a skip win over a move, so restoring brings the move back", () => {
    const both = { ...movedWednesday, skippedOccurrences: [wednesday] };
    const window = [new Date("2026-08-05T00:00:00.000Z"), new Date("2026-08-06T00:00:00.000Z")] as const;
    expect(expandOccurrences(both, ...window)).toEqual([]);
    const shown = expandOccurrences(both, ...window, { includeSkipped: true });
    expect(shown.map((o) => [iso(o.start), o.skipped, o.moved])).toEqual([[wednesday, true, false]]);
  });

  it("ignores overrides on an event that doesn't repeat", () => {
    const { recurrence: _recurrence, ...single } = movedWednesday;
    const once = { ...single, startTime: wednesday, endTime: "2026-08-05T09:30:00.000Z" };
    const occurrences = expandOccurrences(
      once,
      new Date("2026-08-05T00:00:00.000Z"),
      new Date("2026-08-06T00:00:00.000Z")
    );
    expect(occurrences.map((o) => [iso(o.start), o.moved])).toEqual([[wednesday, false]]);
  });

  it("ignores overrides with unreadable times rather than throwing", () => {
    // Decrypted content isn't schema-checked.
    const broken = {
      ...daily,
      occurrenceOverrides: [
        { occurrence: "not a date", startTime: "2026-08-05T15:00:00.000Z" },
        { occurrence: wednesday, startTime: "nope" },
        { occurrence: wednesday, startTime: "2026-08-05T15:00:00.000Z", endTime: "2026-08-05T14:00:00.000Z" },
      ],
    };
    const occurrences = expandOccurrences(
      broken,
      new Date("2026-08-05T00:00:00.000Z"),
      new Date("2026-08-06T00:00:00.000Z")
    );
    expect(occurrences.map((o) => [iso(o.start), o.moved])).toEqual([[wednesday, false]]);
  });

  it("matches occurrences of a rule evaluated in a time zone", () => {
    // The first Monday of each month at 09:00 in Sydney: 22:00 UTC on Sunday.
    const firstMonday = {
      // Monday 5 January, 09:00 in Sydney.
      startTime: "2026-01-04T22:00:00.000Z",
      endTime: "2026-01-04T23:00:00.000Z",
      recurrence: {
        freq: "MONTHLY" as const,
        interval: 1,
        byDay: ["MO" as const],
        bySetPos: [1],
        tzid: "Australia/Sydney",
      },
      occurrenceOverrides: [
        // March's (Monday 2 March, 09:00 Sydney), moved an hour later.
        { occurrence: "2026-03-01T22:00:00.000Z", startTime: "2026-03-01T23:00:00.000Z" },
      ],
    };
    const occurrences = expandOccurrences(
      firstMonday,
      new Date("2026-02-15T00:00:00.000Z"),
      new Date("2026-04-15T00:00:00.000Z")
    );
    expect(occurrences.map((o) => [iso(o.start), o.moved])).toEqual([
      ["2026-03-01T23:00:00.000Z", true],
      // April's: 09:00 in Sydney is 23:00 UTC once DST has ended.
      ["2026-04-05T23:00:00.000Z", false],
    ]);
  });

  it("only considers a bounded number of overrides", () => {
    // Decrypted content isn't schema-checked, so the cap is enforced here too.
    const many = Array.from({ length: 1_000 }, (_, i) => {
      const occurrence = new Date(Date.UTC(2026, 7, 3 + i, 9)).toISOString();
      return { occurrence, startTime: new Date(Date.UTC(2026, 7, 3 + i, 15)).toISOString() };
    });
    const lots = { ...daily, occurrenceOverrides: many };
    const late = expandOccurrences(lots, new Date("2029-01-01T00:00:00.000Z"), new Date("2029-01-02T00:00:00.000Z"));
    expect(late.map((o) => [iso(o.start), o.moved])).toEqual([["2029-01-01T09:00:00.000Z", false]]);
  });
});

describe("activeOverrides", () => {
  const daily = {
    startTime: "2026-08-03T09:00:00.000Z",
    endTime: "2026-08-03T09:30:00.000Z",
    recurrence: { freq: "DAILY" as const, interval: 1 },
  };

  it("keeps the moves that apply, and drops left-behind and unreadable ones", () => {
    const applies = { occurrence: "2026-08-05T09:00:00.000Z", startTime: "2026-08-05T15:00:00.000Z" };
    const event = {
      ...daily,
      occurrenceOverrides: [
        applies,
        { occurrence: "2026-08-05T10:00:00.000Z", startTime: "2026-08-05T15:00:00.000Z" },
        { occurrence: "garbage", startTime: "2026-08-05T15:00:00.000Z" },
        null,
      ] as never,
    };
    expect(activeOverrides(event)).toEqual([applies]);
  });

  it("is empty for a non-list or a one-off", () => {
    expect(activeOverrides({ ...daily, occurrenceOverrides: "nope" as never })).toEqual([]);
    const { recurrence: _r, ...once } = daily;
    expect(
      activeOverrides({ ...once, occurrenceOverrides: [{ occurrence: daily.startTime, startTime: daily.endTime }] })
    ).toEqual([]);
  });

  it("doesn't reuse an answer for a series read in a different time zone", () => {
    // Same list, same wall-clock start (09:00), different zones: 09:00 UTC
    // is an occurrence of the UTC series but not of the London one.
    const occurrenceOverrides = [{ occurrence: "2026-08-05T09:00:00.000Z", startTime: "2026-08-05T15:00:00.000Z" }];
    expect(activeOverrides({ ...daily, occurrenceOverrides })).toHaveLength(1);
    const london = {
      startTime: "2026-08-03T08:00:00.000Z",
      recurrence: { freq: "DAILY" as const, interval: 1, tzid: "Europe/London" },
      occurrenceOverrides,
    };
    expect(activeOverrides(london)).toEqual([]);
  });
});

describe("exceptionsFollowingStart", () => {
  const series = {
    startTime: "2026-08-03T09:00:00.000Z",
    recurrence: { freq: "DAILY" as const, interval: 1 },
    skippedOccurrences: ["2026-08-04T09:00:00.000Z"],
    occurrenceOverrides: [{ occurrence: "2026-08-05T09:00:00.000Z", startTime: "2026-08-05T15:00:00.000Z" }],
  };

  it("moves a fixed-length series' skips and moves by as much as its start", () => {
    expect(exceptionsFollowingStart(series, "2026-08-03T09:30:00.000Z")).toEqual({
      skippedOccurrences: ["2026-08-04T09:30:00.000Z"],
      occurrenceOverrides: [{ occurrence: "2026-08-05T09:30:00.000Z", startTime: "2026-08-05T15:00:00.000Z" }],
    });
  });

  it("changes nothing when the rule changes too, or the start doesn't", () => {
    expect(exceptionsFollowingStart(series, "2026-08-03T09:30:00.000Z", { freq: "HOURLY", interval: 1 })).toEqual({});
    expect(exceptionsFollowingStart(series, series.startTime)).toEqual({});
    const weekdays = { ...series, recurrence: { freq: "WEEKLY" as const, interval: 1, byDay: ["MO" as const, "WE" as const] } };
    expect(
      exceptionsFollowingStart(weekdays, "2026-08-03T10:00:00.000Z", { ...weekdays.recurrence, byDay: ["MO", "FR"] })
    ).toEqual({});
  });

  /** Which occurrences, by start, are skipped and moved. */
  function exceptionsOf(event: Parameters<typeof expandOccurrences>[0], from: string, to: string) {
    const all = expandOccurrences(event, new Date(from), new Date(to), { includeSkipped: true });
    return {
      skipped: all.filter((o) => o.skipped).map((o) => o.start.toISOString()),
      moved: all.filter((o) => o.moved).map((o) => o.recurrenceId.toISOString()),
    };
  }

  describe("where occurrences don't all move alike", () => {
    // 2026-08-03 is a Monday.
    const weekdays = {
      startTime: "2026-08-03T09:00:00.000Z",
      endTime: "2026-08-03T09:30:00.000Z",
      recurrence: { freq: "WEEKLY" as const, interval: 1, byDay: ["MO" as const, "WE" as const] },
      skippedOccurrences: ["2026-08-05T09:00:00.000Z"],
      occurrenceOverrides: [{ occurrence: "2026-08-10T09:00:00.000Z", startTime: "2026-08-10T15:00:00.000Z" }],
    };

    it("carries a weekday series' exceptions along a change of time of day", () => {
      const changes = exceptionsFollowingStart(weekdays, "2026-08-03T10:00:00.000Z");
      expect(changes).toEqual({
        skippedOccurrences: ["2026-08-05T10:00:00.000Z"],
        occurrenceOverrides: [{ occurrence: "2026-08-10T10:00:00.000Z", startTime: "2026-08-10T15:00:00.000Z" }],
      });
      const moved = { ...weekdays, ...changes, startTime: "2026-08-03T10:00:00.000Z", endTime: "2026-08-03T10:30:00.000Z" };
      expect(exceptionsOf(moved, "2026-08-01T00:00:00Z", "2026-08-20T00:00:00Z")).toEqual({
        skipped: ["2026-08-05T10:00:00.000Z"],
        moved: ["2026-08-10T10:00:00.000Z"],
      });
    });

    it("carries them, and a moved occurrence's day, a week along when the series moves a week", () => {
      expect(exceptionsFollowingStart(weekdays, "2026-08-10T09:00:00.000Z")).toEqual({
        skippedOccurrences: ["2026-08-12T09:00:00.000Z"],
        occurrenceOverrides: [{ occurrence: "2026-08-17T09:00:00.000Z", startTime: "2026-08-17T15:00:00.000Z" }],
      });
    });

    it("leaves a weekday's exceptions on their weekday when the start moves to another day", () => {
      // Found in review: counting positions, the start moved to a Tuesday
      // (not one of the series' days) shifted every exception one along,
      // so the next Monday was skipped instead of Wednesday.
      expect(exceptionsFollowingStart(weekdays, "2026-08-04T09:00:00.000Z")).toEqual({
        skippedOccurrences: ["2026-08-05T09:00:00.000Z"],
        occurrenceOverrides: weekdays.occurrenceOverrides,
      });
    });

    it("carries a zoned series' exceptions across a change of clocks", () => {
      // 09:00 in London: 08:00 UTC in summer, 09:00 UTC after 25 October.
      const zoned = {
        startTime: "2026-10-20T08:00:00.000Z",
        endTime: "2026-10-20T08:30:00.000Z",
        recurrence: { freq: "DAILY" as const, interval: 1, tzid: "Europe/London" },
        skippedOccurrences: ["2026-10-27T09:00:00.000Z"],
      };
      // Moved to 09:30 London time.
      const changes = exceptionsFollowingStart(zoned, "2026-10-20T08:30:00.000Z");
      expect(changes).toEqual({ skippedOccurrences: ["2026-10-27T09:30:00.000Z"] });
      const moved = { ...zoned, ...changes, startTime: "2026-10-20T08:30:00.000Z", endTime: "2026-10-20T09:00:00.000Z" };
      expect(exceptionsOf(moved, "2026-10-19T00:00:00Z", "2026-11-01T00:00:00Z").skipped).toEqual([
        "2026-10-27T09:30:00.000Z",
      ]);
    });

    it("carries a zoned series' exceptions however far out they are", () => {
      // Found in review: a walk with a cap left the far ones behind.
      const hourly = {
        startTime: "2026-01-01T09:00:00.000Z",
        recurrence: { freq: "HOURLY" as const, interval: 1, tzid: "Europe/London" },
        skippedOccurrences: ["2046-01-01T09:00:00.000Z"],
      };
      expect(exceptionsFollowingStart(hourly, "2026-01-01T09:30:00.000Z")).toEqual({
        skippedOccurrences: ["2046-01-01T09:30:00.000Z"],
      });
    });

    it("carries a calendar pattern's exceptions to the pattern it becomes", () => {
      // "The third Tuesday" (18 August), moved a day, is "the third
      // Wednesday"; September's skip goes from the 15th to the 16th.
      const start = new Date("2026-08-18T09:00:00.000Z");
      const pattern = repeatPatterns("MONTHLY", start, "UTC").find((p) => p.key === "nth-weekday")!;
      const thirdTuesday = {
        startTime: start.toISOString(),
        recurrence: withPattern({ freq: "MONTHLY", interval: 1 }, pattern.fields),
        skippedOccurrences: ["2026-09-15T09:00:00.000Z"],
      };
      const to = new Date("2026-08-19T09:00:00.000Z");
      const recurrence = followStart(thirdTuesday.recurrence, start, to);
      expect(recurrence).not.toEqual(thirdTuesday.recurrence);
      expect(exceptionsFollowingStart(thirdTuesday, to.toISOString(), recurrence)).toEqual({
        skippedOccurrences: ["2026-09-16T09:00:00.000Z"],
      });
      // Not with a pattern the new start doesn't offer.
      expect(exceptionsFollowingStart(thirdTuesday, to.toISOString(), { ...recurrence, bySetPos: [2] })).toEqual({});
    });

    it("accepts the pattern the editor reaches one edit at a time", () => {
      // Found in review: "the last Tuesday" (25 August) edited to the 19th
      // (third Wednesday) and then the 26th becomes "the fourth
      // Wednesday", while one followStart from the original gives "the
      // last Wednesday". Either is the start's own pattern.
      const start = new Date("2026-08-25T09:00:00.000Z");
      const last = repeatPatterns("MONTHLY", start, "UTC").find((p) => p.key === "last-weekday")!;
      const series = {
        startTime: start.toISOString(),
        recurrence: withPattern({ freq: "MONTHLY", interval: 1 }, last.fields),
        skippedOccurrences: ["2026-09-29T09:00:00.000Z"],
      };
      const mid = new Date("2026-08-19T09:00:00.000Z");
      const to = new Date("2026-08-26T09:00:00.000Z");
      const stepwise = followStart(followStart(series.recurrence, start, mid), mid, to);
      expect(stepwise).not.toEqual(followStart(series.recurrence, start, to));
      // September's fourth Wednesday.
      expect(exceptionsFollowingStart(series, to.toISOString(), stepwise)).toEqual({
        skippedOccurrences: ["2026-09-23T09:00:00.000Z"],
      });
    });

    it("keeps a date pattern's exceptions in their month", () => {
      // Found in review: counting positions, the 31st moved to the 30th
      // sent May's skip to April (the 31st skips April; the 30th doesn't).
      const start = new Date("2026-01-31T09:00:00.000Z");
      const recurrence = withPattern({ freq: "MONTHLY", interval: 1 }, repeatPatterns("MONTHLY", start, "UTC")[0]!.fields);
      const series = {
        startTime: start.toISOString(),
        recurrence,
        skippedOccurrences: ["2026-05-31T09:00:00.000Z", "2026-07-31T09:00:00.000Z"],
      };
      const to = new Date("2026-01-30T09:00:00.000Z");
      expect(exceptionsFollowingStart(series, to.toISOString(), followStart(recurrence, start, to))).toEqual({
        skippedOccurrences: ["2026-05-30T09:00:00.000Z", "2026-07-30T09:00:00.000Z"],
      });
      // Moved two months on, they move two months on. September has no
      // 31st, so July's skip has nowhere to go; left on 31 July it would
      // skip what is now May's occurrence, so it goes.
      const later = new Date("2026-03-31T09:00:00.000Z");
      expect(exceptionsFollowingStart(series, later.toISOString(), followStart(recurrence, start, later))).toEqual({
        skippedOccurrences: ["2026-07-31T09:00:00.000Z"],
      });
    });

    it("keeps a leap day's exceptions in their year", () => {
      const start = new Date("2024-02-29T09:00:00.000Z");
      const recurrence = withPattern({ freq: "YEARLY", interval: 1 }, repeatPatterns("YEARLY", start, "UTC")[0]!.fields);
      const series = { startTime: start.toISOString(), recurrence, skippedOccurrences: ["2032-02-29T09:00:00.000Z"] };
      const to = new Date("2024-02-28T09:00:00.000Z");
      expect(exceptionsFollowingStart(series, to.toISOString(), followStart(recurrence, start, to))).toEqual({
        skippedOccurrences: ["2032-02-28T09:00:00.000Z"],
      });
    });

    it("lines up the first months of series with several occurrences a month", () => {
      // Found in review: counted from each series' own start, the 15th was
      // January's second occurrence before the move and its first after,
      // so its skip found no counterpart and was dropped.
      const series = {
        startTime: "2027-01-01T09:00:00.000Z",
        recurrence: { freq: "MONTHLY" as const, interval: 1, byMonthDay: [1, 15] },
        skippedOccurrences: ["2027-01-15T09:00:00.000Z", "2027-02-15T09:00:00.000Z"],
      };
      expect(exceptionsFollowingStart(series, "2027-01-08T10:00:00.000Z")).toEqual({
        skippedOccurrences: ["2027-01-15T10:00:00.000Z", "2027-02-15T10:00:00.000Z"],
      });
    });

    it("reads a faster rule's calendar filters as expansion does", () => {
      // Raised in review: calendar filters on a daily rule don't move with
      // the start. But expansion drops them (the schema allows them only
      // on monthly and yearly rules), so the series is a plain daily one
      // and its skips move with the start like any other.
      const series = {
        startTime: "2027-01-01T09:00:00.000Z",
        recurrence: { freq: "DAILY" as const, interval: 1, byMonthDay: [1] },
        skippedOccurrences: ["2027-02-01T09:00:00.000Z"],
      };
      const changes = exceptionsFollowingStart(series, "2027-01-02T09:00:00.000Z");
      expect(changes).toEqual({ skippedOccurrences: ["2027-02-02T09:00:00.000Z"] });
      const moved = { ...series, ...changes, startTime: "2027-01-02T09:00:00.000Z" };
      expect(exceptionsOf(moved, "2027-01-31T00:00:00Z", "2027-02-04T00:00:00Z").skipped).toEqual([
        "2027-02-02T09:00:00.000Z",
      ]);
    });

    it("doesn't carry exceptions over a pattern deliberately changed to another kind", () => {
      // Found in review: "day 15" changed to "the third Tuesday" with the
      // start nudged a minute remapped every skip; without the nudge,
      // none. Neither is a move of the same pattern.
      const start = new Date("2026-09-15T09:00:00.000Z");
      const [date, nth] = ["date", "nth-weekday"].map(
        (key) => repeatPatterns("MONTHLY", start, "UTC").find((p) => p.key === key)!
      );
      const series = {
        startTime: start.toISOString(),
        recurrence: withPattern({ freq: "MONTHLY", interval: 1 }, date!.fields),
        skippedOccurrences: ["2026-10-15T09:00:00.000Z"],
      };
      const to = "2026-09-15T09:01:00.000Z";
      expect(exceptionsFollowingStart(series, to, withPattern(series.recurrence, nth!.fields))).toEqual({});
    });

    it("doesn't move a moved occurrence a day when the series is nudged across midnight", () => {
      // Found in review.
      const series = {
        startTime: "2027-01-01T00:30:00.000Z",
        recurrence: { freq: "DAILY" as const, interval: 1, tzid: "UTC" },
        occurrenceOverrides: [{ occurrence: "2027-01-10T00:30:00.000Z", startTime: "2027-01-10T10:00:00.000Z" }],
      };
      expect(exceptionsFollowingStart(series, "2026-12-31T23:30:00.000Z")).toEqual({
        occurrenceOverrides: [{ occurrence: "2027-01-09T23:30:00.000Z", startTime: "2027-01-10T10:00:00.000Z" }],
      });
    });

    it("keeps a fortnightly weekday series' exceptions in its weeks", () => {
      // Found in review: Friday 7 August moved to Monday the 10th puts the
      // series in the other weeks, so exceptions move a week.
      const series = {
        startTime: "2026-08-07T09:00:00.000Z",
        recurrence: { freq: "WEEKLY" as const, interval: 2, byDay: ["MO" as const, "FR" as const] },
        skippedOccurrences: ["2026-08-21T09:00:00.000Z"],
      };
      const changes = exceptionsFollowingStart(series, "2026-08-10T09:00:00.000Z");
      expect(changes).toEqual({ skippedOccurrences: ["2026-08-28T09:00:00.000Z"] });
      const moved = { ...series, ...changes, startTime: "2026-08-10T09:00:00.000Z" };
      expect(exceptionsOf(moved, "2026-08-01T00:00:00Z", "2026-09-10T00:00:00Z").skipped).toEqual([
        "2026-08-28T09:00:00.000Z",
      ]);
    });

    it("copes with an enormous skip list", () => {
      // Found in review: decrypted lists are unbounded, and spreading one
      // into Math.max overflows the stack.
      const skips = Array.from({ length: 150_000 }, (_, i) => new Date(Date.UTC(2027, 0, 1, 9) + i * 60_000).toISOString());
      const series = {
        startTime: "2027-01-01T09:00:00.000Z",
        recurrence: { freq: "MONTHLY" as const, interval: 1 },
        skippedOccurrences: skips,
      };
      expect(() => exceptionsFollowingStart(series, "2027-01-01T10:00:00.000Z")).not.toThrow();
    });

    it("keeps an exception it can't place where it doesn't apply", () => {
      // Found in review: dropping them lost the times a person chose for a
      // moved occurrence. Left as they are, they simply don't apply.
      const start = new Date("2026-01-31T09:00:00.000Z");
      const recurrence = withPattern({ freq: "MONTHLY", interval: 1, until: "2026-04-01T00:00:00.000Z" }, repeatPatterns("MONTHLY", start, "UTC")[0]!.fields);
      const series = {
        startTime: start.toISOString(),
        recurrence,
        // 1 March is no occurrence of "the 31st"; nor is 31 December after
        // the series ends.
        skippedOccurrences: ["2026-03-01T09:00:00.000Z", "not a date", "2026-03-31T09:00:00.000Z"],
        occurrenceOverrides: [{ occurrence: "2026-12-31T09:00:00.000Z", startTime: "2026-12-31T15:00:00.000Z" }],
      };
      const to = new Date("2026-01-30T09:00:00.000Z");
      expect(exceptionsFollowingStart(series, to.toISOString(), followStart(recurrence, start, to))).toEqual({
        skippedOccurrences: ["2026-03-01T09:00:00.000Z", "not a date", "2026-03-30T09:00:00.000Z"],
        occurrenceOverrides: series.occurrenceOverrides,
      });
    });
  });
});

describe("withOverride / withoutOverride / findOverride", () => {
  const at = new Date("2026-08-05T09:00:00.000Z");

  it("adds an override, and replaces it on a second move", () => {
    const once = withOverride(undefined, at, { startTime: "2026-08-05T15:00:00.000Z" });
    expect(once).toEqual([{ occurrence: at.toISOString(), startTime: "2026-08-05T15:00:00.000Z" }]);
    const twice = withOverride(once, at, {
      startTime: "2026-08-05T16:00:00.000Z",
      endTime: "2026-08-05T17:00:00.000Z",
    });
    expect(twice).toEqual([
      { occurrence: at.toISOString(), startTime: "2026-08-05T16:00:00.000Z", endTime: "2026-08-05T17:00:00.000Z" },
    ]);
  });

  it("finds and removes an override by instant, whatever its spelling", () => {
    const list = [{ occurrence: "2026-08-05T09:00:00Z", startTime: "2026-08-05T15:00:00.000Z" }];
    expect(findOverride(list, at)).toBe(list[0]);
    expect(withoutOverride(list, at)).toEqual([]);
    expect(findOverride(undefined, at)).toBeUndefined();
  });
});
