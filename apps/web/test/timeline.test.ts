import { describe, it, expect } from "vitest";
import {
  TIME_SCALES,
  DEFAULT_SCALE_INDEX,
  snapToScale,
  zoomSpan,
  timeFraction,
  rectFor,
  assignLanes,
  laneCount,
  validBases,
  isValidOrientation,
  DEFAULT_ORIENTATION,
  type Orientation,
  type Viewport,
} from "../src/lib/timeline.js";

const viewport: Viewport = { width: 1000, height: 400, laneSize: 24 };

describe("time scales", () => {
  it("is strictly ascending, so zooming is monotonic", () => {
    for (let i = 1; i < TIME_SCALES.length; i++) {
      expect(TIME_SCALES[i]!.seconds).toBeGreaterThan(TIME_SCALES[i - 1]!.seconds);
    }
  });

  it("defaults to a one-day view", () => {
    expect(TIME_SCALES[DEFAULT_SCALE_INDEX]!.label).toBe("1 day");
  });

  it("spans one minute to thirteen years", () => {
    expect(TIME_SCALES[0]!.label).toBe("1 minute");
    expect(TIME_SCALES[TIME_SCALES.length - 1]!.label).toBe("13 years");
  });

  it("snaps an arbitrary span to the nearest human-significant one", () => {
    expect(snapToScale(50 * 60).label).toBe("1 hour"); // 50 min -> 1 hour
    expect(snapToScale(25 * 60 * 60).label).toBe("1 day"); // 25 h -> 1 day
    expect(snapToScale(8 * 24 * 60 * 60).label).toBe("1 week"); // 8 d -> 1 week
  });

  it("clamps beyond either end rather than failing", () => {
    expect(snapToScale(0.001).label).toBe("1 minute");
    expect(snapToScale(1e12).label).toBe("13 years");
  });

  it("zooms continuously but stays within the supported range", () => {
    const day = 24 * 60 * 60;
    expect(zoomSpan(day, 2)).toBe(2 * day);
    expect(zoomSpan(day, 0.5)).toBe(day / 2);
    // Clamped at both ends.
    expect(zoomSpan(60, 0.0001)).toBe(TIME_SCALES[0]!.seconds);
    expect(zoomSpan(1e11, 1000)).toBe(TIME_SCALES[TIME_SCALES.length - 1]!.seconds);
  });
});

describe("orientation validity", () => {
  it("only allows a base perpendicular to the time axis", () => {
    // A base parallel to time would make events stack along time itself.
    expect(validBases("horizontal")).toEqual(["bottom", "top"]);
    expect(validBases("vertical")).toEqual(["left", "right"]);
    expect(isValidOrientation(DEFAULT_ORIENTATION)).toBe(true);
    expect(isValidOrientation({ axis: "horizontal", direction: "forward", base: "left" })).toBe(false);
  });
});

describe("timeFraction", () => {
  const start = new Date("2026-01-01T00:00:00.000Z");
  const end = new Date("2026-01-02T00:00:00.000Z");

  it("maps the window onto 0..1", () => {
    expect(timeFraction(start, start, end)).toBe(0);
    expect(timeFraction(end, start, end)).toBe(1);
    expect(timeFraction(new Date("2026-01-01T12:00:00.000Z"), start, end)).toBeCloseTo(0.5);
  });

  it("returns values outside 0..1 for moments off-screen, rather than clamping", () => {
    // An event can start before the window and end inside it; callers need
    // the real value to draw the visible portion.
    expect(timeFraction(new Date("2025-12-31T12:00:00.000Z"), start, end)).toBeLessThan(0);
    expect(timeFraction(new Date("2026-01-03T00:00:00.000Z"), start, end)).toBeGreaterThan(1);
  });
});

describe("rectFor: horizontal, base bottom (the default)", () => {
  const orientation = DEFAULT_ORIENTATION;

  it("places time along x and stacks upward from the bottom", () => {
    const lane0 = rectFor(0.25, 0.5, 0, orientation, viewport);
    expect(lane0.left).toBe(250);
    expect(lane0.width).toBe(250);
    // Lane 0 sits against the bottom edge.
    expect(lane0.top).toBe(400 - 24);

    const lane1 = rectFor(0.25, 0.5, 1, orientation, viewport);
    expect(lane1.top).toBe(400 - 48);
    // Higher lane means further from the base, i.e. visually higher.
    expect(lane1.top).toBeLessThan(lane0.top);
  });
});

