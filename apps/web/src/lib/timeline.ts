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
    // Base at the bottom means measuring up from the bottom edge. Either
    // way, a rectangle extended to the base starts *at* the base when the
    // base is the top edge, rather than at its lane.
    const top =
      orientation.base === "bottom"
        ? height - laneOffset - laneSize
        : extendToBase
          ? 0
          : laneOffset;
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
  /** How far the item's label reaches along the time axis from `startMs`,
   * in ms. A name longer than its event overhangs the end, and the lane
   * stays taken until the name is done. */
  labelMs?: number;
}

/**
 * When an item's lane is free again: the later of its end and the end of
 * its label, plus `gapMs`. Shared by lane assignment and keyboard
 * re-ranking so both agree on what overlaps what.
 */
export function occupiedUntil(item: Placeable, viewEndMs: number, gapMs = 0): number {
  return Math.max(item.endMs ?? viewEndMs, item.startMs + (item.labelMs ?? 0)) + gapMs;
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
 * Each item's lane stays taken until its label ends (`labelMs`), so a long
 * name never runs into the next name in its lane, plus `gapMs` so two
 * labels that would merely touch are kept apart -- the rule that text
 * must never overlap other text. Across lanes, text is kept apart by the
 * lane size (see `laneSizeFor`).
 */
export function assignLanes<T extends Placeable>(
  items: T[],
  viewEndMs: number,
  gapMs = 0
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
    const effectiveEnd = occupiedUntil(item, viewEndMs, gapMs);

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

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** A label's box in px: `along` the time axis (where it competes with the
 * next label in its lane) and `across` it (where it competes with the
 * labels in neighbouring lanes). */
export interface LabelSize {
  along: number;
  across: number;
}

/**
 * A deliberately generous guess at a label's size, used until the real
 * label has been rendered and measured (and always in jsdom, which has no
 * layout). Mirrors `.event-modal-label`: 0.8rem text, 0.15rem/0.35rem
 * padding, an optional star. Generous so the first frame errs towards
 * spare room rather than overlap.
 */
export function estimateLabelSize(
  title: string | undefined,
  important: boolean,
  rootFontPx: number
): LabelSize {
  const em = 0.8 * rootFontPx;
  const text = title?.trim() ?? "";
  // 0.62em is wider than the average glyph of common UI fonts; bold is
  // wider still. An untitled event shows a 1em square instead.
  const textEm = text ? [...text].length * (important ? 0.68 : 0.62) : 1;
  const starEm = important ? 1 + 0.25 : 0;
  const paddingAlong = 0.7 * rootFontPx;
  // Vertical layouts set the text sideways, swapping which padding lies
  // across the lane; take the larger.
  const paddingAcross = 0.7 * rootFontPx;
  return {
    along: Math.ceil((textEm + starEm) * em + paddingAlong),
    across: Math.ceil(1.3 * em + paddingAcross),
  };
}

/**
 * The lane size: at least `minimum`, and never less than the thickest
 * label, so labels in neighbouring lanes are always at least one full
 * label (a text-height plus padding) apart and can't overlap -- including
 * when the user has enlarged the text.
 */
export function laneSizeFor(labelThicknesses: Iterable<number>, minimum: number): number {
  let size = minimum;
  for (const thickness of labelThicknesses) {
    if (Number.isFinite(thickness)) size = Math.max(size, Math.ceil(thickness));
  }
  return size;
}

/**
 * Where a lane begins inside the rectangle `rectFor(..., true)` draws for
 * it, along the stacking axis, in px. The label is placed there so it
 * sits in its own lane: the extended rectangle reaches the base, so its
 * near edge is the lane only when the base is the bottom or right edge.
 * Returned as the CSS property to set (`top` in horizontal layouts, `left`
 * in vertical ones) and its value.
 */
export function laneInset(
  lane: number,
  orientation: Orientation,
  viewport: Viewport
): { property: "top" | "left"; px: number } {
  const own = rectFor(0, 1, lane, orientation, viewport);
  const extended = rectFor(0, 1, lane, orientation, viewport, true);
  return orientation.axis === "horizontal"
    ? { property: "top", px: own.top - extended.top }
    : { property: "left", px: own.left - extended.left };
}
