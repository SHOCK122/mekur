/**
 * Timeline layout. Everything here is pure: given a time window, an
 * orientation and a set of occurrences, it returns positions. No DOM, no
 * React, so the geometry can be tested without rendering anything.
 */

// ---------------------------------------------------------------------------
// Zoom scales
// ---------------------------------------------------------------------------

export interface TimeScale {
  label: string;
  seconds: number;
}

const SECOND = 1;
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
// Calendar months and years vary in length. These are averages used purely
// for choosing a zoom level -- actual occurrence times always come from the
// real calendar via the recurrence rules, never from these constants.
const MONTH = 30.436875 * DAY;
const YEAR = 365.2425 * DAY;

/**
 * Human-significant spans, ascending. Deliberately a plain data table so
 * the range can be extended in either direction without touching any
 * logic -- the requirement is to reach far smaller and far larger scales
 * later, and nothing here assumes these particular bounds.
 */
export const TIME_SCALES: TimeScale[] = [
  { label: "1 minute", seconds: MINUTE },
  { label: "5 minutes", seconds: 5 * MINUTE },
  { label: "15 minutes", seconds: 15 * MINUTE },
  { label: "30 minutes", seconds: 30 * MINUTE },
  { label: "1 hour", seconds: HOUR },
  { label: "3 hours", seconds: 3 * HOUR },
  { label: "6 hours", seconds: 6 * HOUR },
  { label: "12 hours", seconds: 12 * HOUR },
  { label: "1 day", seconds: DAY },
  { label: "3 days", seconds: 3 * DAY },
  { label: "1 week", seconds: WEEK },
  { label: "2 weeks", seconds: 2 * WEEK },
  { label: "1 month", seconds: MONTH },
  { label: "3 months", seconds: 3 * MONTH },
  { label: "6 months", seconds: 6 * MONTH },
  { label: "1 year", seconds: YEAR },
  { label: "2 years", seconds: 2 * YEAR },
  { label: "5 years", seconds: 5 * YEAR },
  { label: "13 years", seconds: 13 * YEAR },
];

export const DEFAULT_SCALE_INDEX = TIME_SCALES.findIndex((s) => s.seconds === DAY);

/** Nearest human-significant scale to an arbitrary span, by ratio rather
 * than absolute difference -- at these magnitudes "twice as long" matters
 * far more than "a million seconds longer". */
export function snapToScale(spanSeconds: number): TimeScale {
  if (spanSeconds <= TIME_SCALES[0]!.seconds) return TIME_SCALES[0]!;
  const last = TIME_SCALES[TIME_SCALES.length - 1]!;
  if (spanSeconds >= last.seconds) return last;

  let best = TIME_SCALES[0]!;
  let bestRatio = Infinity;
  for (const scale of TIME_SCALES) {
    const ratio = spanSeconds > scale.seconds
      ? spanSeconds / scale.seconds
      : scale.seconds / spanSeconds;
    if (ratio < bestRatio) {
      bestRatio = ratio;
      best = scale;
    }
  }
  return best;
}

/** Continuous zoom: multiplies the current span, then snaps. Kept separate
 * from snapToScale so a future free-zoom mode can skip the snapping. */
export function zoomSpan(currentSeconds: number, factor: number): number {
  const smallest = TIME_SCALES[0]!.seconds;
  const largest = TIME_SCALES[TIME_SCALES.length - 1]!.seconds;
  return Math.min(largest, Math.max(smallest, currentSeconds * factor));
}

// ---------------------------------------------------------------------------
// Orientation
// ---------------------------------------------------------------------------

export type Axis = "horizontal" | "vertical";
/** "forward" puts the past at the start of the axis (left, or top). */
export type TimeDirection = "forward" | "reverse";
/** Which edge events stack away from. */
export type BaseEdge = "bottom" | "top" | "left" | "right";

export interface Orientation {
  axis: Axis;
  direction: TimeDirection;
  base: BaseEdge;
}

export const DEFAULT_ORIENTATION: Orientation = {
  axis: "horizontal",
  direction: "forward",
  base: "bottom",
};

/** Base edges that make sense for each axis: the base must be
 * perpendicular to the time axis, or events would stack along time. */
export function validBases(axis: Axis): BaseEdge[] {
  return axis === "horizontal" ? ["bottom", "top"] : ["left", "right"];
}

export function isValidOrientation(orientation: Orientation): boolean {
  return validBases(orientation.axis).includes(orientation.base);
}

// ---------------------------------------------------------------------------
// Positioning
// ---------------------------------------------------------------------------

