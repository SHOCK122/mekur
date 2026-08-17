import { describe, it, expect } from "vitest";
import {
  timeDeltaFromDrag,
  laneFromPointer,
  resizeEvent,
  moveEvent,
  rankForLane,
} from "../src/lib/timelineInteraction.js";
import type { Orientation, Viewport, Placement, Placeable } from "../src/lib/timeline.js";

const viewport: Viewport = { width: 1000, height: 400, laneSize: 25 };
const DAY_MS = 24 * 60 * 60 * 1000;

const horizForward: Orientation = { axis: "horizontal", direction: "forward", base: "bottom" };
const horizReverse: Orientation = { axis: "horizontal", direction: "reverse", base: "bottom" };
const vertForward: Orientation = { axis: "vertical", direction: "forward", base: "left" };
const vertReverse: Orientation = { axis: "vertical", direction: "reverse", base: "left" };

describe("timeDeltaFromDrag", () => {
  it("maps a rightward drag to later time in a forward horizontal layout", () => {
    // Half the width should be half the visible span.
    expect(timeDeltaFromDrag(500, 0, horizForward, viewport, DAY_MS)).toBeCloseTo(DAY_MS / 2);
  });

  it("maps a rightward drag to EARLIER time when the axis is reversed", () => {
    // The sign flip that makes reversed layouts feel right rather than
    // moving events opposite to the pointer.
    expect(timeDeltaFromDrag(500, 0, horizReverse, viewport, DAY_MS)).toBeCloseTo(-DAY_MS / 2);
  });

  it("uses the vertical axis when the timeline is vertical", () => {
    // Horizontal movement must be ignored entirely on a vertical axis.
    expect(timeDeltaFromDrag(999, 200, vertForward, viewport, DAY_MS)).toBeCloseTo(DAY_MS / 2);
    expect(timeDeltaFromDrag(999, 200, vertReverse, viewport, DAY_MS)).toBeCloseTo(-DAY_MS / 2);
  });

  it("returns zero rather than dividing by zero on an unmeasured viewport", () => {
    expect(timeDeltaFromDrag(100, 100, horizForward, { ...viewport, width: 0 }, DAY_MS)).toBe(0);
  });
});

describe("laneFromPointer", () => {
  it("counts lanes upward from a bottom base", () => {
    expect(laneFromPointer(0, 400, horizForward, viewport)).toBe(0);
    expect(laneFromPointer(0, 380, horizForward, viewport)).toBe(0);
    expect(laneFromPointer(0, 370, horizForward, viewport)).toBe(1);
  });

  it("counts lanes downward from a top base", () => {
    const topBase: Orientation = { ...horizForward, base: "top" };
    expect(laneFromPointer(0, 0, topBase, viewport)).toBe(0);
    expect(laneFromPointer(0, 30, topBase, viewport)).toBe(1);
  });

  it("counts lanes rightward from a left base", () => {
    expect(laneFromPointer(0, 0, vertForward, viewport)).toBe(0);
    expect(laneFromPointer(30, 0, vertForward, viewport)).toBe(1);
  });

  it("counts lanes leftward from a right base", () => {
    const rightBase: Orientation = { ...vertForward, base: "right" };
    expect(laneFromPointer(1000, 0, rightBase, viewport)).toBe(0);
    expect(laneFromPointer(970, 0, rightBase, viewport)).toBe(1);
  });

  it("never returns a negative lane when dragged past the base", () => {
    expect(laneFromPointer(0, 500, horizForward, viewport)).toBe(0);
  });
});

