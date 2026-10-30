import { describe, it, expect } from "vitest";
import {
  timeDeltaFromDrag,
  laneFromPointer,
  resizeEvent,
  moveEvent,
  rankForLane,
  keyboardAdjustment,
  keyboardStepMs,
  rankStep,
  panToKeepInView,
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

describe("keyboardAdjustment", () => {
  const none = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };
  const shift = { ...none, shiftKey: true };
  const altShift = { ...none, shiftKey: true, altKey: true };

  it("moves along the time axis in the direction the event would visibly travel", () => {
    expect(keyboardAdjustment("ArrowRight", none, horizForward)).toEqual({ kind: "move", direction: 1 });
    expect(keyboardAdjustment("ArrowLeft", none, horizForward)).toEqual({ kind: "move", direction: -1 });
    // Reversed axis: right is the past, the same sign flip as dragging.
    expect(keyboardAdjustment("ArrowRight", none, horizReverse)).toEqual({ kind: "move", direction: -1 });
    // Vertical forward: down is later; reversed, up is later.
    expect(keyboardAdjustment("ArrowDown", none, vertForward)).toEqual({ kind: "move", direction: 1 });
    expect(keyboardAdjustment("ArrowUp", none, vertReverse)).toEqual({ kind: "move", direction: 1 });
  });

  it("resizes the end with Shift and the start with Alt+Shift", () => {
    expect(keyboardAdjustment("ArrowRight", shift, horizForward)).toEqual({
      kind: "resize",
      edge: "end",
      direction: 1,
    });
    expect(keyboardAdjustment("ArrowLeft", altShift, horizForward)).toEqual({
      kind: "resize",
      edge: "start",
      direction: -1,
    });
  });

  it("re-ranks across the axis: away from the base raises priority", () => {
    expect(keyboardAdjustment("ArrowUp", none, horizForward)).toEqual({ kind: "rank", direction: 1 });
    expect(keyboardAdjustment("ArrowDown", none, horizForward)).toEqual({ kind: "rank", direction: -1 });
    expect(keyboardAdjustment("ArrowDown", none, { ...horizForward, base: "top" })).toEqual({
      kind: "rank",
      direction: 1,
    });
    expect(keyboardAdjustment("ArrowRight", none, vertForward)).toEqual({ kind: "rank", direction: 1 });
    expect(keyboardAdjustment("ArrowLeft", none, { ...vertForward, base: "right" })).toEqual({
      kind: "rank",
      direction: 1,
    });
  });

  it("leaves other keys and browser shortcuts alone", () => {
    expect(keyboardAdjustment("Enter", none, horizForward)).toBeNull();
    expect(keyboardAdjustment("ArrowRight", { ...none, ctrlKey: true }, horizForward)).toBeNull();
    expect(keyboardAdjustment("ArrowRight", { ...none, metaKey: true }, horizForward)).toBeNull();
    // Alt+Left/Right is browser history navigation.
    expect(keyboardAdjustment("ArrowLeft", { ...none, altKey: true }, horizForward)).toBeNull();
    expect(keyboardAdjustment("ArrowUp", shift, horizForward)).toBeNull();
  });
});

describe("keyboardStepMs", () => {
  it("steps by a round amount scaled to the zoom level", () => {
    expect(keyboardStepMs(DAY_MS)).toBe(15 * 60_000);
    expect(keyboardStepMs(60 * 60_000)).toBe(30_000);
    expect(keyboardStepMs(7 * DAY_MS)).toBe(60 * 60_000);
  });

  it("never steps by less than a second", () => {
    expect(keyboardStepMs(60_000)).toBe(1000);
    expect(keyboardStepMs(0)).toBe(1000);
  });
});