export interface Viewport {
  width: number;
  height: number;
  /** Thickness of one stack lane, along the axis perpendicular to time. */
  laneSize: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where a moment sits along the time axis, as a 0..1 fraction. Values
 * outside that range mean the moment is off-screen, which callers may
 * still want (an event can start before the window and end inside it). */
export function timeFraction(at: Date, viewStart: Date, viewEnd: Date): number {
  const span = viewEnd.getTime() - viewStart.getTime();
  if (span <= 0) return 0;
  return (at.getTime() - viewStart.getTime()) / span;
}

/**
 * Converts a time span and a lane index into a rectangle.
 *
 * `lane` 0 sits against the base; higher lanes are further from it. Under
 * fractional ordering, higher-ranked (more important) events get higher
 * lanes, which is what "highest priority on top relative to the base"
 * means in every orientation.
 */
export function rectFor(
  startFraction: number,
  endFraction: number,
  lane: number,
  orientation: Orientation,
  viewport: Viewport,
  /** When true the rectangle runs from its lane all the way to the base,
   * rather than occupying one lane's thickness. The fade then has the full
   * distance to reach zero exactly at the base. */
  extendToBase = false
): Rect {
  const { width, height, laneSize } = viewport;

  // Reverse direction flips the time axis; the two fractions swap so the
  // rectangle keeps a positive extent.
  const [from, to] =
    orientation.direction === "forward"
      ? [startFraction, endFraction]
      : [1 - endFraction, 1 - startFraction];

  const laneOffset = lane * laneSize;
  // Thickness across the stacking axis: one lane, or everything from this
  // lane down to the base.
  const thickness = extendToBase ? laneOffset + laneSize : laneSize;

  if (orientation.axis === "horizontal") {
    const left = from * width;
    const rectWidth = Math.max(0, (to - from) * width);
    // Base at the bottom means measuring up from the bottom edge.
    const top =
      orientation.base === "bottom" ? height - laneOffset - laneSize : laneOffset;
    return { left, top, width: rectWidth, height: thickness };
  }

  const top = from * height;
  const rectHeight = Math.max(0, (to - from) * height);
  const left =
    orientation.base === "left"
      ? 0
      : width - thickness;
  const laneLeft = orientation.base === "left" ? laneOffset : width - laneOffset - laneSize;
  return {
    left: extendToBase ? left : laneLeft,
    top,
    width: thickness,
    height: rectHeight,
  };
}

// ---------------------------------------------------------------------------
// Overlap resolution
// ---------------------------------------------------------------------------

export interface Placeable {
  id: string;
  startMs: number;
  /** Open-ended events have no end; they extend to the edge of the view
   * and fade out, but still occupy a lane so their text can't collide. */
  endMs: number | null;
  /** Fractional rank. Higher sorts later and stacks further from the base. */
  rank: string;
}

export interface Placement<T extends Placeable> {
  item: T;
  lane: number;
}

/**
 * Assigns each item the lowest lane not already taken by something it
 * overlaps -- the classic interval-graph sweep, O(n log n).
 *
 * Only items overlapping *within the visible window* compete for lanes,
 * which is what keeps this tractable: a day view lays out the handful of
 * events actually on screen, not the whole account.
 *
 * Items are processed in ascending rank, so lower-ranked items claim the
 * lanes nearest the base and higher-ranked ones are pushed away from it.
 *
 * `minSeparationMs` reserves horizontal room for an event's label, so two
 * events that merely *look* adjacent still get separate lanes -- the rule
 * that text must never overlap other text.
 */
export function assignLanes<T extends Placeable>(
  items: T[],
  viewEndMs: number,
  minSeparationMs = 0
): Placement<T>[] {
  const sorted = [...items].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
    // Ranks are unique by construction, but fall back to id so layout is
    // deterministic even if duplicates ever appear in stored data.
    return a.id < b.id ? -1 : 1;
  });

  // laneEnds[i] is the time at which lane i becomes free again.
  const laneEnds: number[] = [];
  const placements: Placement<T>[] = [];

  for (const item of sorted) {
    const effectiveEnd = (item.endMs ?? viewEndMs) + minSeparationMs;

    let lane = laneEnds.findIndex((freeAt) => freeAt <= item.startMs);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(effectiveEnd);
    } else {
      laneEnds[lane] = effectiveEnd;
    }

    placements.push({ item, lane });
  }

  return placements;
}

/** How many lanes a set of placements needs -- what the stack axis must
 * scroll through when it exceeds the viewport. */
export function laneCount<T extends Placeable>(placements: Placement<T>[]): number {
  return placements.reduce((max, p) => Math.max(max, p.lane + 1), 0);
}