describe("resizeEvent", () => {
  const event = {
    startTime: "2026-08-01T10:00:00.000Z",
    endTime: "2026-08-01T11:00:00.000Z",
  };

  it("moves the start edge, changing duration rather than sliding the event", () => {
    const result = resizeEvent(event, "start", -30 * 60_000);
    expect(result.startTime).toBe("2026-08-01T09:30:00.000Z");
    expect(result.endTime).toBe("2026-08-01T11:00:00.000Z");
  });

  it("moves the end edge", () => {
    const result = resizeEvent(event, "end", 30 * 60_000);
    expect(result.endTime).toBe("2026-08-01T11:30:00.000Z");
    expect(result.startTime).toBe("2026-08-01T10:00:00.000Z");
  });

  it("refuses to drag the start past the end, keeping a minimum duration", () => {
    // Dragging far beyond the end must clamp, not invert the event.
    const result = resizeEvent(event, "start", 5 * 60 * 60_000);
    expect(new Date(result.startTime).getTime()).toBeLessThan(
      new Date(result.endTime!).getTime()
    );
    expect(new Date(result.endTime!).getTime() - new Date(result.startTime).getTime()).toBe(60_000);
  });

  it("refuses to drag the end before the start", () => {
    const result = resizeEvent(event, "end", -5 * 60 * 60_000);
    expect(new Date(result.endTime!).getTime()).toBeGreaterThan(
      new Date(result.startTime).getTime()
    );
  });

  it("keeps an open-ended event open when its start is dragged", () => {
    const open = { startTime: "2026-08-01T10:00:00.000Z", endTime: null };
    expect(resizeEvent(open, "start", 60_000).endTime).toBeNull();
  });

  it("gives an open-ended event a definite end when its end edge is dragged", () => {
    const open = { startTime: "2026-08-01T10:00:00.000Z", endTime: null };
    const result = resizeEvent(open, "end", 60 * 60_000);
    expect(result.endTime).not.toBeNull();
    expect(new Date(result.endTime!).getTime()).toBeGreaterThan(
      new Date(result.startTime).getTime()
    );
  });
});

describe("moveEvent", () => {
  it("slides both edges, preserving duration", () => {
    const result = moveEvent(
      { startTime: "2026-08-01T10:00:00.000Z", endTime: "2026-08-01T11:00:00.000Z" },
      60 * 60_000
    );
    expect(result.startTime).toBe("2026-08-01T11:00:00.000Z");
    expect(result.endTime).toBe("2026-08-01T12:00:00.000Z");
  });

  it("keeps an open-ended event open", () => {
    expect(moveEvent({ startTime: "2026-08-01T10:00:00.000Z", endTime: null }, 1000).endTime).toBeNull();
  });
});

describe("rankForLane", () => {
  function placement(id: string, lane: number, rank: string): Placement<Placeable> {
    return { item: { id, startMs: 0, endMs: 1000, rank }, lane };
  }

  it("returns a rank above the occupant when dragged beyond the top lane", () => {
    const placements = [placement("a", 0, "A"), placement("b", 1, "B")];
    const rank = rankForLane("moving", 5, placements);
    expect(rank).not.toBeNull();
    expect(rank! > "B").toBe(true);
  });

  it("returns a rank below the occupant when dragged to the base", () => {
    const placements = [placement("a", 1, "B"), placement("b", 2, "C")];
    const rank = rankForLane("moving", 0, placements);
    expect(rank! < "B").toBe(true);
  });

  it("returns a rank between the neighbours of the target lane", () => {
    const placements = [placement("a", 0, "A"), placement("b", 1, "C"), placement("c", 2, "E")];
    const rank = rankForLane("moving", 1, placements);
    expect(rank! > "A").toBe(true);
    expect(rank! < "C").toBe(true);
  });

  it("ignores the moving event's own placement", () => {
    // Otherwise an event would try to rank itself relative to itself.
    const placements = [placement("moving", 0, "A"), placement("other", 1, "C")];
    const rank = rankForLane("moving", 2, placements);
    expect(rank! > "C").toBe(true);
  });

  it("returns null when there is nothing to rank against", () => {
    expect(rankForLane("moving", 0, [])).toBeNull();
    expect(rankForLane("moving", 0, [placement("moving", 0, "A")])).toBeNull();
  });

  it("produces a rank that actually sorts into the requested position", () => {
    // The real test: apply the result and confirm the ordering is what the
    // drag asked for.
    const placements = [placement("a", 0, "A"), placement("b", 1, "C"), placement("c", 2, "E")];
    const rank = rankForLane("moving", 2, placements)!;
    const sorted = [...placements.map((p) => p.item.rank), rank].sort();
    expect(sorted.indexOf(rank)).toBe(2);
  });
});
