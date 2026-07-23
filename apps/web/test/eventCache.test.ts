import { describe, it, expect, beforeEach } from "vitest";
import { saveEventCache, loadEventCache } from "../src/lib/eventCache.js";

describe("eventCache", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when nothing has been cached for a user", () => {
    expect(loadEventCache("user-1")).toBeNull();
  });

  it("round-trips a saved event list", () => {
    const events = [
      { id: "e1", title: "Standup", startTime: "2026-08-01T09:00:00.000Z", endTime: "2026-08-01T09:15:00.000Z", priority: 0 },
    ];
    saveEventCache("user-1", events);
    expect(loadEventCache("user-1")).toEqual(events);
  });

  it("keeps caches for different users separate", () => {
    saveEventCache("user-1", [{ id: "a", title: "A", startTime: "t", endTime: "t", priority: 0 }]);
    saveEventCache("user-2", [{ id: "b", title: "B", startTime: "t", endTime: "t", priority: 0 }]);
    expect(loadEventCache("user-1")?.[0].title).toBe("A");
    expect(loadEventCache("user-2")?.[0].title).toBe("B");
  });
});