describe("rankStep", () => {
  function item(id: string, rank: string, startMs = 0, endMs: number | null = 1000): Placeable {
    return { id, startMs, endMs, rank };
  }

  it("raises an event above the next-higher event it overlaps", () => {
    const items = [item("me", "B"), item("other", "D"), item("top", "F")];
    const result = rankStep("me", 1, items, 10_000)!;
    expect(result.past.id).toBe("other");
    expect(result.rank > "D").toBe(true);
    expect(result.rank < "F").toBe(true);
  });

  it("lowers an event below the next-lower event it overlaps", () => {
    const items = [item("bottom", "A"), item("other", "C"), item("me", "E")];
    const result = rankStep("me", -1, items, 10_000)!;
    expect(result.past.id).toBe("other");
    expect(result.rank > "A").toBe(true);
    expect(result.rank < "C").toBe(true);
  });

  it("skips events it doesn't overlap, since passing them changes nothing visible", () => {
    const items = [item("me", "B"), item("elsewhere", "C", 5000, 6000), item("other", "D")];
    const result = rankStep("me", 1, items, 10_000)!;
    expect(result.past.id).toBe("other");
    // Still unique: strictly between D and anything ranked above it.
    expect(result.rank > "D").toBe(true);
  });

  it("does not collide with the rank of a non-overlapping event", () => {
    const items = [item("me", "A"), item("other", "C"), item("elsewhere", "E", 5000, 6000)];
    const result = rankStep("me", 1, items, 10_000)!;
    expect(result.rank > "C" && result.rank < "E").toBe(true);
  });

  it("counts label separation as overlap, matching lane assignment", () => {
    const items = [item("me", "A", 0, 1000), item("next", "B", 1500, 2000)];
    expect(rankStep("me", 1, items, 10_000, 0)).toBeNull();
    expect(rankStep("me", 1, items, 10_000, 1000)!.past.id).toBe("next");
  });

  it("treats open-ended events as running to the end of the view", () => {
    const items = [item("me", "A", 0, null), item("later", "B", 8000, 9000)];
    expect(rankStep("me", 1, items, 10_000)!.past.id).toBe("later");
  });

  it("returns null when there is nothing to pass", () => {
    expect(rankStep("me", 1, [item("me", "Z"), item("below", "A")], 10_000)).toBeNull();
    expect(rankStep("me", -1, [item("me", "A"), item("above", "Z")], 10_000)).toBeNull();
    expect(rankStep("missing", 1, [item("a", "A")], 10_000)).toBeNull();
  });
});

describe("panToKeepInView", () => {
  const view = { startMs: 0, endMs: 10_000 };

  it("leaves the view alone while the changed edge stays inside the margin", () => {
    expect(panToKeepInView(view, { startMs: 5000, endMs: 6000 }, { before: 4000, after: 5000 }, 500)).toBe(0);
  });

  it("follows an edge moving past the later margin", () => {
    // 9600 is 100ms beyond the 9500 margin, so the view moves 100ms later.
    expect(panToKeepInView(view, { startMs: 9600, endMs: 9900 }, { before: 9300, after: 9600 }, 500)).toBe(100);
  });

  it("follows an edge moving past the earlier margin", () => {
    expect(panToKeepInView(view, { startMs: 200, endMs: 900 }, { before: 600, after: 200 }, 500)).toBe(-300);
  });

  it("never pans against the direction the edge moved", () => {
    // Inside the earlier margin but moving later: no jump backwards.
    expect(panToKeepInView(view, { startMs: 300, endMs: 900 }, { before: 100, after: 300 }, 500)).toBe(0);
    expect(panToKeepInView(view, { startMs: 9700, endMs: 9900 }, { before: 9900, after: 9700 }, 500)).toBe(0);
  });

  it("does not jump to an off-screen edge of an event that is still visible", () => {
    // A long event that started before the view, moved later: its start is
    // still off screen but the event still covers the view.
    expect(panToKeepInView(view, { startMs: -4000, endMs: 20_000 }, { before: -5000, after: -4000 }, 500)).toBe(0);
  });

  it("steps in when an event whose edge was off screen would leave the view", () => {
    // Moved earlier until its end is about to cross the view's start.
    expect(panToKeepInView(view, { startMs: -9000, endMs: 100 }, { before: -8000, after: -9000 }, 500)).toBe(-400);
    // An open-ended event never leaves by the earlier side.
    expect(panToKeepInView(view, { startMs: -9000, endMs: null }, { before: -8000, after: -9000 }, 500)).toBe(0);
  });

  it("brings back an event that would leave with no edge to follow", () => {
    expect(panToKeepInView(view, { startMs: 9800, endMs: null }, null, 500)).toBe(300);
  });

  it("caps the margin at a quarter of the view, so a wide label can't overshoot", () => {
    expect(panToKeepInView(view, { startMs: 8000, endMs: 9000 }, { before: 7000, after: 8000 }, 50_000)).toBe(500);
  });
});