describe("rectFor: the other orientations", () => {
  it("horizontal with base top stacks downward instead", () => {
    const orientation: Orientation = { axis: "horizontal", direction: "forward", base: "top" };
    expect(rectFor(0, 0.5, 0, orientation, viewport).top).toBe(0);
    expect(rectFor(0, 0.5, 1, orientation, viewport).top).toBe(24);
  });

  it("reversed horizontal puts the future on the left", () => {
    const forward: Orientation = DEFAULT_ORIENTATION;
    const reverse: Orientation = { ...DEFAULT_ORIENTATION, direction: "reverse" };
    const early = rectFor(0, 0.25, 0, forward, viewport);
    const earlyReversed = rectFor(0, 0.25, 0, reverse, viewport);
    // The same early span sits at the left when forward, the right when
    // reversed -- and keeps the same width either way.
    expect(early.left).toBe(0);
    expect(earlyReversed.left).toBe(750);
    expect(earlyReversed.width).toBeCloseTo(early.width);
  });

  it("vertical with base left runs time down the screen and stacks rightward", () => {
    const orientation: Orientation = { axis: "vertical", direction: "forward", base: "left" };
    const rect = rectFor(0.25, 0.5, 0, orientation, viewport);
    expect(rect.top).toBe(100);
    expect(rect.height).toBe(100);
    expect(rect.left).toBe(0);
    expect(rectFor(0.25, 0.5, 1, orientation, viewport).left).toBe(24);
  });

  it("vertical with base right stacks leftward from the right edge", () => {
    const orientation: Orientation = { axis: "vertical", direction: "forward", base: "right" };
    expect(rectFor(0, 1, 0, orientation, viewport).left).toBe(1000 - 24);
    expect(rectFor(0, 1, 1, orientation, viewport).left).toBe(1000 - 48);
  });

  it("never produces a negative extent, in any orientation", () => {
    const orientations: Orientation[] = [
      { axis: "horizontal", direction: "forward", base: "bottom" },
      { axis: "horizontal", direction: "reverse", base: "top" },
      { axis: "vertical", direction: "forward", base: "left" },
      { axis: "vertical", direction: "reverse", base: "right" },
    ];
    for (const orientation of orientations) {
      const rect = rectFor(0.2, 0.8, 2, orientation, viewport);
      expect(rect.width).toBeGreaterThanOrEqual(0);
      expect(rect.height).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("assignLanes", () => {
  const VIEW_END = 1_000_000;

  it("puts non-overlapping events all in the base lane", () => {
    const placements = assignLanes(
      [
        { id: "a", startMs: 0, endMs: 100, rank: "A" },
        { id: "b", startMs: 200, endMs: 300, rank: "B" },
        { id: "c", startMs: 400, endMs: 500, rank: "C" },
      ],
      VIEW_END
    );
    expect(placements.every((p) => p.lane === 0)).toBe(true);
    expect(laneCount(placements)).toBe(1);
  });

  it("gives overlapping events distinct lanes", () => {
    const placements = assignLanes(
      [
        { id: "a", startMs: 0, endMs: 500, rank: "A" },
        { id: "b", startMs: 100, endMs: 600, rank: "B" },
        { id: "c", startMs: 200, endMs: 700, rank: "C" },
      ],
      VIEW_END
    );
    expect(new Set(placements.map((p) => p.lane)).size).toBe(3);
  });

  it("stacks higher-ranked events further from the base", () => {
    // This is what "highest priority on top" means mechanically.
    const placements = assignLanes(
      [
        { id: "low", startMs: 0, endMs: 500, rank: "A" },
        { id: "high", startMs: 0, endMs: 500, rank: "Z" },
      ],
      VIEW_END
    );
    const low = placements.find((p) => p.item.id === "low")!;
    const high = placements.find((p) => p.item.id === "high")!;
    expect(high.lane).toBeGreaterThan(low.lane);
  });

  it("reuses a lane once it is free again", () => {
    const placements = assignLanes(
      [
        { id: "a", startMs: 0, endMs: 100, rank: "A" },
        { id: "b", startMs: 50, endMs: 150, rank: "B" },
        { id: "c", startMs: 200, endMs: 300, rank: "C" },
      ],
      VIEW_END
    );
    // c starts after a ends, so it can sit back in lane 0.
    expect(placements.find((p) => p.item.id === "c")!.lane).toBe(0);
    expect(laneCount(placements)).toBe(2);
  });

  it("treats an open-ended event as running to the end of the view", () => {
    const placements = assignLanes(
      [
        { id: "openEnded", startMs: 0, endMs: null, rank: "A" },
        { id: "later", startMs: 500, endMs: 600, rank: "B" },
      ],
      VIEW_END
    );
    // The open-ended event still occupies its lane for the whole window,
    // so the later event must go elsewhere rather than colliding.
    expect(placements.find((p) => p.item.id === "later")!.lane).toBe(1);
  });

  it("separates events that merely look adjacent, so labels can't collide", () => {
    const touching = [
      { id: "a", startMs: 0, endMs: 100, rank: "A" },
      { id: "b", startMs: 100, endMs: 200, rank: "B" },
    ];
    // With no separation they can share a lane...
    expect(laneCount(assignLanes(touching, VIEW_END, 0))).toBe(1);
    // ...but reserving label width forces them apart.
    expect(laneCount(assignLanes(touching, VIEW_END, 50))).toBe(2);
  });

  it("is deterministic: the same input always lays out identically", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      id: `e${i}`,
      startMs: i * 10,
      endMs: i * 10 + 400,
      rank: String.fromCharCode(65 + (i % 26)) + i,
    }));
    const first = assignLanes(items, VIEW_END).map((p) => `${p.item.id}:${p.lane}`);
    const second = assignLanes([...items].reverse(), VIEW_END).map((p) => `${p.item.id}:${p.lane}`);
    // Input order must not affect the result, or the layout would shuffle
    // between reloads.
    expect(second).toEqual(first);
  });

  it("handles a large overlapping set without collapsing lanes", () => {
    const items = Array.from({ length: 200 }, (_, i) => ({
      id: `e${i}`,
      startMs: 0,
      endMs: 1000,
      rank: `r${String(i).padStart(4, "0")}`,
    }));
    const placements = assignLanes(items, VIEW_END);
    // All 200 mutually overlap, so each needs its own lane -- this is the
    // density that forces the stack axis to scroll.
    expect(laneCount(placements)).toBe(200);
    expect(new Set(placements.map((p) => p.lane)).size).toBe(200);
  });
});
