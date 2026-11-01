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
  occupiedUntil,
  estimateLabelSize,
  laneSizeFor,
  laneInset,
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

  it("an extended rectangle runs from its lane to the base, whichever edge that is", () => {
    // Regression: with the base at the top, the extended rectangle started
    // at its lane and ran *away* from the base.
    const bases: Orientation[] = [
      { axis: "horizontal", direction: "forward", base: "bottom" },
      { axis: "horizontal", direction: "forward", base: "top" },
      { axis: "vertical", direction: "forward", base: "left" },
      { axis: "vertical", direction: "forward", base: "right" },
    ];
    for (const orientation of bases) {
      const lane = rectFor(0.2, 0.8, 2, orientation, viewport);
      const extended = rectFor(0.2, 0.8, 2, orientation, viewport, true);
      if (orientation.axis === "horizontal") {
        expect(extended.height).toBe(72);
        // Covers its own lane...
        expect(extended.top).toBeLessThanOrEqual(lane.top);
        expect(extended.top + extended.height).toBeGreaterThanOrEqual(lane.top + lane.height);
        // ...and touches the base.
        expect(orientation.base === "top" ? extended.top : extended.top + extended.height).toBe(
          orientation.base === "top" ? 0 : viewport.height
        );
      } else {
        expect(extended.width).toBe(72);
        expect(extended.left).toBeLessThanOrEqual(lane.left);
        expect(extended.left + extended.width).toBeGreaterThanOrEqual(lane.left + lane.width);
        expect(orientation.base === "left" ? extended.left : extended.left + extended.width).toBe(
          orientation.base === "left" ? 0 : viewport.width
        );
      }
    }
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

  it("keeps a lane taken until a name longer than its event has finished", () => {
    const items = [
      // A 100ms event whose name needs 400ms of screen.
      { id: "a", startMs: 0, endMs: 100, rank: "A", labelMs: 400 },
      { id: "b", startMs: 200, endMs: 300, rank: "B", labelMs: 50 },
    ];
    expect(laneCount(assignLanes(items, VIEW_END))).toBe(2);
    // Once b starts after the name, it can share the lane again.
    const later = [items[0]!, { ...items[1]!, startMs: 450, endMs: 500 }];
    expect(laneCount(assignLanes(later, VIEW_END))).toBe(1);
  });

  it("doesn't reserve room beyond the gap when the event outlasts its name", () => {
    const items = [
      { id: "a", startMs: 0, endMs: 1000, rank: "A", labelMs: 50 },
      { id: "b", startMs: 1010, endMs: 2000, rank: "B", labelMs: 50 },
    ];
    expect(laneCount(assignLanes(items, VIEW_END, 10))).toBe(1);
    expect(laneCount(assignLanes(items, VIEW_END, 11))).toBe(2);
  });

  it("never lets two labels in one lane overlap, however the names and times fall", () => {
    // Pseudo-random but deterministic: a mix of short events with long
    // names, long events with short names, and open-ended ones.
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const items = Array.from({ length: 300 }, (_, i) => {
      const startMs = Math.floor(random() * 50_000);
      return {
        id: `e${i}`,
        startMs,
        endMs: random() < 0.1 ? null : startMs + Math.floor(random() * 3000),
        rank: `r${String(Math.floor(random() * 1e6)).padStart(7, "0")}${i}`,
        labelMs: Math.floor(random() * 4000),
      };
    });
    const gap = 25;
    const placements = assignLanes(items, 60_000, gap);
    const byLane = new Map<number, typeof items>();
    for (const { item, lane } of placements) {
      byLane.set(lane, [...(byLane.get(lane) ?? []), item]);
    }
    for (const inLane of byLane.values()) {
      const sorted = [...inLane].sort((a, b) => a.startMs - b.startMs);
      for (let i = 1; i < sorted.length; i++) {
        // The earlier item -- its fill and its name -- is over, plus the
        // gap, before the next one starts.
        expect(sorted[i]!.startMs).toBeGreaterThanOrEqual(occupiedUntil(sorted[i - 1]!, 60_000, gap));
      }
    }
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

describe("occupiedUntil", () => {
  it("is the later of the event's end and its label's end, plus the gap", () => {
    expect(occupiedUntil({ id: "a", startMs: 0, endMs: 100, rank: "A", labelMs: 300 }, 1000, 5)).toBe(305);
    expect(occupiedUntil({ id: "a", startMs: 0, endMs: 500, rank: "A", labelMs: 300 }, 1000, 5)).toBe(505);
    expect(occupiedUntil({ id: "a", startMs: 0, endMs: null, rank: "A", labelMs: 300 }, 1000)).toBe(1000);
    expect(occupiedUntil({ id: "a", startMs: 0, endMs: 100, rank: "A" }, 1000)).toBe(100);
  });
});

describe("estimateLabelSize", () => {
  it("grows with the name, and with the text size", () => {
    const short = estimateLabelSize("Lunch", false, 16);
    const long = estimateLabelSize("Quarterly planning with the whole team", false, 16);
    expect(long.along).toBeGreaterThan(short.along * 4);
    expect(long.across).toBe(short.across);
    const enlarged = estimateLabelSize("Lunch", false, 32);
    expect(enlarged.along).toBeGreaterThanOrEqual(short.along * 2 - 1);
    expect(enlarged.across).toBeGreaterThanOrEqual(short.across * 2 - 1);
  });

  it("allows for the bolder text and star of an important event", () => {
    expect(estimateLabelSize("Lunch", true, 16).along).toBeGreaterThan(
      estimateLabelSize("Lunch", false, 16).along
    );
  });

  it("gives an untitled event room for its square", () => {
    expect(estimateLabelSize(undefined, false, 16).along).toBeGreaterThan(0);
    expect(estimateLabelSize("   ", false, 16)).toEqual(estimateLabelSize(undefined, false, 16));
  });
});

describe("laneSizeFor", () => {
  it("is the minimum unless a label is thicker", () => {
    expect(laneSizeFor([20, 21], 28)).toBe(28);
    expect(laneSizeFor([20, 40.2], 28)).toBe(41);
    expect(laneSizeFor([], 28)).toBe(28);
    expect(laneSizeFor([NaN], 28)).toBe(28);
  });
});

describe("laneInset", () => {
  it("puts the label in its own lane, not at the base", () => {
    // Regression: with the base on the left, every label sat at the base
    // (x = 0) whatever its lane, so overlapping events' names overlapped.
    const left: Orientation = { axis: "vertical", direction: "forward", base: "left" };
    expect(laneInset(0, left, viewport)).toEqual({ property: "left", px: 0 });
    expect(laneInset(3, left, viewport)).toEqual({ property: "left", px: 72 });
    const top: Orientation = { axis: "horizontal", direction: "reverse", base: "top" };
    expect(laneInset(3, top, viewport)).toEqual({ property: "top", px: 72 });
    // With the base at the bottom or right, the extended rectangle's near
    // edge already is the lane.
    expect(laneInset(3, DEFAULT_ORIENTATION, viewport)).toEqual({ property: "top", px: 0 });
    const right: Orientation = { axis: "vertical", direction: "forward", base: "right" };
    expect(laneInset(3, right, viewport)).toEqual({ property: "left", px: 0 });
  });
});
