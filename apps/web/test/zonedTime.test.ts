import { describe, it, expect } from "vitest";
import { instantFromWallClock, wallClockAsUtc } from "../src/lib/zonedTime.js";

describe("wallClockAsUtc / instantFromWallClock", () => {
  it("reads the wall clock in a zone", () => {
    // 22:00 UTC on Sunday is 09:00 on Monday in Sydney (UTC+11 in summer).
    expect(wallClockAsUtc(new Date("2026-01-04T22:00:00Z"), "Australia/Sydney").toISOString()).toBe(
      "2026-01-05T09:00:00.000Z"
    );
  });

  it("round-trips ordinary times", () => {
    const instant = new Date("2026-07-14T13:45:30.250Z");
    for (const tz of ["America/New_York", "Asia/Kolkata", "Pacific/Chatham", "UTC"]) {
      expect(instantFromWallClock(wallClockAsUtc(instant, tz), tz).toISOString()).toBe(instant.toISOString());
    }
  });

  it("follows daylight-saving changes", () => {
    // 09:00 in New York is 14:00 UTC in winter and 13:00 UTC in summer.
    expect(instantFromWallClock(new Date("2026-01-05T09:00:00Z"), "America/New_York").toISOString()).toBe(
      "2026-01-05T14:00:00.000Z"
    );
    expect(instantFromWallClock(new Date("2026-07-06T09:00:00Z"), "America/New_York").toISOString()).toBe(
      "2026-07-06T13:00:00.000Z"
    );
  });

  it("moves a reading inside a spring-forward gap past the gap", () => {
    // New York skips 02:00-03:00 on 2026-03-08; 02:30 becomes 03:30 EDT.
    expect(instantFromWallClock(new Date("2026-03-08T02:30:00Z"), "America/New_York").toISOString()).toBe(
      "2026-03-08T07:30:00.000Z"
    );
  });

  it("resolves a reading that happens twice to the earlier one", () => {
    // 01:30 happens twice on 2026-11-01 in New York: EDT first (05:30 UTC).
    expect(instantFromWallClock(new Date("2026-11-01T01:30:00Z"), "America/New_York").toISOString()).toBe(
      "2026-11-01T05:30:00.000Z"
    );
  });
});
