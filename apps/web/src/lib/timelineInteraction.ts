import { rankBetween } from "./fractionalRank.js";
import type { Orientation, Viewport, Placement, Placeable } from "./timeline.js";

/**
 * Pointer maths for the timeline, kept pure and separate from the
 * component. Every one of these has to behave correctly under four
 * orientations and two base edges, and sign errors there are both easy to
 * introduce and hard to spot by eye -- so they are tested rather than
 * inspected.
 */

export type ResizeEdge = "start" | "end";

/** Size of the viewport along the time axis. */
export function timeAxisSize(orientation: Orientation, viewport: Viewport): number {
  return orientation.axis === "horizontal" ? viewport.width : viewport.height;
}

/** Size of the viewport along the stacking axis. */
export function stackAxisSize(orientation: Orientation, viewport: Viewport): number {
  return orientation.axis === "horizontal" ? viewport.height : viewport.width;
}

/**
 * Converts a pointer movement into a time delta in milliseconds.
 *
 * Dragging right always means "later" in a forward horizontal layout, and
 * always means "earlier" when the axis is reversed. Getting this wrong
 * makes events move the opposite way from the pointer, which feels broken
 * immediately.
 */
export function timeDeltaFromDrag(
  deltaX: number,
  deltaY: number,
  orientation: Orientation,
  viewport: Viewport,
  spanMs: number
): number {
  const along = orientation.axis === "horizontal" ? deltaX : deltaY;
  const size = timeAxisSize(orientation, viewport);
  if (size <= 0) return 0;
  const signed = orientation.direction === "forward" ? along : -along;
  return (signed / size) * spanMs;
}

/**
 * Which lane a pointer sits over. Lane 0 is against the base, and lanes
 * increase away from it -- so the arithmetic inverts depending on which
 * edge the base is.
 */
export function laneFromPointer(
  x: number,
  y: number,
  orientation: Orientation,
  viewport: Viewport
): number {
  const { laneSize } = viewport;
  if (laneSize <= 0) return 0;

  let distanceFromBase: number;
  switch (orientation.base) {
    case "bottom":
      distanceFromBase = viewport.height - y;
      break;
    case "top":
      distanceFromBase = y;
      break;
    case "left":
      distanceFromBase = x;
      break;
    case "right":
      distanceFromBase = viewport.width - x;
      break;
  }
  return Math.max(0, Math.floor(distanceFromBase / laneSize));
}

export interface ResizeResult {
  startTime: string;
  /** Null means the event stays (or becomes) open-ended. */
  endTime: string | null;
}

/**
 * Applies a drag on one edge of an event.
 *
 * Dragging the start edge moves the start only, so duration changes rather
 * than the event sliding. A minimum duration is enforced so an event can't
 * be dragged inside-out into a negative span -- the edges swap visually
 * long before the data would allow it.
 */
export function resizeEvent(
  current: { startTime: string; endTime?: string | null },
  edge: ResizeEdge,
  timeDeltaMs: number,
  minimumDurationMs = 60_000
): ResizeResult {
  const start = new Date(current.startTime).getTime();
  const end = current.endTime ? new Date(current.endTime).getTime() : null;

  if (edge === "start") {
    const proposed = start + timeDeltaMs;
    // Can't push the start past the end (less the minimum duration).
    const clamped = end === null ? proposed : Math.min(proposed, end - minimumDurationMs);
    return {
      startTime: new Date(clamped).toISOString(),
      endTime: end === null ? null : new Date(end).toISOString(),
    };
  }

  // Dragging the end of an open-ended event gives it a definite end,
  // which is a reasonable reading of the gesture.
  const base = end ?? start + minimumDurationMs;
  const proposed = base + timeDeltaMs;
  const clamped = Math.max(proposed, start + minimumDurationMs);
  return {
    startTime: new Date(start).toISOString(),
    endTime: new Date(clamped).toISOString(),
  };
}

/** Moves an event in time without changing its duration. */
export function moveEvent(
  current: { startTime: string; endTime?: string | null },
  timeDeltaMs: number
): ResizeResult {
  const start = new Date(current.startTime).getTime() + timeDeltaMs;
  const end = current.endTime ? new Date(current.endTime).getTime() + timeDeltaMs : null;
  return {
    startTime: new Date(start).toISOString(),
    endTime: end === null ? null : new Date(end).toISOString(),
  };
}

/**
 * The rank an event needs to sit at `targetLane`.
 *
 * Dragging away from the base raises priority, so the new rank is placed
 * between the ranks currently occupying the lanes either side of the
 * target. Returns null when the event is already effectively there, so
 * callers can skip a pointless write.
 */
export function rankForLane<T extends Placeable>(
  movingId: string,
  targetLane: number,
  placements: Placement<T>[]
): string | null {
  const others = placements
    .filter((p) => p.item.id !== movingId)
    .sort((a, b) => a.lane - b.lane);

  if (others.length === 0) return null;

  // Ranks of the occupants immediately below and above the target lane.
  const below = others.filter((p) => p.lane < targetLane).pop();
  const above = others.find((p) => p.lane >= targetLane);

  const lower = below ? below.item.rank : null;
  const upper = above ? above.item.rank : null;

  if (lower === null && upper === null) return null;
  if (lower !== null && upper !== null && lower >= upper) {
    // Shouldn't happen with sorted unique ranks, but generating a rank
    // from an inverted pair would throw -- fall back to the top.
    return rankBetween(upper, null);
  }
  return rankBetween(lower, upper);
}

// ---------------------------------------------------------------------------
// Keyboard alternatives to dragging (WCAG 2.5.7)
// ---------------------------------------------------------------------------

/** What an arrow key asks for. `direction` is +1 for later (time) or
 * higher priority (rank), -1 for the opposite. */
export type KeyboardAdjustment =
  | { kind: "move"; direction: 1 | -1 }
  | { kind: "resize"; edge: ResizeEdge; direction: 1 | -1 }
  | { kind: "rank"; direction: 1 | -1 };

export interface KeyModifiers {
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** The arrow keys along the time axis, as [earlier, later] in screen
 * terms -- the same sign convention as `timeDeltaFromDrag`. */
export function timeAxisKeys(orientation: Orientation): [string, string] {
  const keys: [string, string] =
    orientation.axis === "horizontal" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
  return orientation.direction === "forward" ? keys : [keys[1], keys[0]];
}

/** The arrow keys across the time axis, as [toward base, away from base].
 * Away from the base is higher priority, as with dragging. */
export function stackAxisKeys(orientation: Orientation): [string, string] {
  switch (orientation.base) {
    case "bottom":
      return ["ArrowDown", "ArrowUp"];
    case "top":
      return ["ArrowUp", "ArrowDown"];
    case "left":
      return ["ArrowLeft", "ArrowRight"];
    case "right":
      return ["ArrowRight", "ArrowLeft"];
  }
}

/**
 * Maps a key press on a focused event to the drag it stands in for:
 * arrows along time move it, Shift+arrows move its end, Alt+Shift+arrows
 * move its start, and arrows across time re-rank it.
 *
 * Plain Alt is left alone because Alt+Left/Right is browser history
 * navigation, and Ctrl/Meta combinations because they belong to the
 * browser or OS. Returns null for anything that isn't ours, so the caller
 * lets the key through.
 */
export function keyboardAdjustment(
  key: string,
  modifiers: KeyModifiers,
  orientation: Orientation
): KeyboardAdjustment | null {
  if (modifiers.ctrlKey || modifiers.metaKey) return null;

  const [earlier, later] = timeAxisKeys(orientation);
  if (key === earlier || key === later) {
    const direction = key === later ? 1 : -1;
    if (!modifiers.shiftKey) {
      return modifiers.altKey ? null : { kind: "move", direction };
    }
    return { kind: "resize", edge: modifiers.altKey ? "start" : "end", direction };
  }

  const [toward, away] = stackAxisKeys(orientation);
  if ((key === toward || key === away) && !modifiers.shiftKey && !modifiers.altKey) {
    return { kind: "rank", direction: key === away ? 1 : -1 };
  }
  return null;
}

/** Round step sizes, ascending, for keyboard nudges. */
const KEYBOARD_STEPS_MS = [
  1, 5, 15, 30, 60, 5 * 60, 15 * 60, 30 * 60, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400,
  7 * 86400, 30 * 86400,
].map((s) => s * 1000);

/**
 * How far one key press moves an event: the largest round step that is at
 * most ~1% of the visible span (15 minutes on a day view), so a press is a
 * visible but fine adjustment at every zoom level.
 */
export function keyboardStepMs(spanMs: number): number {
  const target = spanMs / 96;
  let step = KEYBOARD_STEPS_MS[0]!;
  for (const candidate of KEYBOARD_STEPS_MS) {
    if (candidate <= target) step = candidate;
  }
  return step;
}

/**
 * The rank that moves an event one place up (+1) or down (-1) in priority,
 * and the event it passes.
 *
 * Only events it competes with for lanes count -- those overlapping it,
 * label separation included, exactly as `assignLanes` decides -- because
 * passing an event elsewhere on the timeline changes nothing visible. The
 * new rank is placed against the passed event's *global* neighbour, so it
 * can never tie with a non-overlapping event's rank.
 */
export function rankStep<T extends Placeable>(
  movingId: string,
  direction: 1 | -1,
  items: T[],
  viewEndMs: number,
  minSeparationMs = 0
): { rank: string; past: T } | null {
  const moving = items.find((i) => i.id === movingId);
  if (!moving) return null;

  const effectiveEnd = (i: Placeable) => (i.endMs ?? viewEndMs) + minSeparationMs;
  const overlaps = (i: Placeable) =>
    i.startMs < effectiveEnd(moving) && moving.startMs < effectiveEnd(i);

  const others = items
    .filter((i) => i.id !== movingId)
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));

  if (direction === 1) {
    const past = others.find((i) => i.rank > moving.rank && overlaps(i));
    if (!past) return null;
    const next = others.find((i) => i.rank > past.rank);
    return { rank: rankBetween(past.rank, next?.rank ?? null), past };
  }

  const past = [...others].reverse().find((i) => i.rank < moving.rank && overlaps(i));
  if (!past) return null;
  const previous = [...others].reverse().find((i) => i.rank < past.rank);
  return { rank: rankBetween(previous?.rank ?? null, past.rank), past };
}

/**
 * How far to pan the view (ms, positive = later) so a keyboard change
 * doesn't carry an event off screen and unmount its focused label.
 *
 * `start` is the labelled occurrence's start before and after the press;
 * `end` is its end, given when the end is the edge to follow -- the edge
 * being resized, or for an occurrence already in progress at the view's
 * start, the end of a move that carries it earlier. The view follows that
 * edge so it stays at least `marginMs` inside, but only in the direction
 * it moved, so nudging an event that sits near one edge never pans the
 * other way.
 *
 * An edge that was already off screen before the press is not followed:
 * there was nothing on screen to keep, and chasing it would jump the view
 * by however far away it was, not by one step.
 *
 * Following the end may carry the start off the earlier edge: an
 * occurrence stays rendered while any of it overlaps the view, and its
 * label is pinned to the view's start while its own start is off screen.
 */
export function panToKeepInView(
  view: { startMs: number; endMs: number },
  start: { before: number; after: number },
  end: { before: number; after: number } | null,
  marginMs: number
): number {
  const margin = Math.min(marginMs, (view.endMs - view.startMs) / 4);
  const low = view.startMs + margin;
  const high = view.endMs - margin;
  const followed = end ?? start;

  if (followed.before < view.startMs || followed.before > view.endMs) return 0;

  let pan = 0;
  if (followed.after > followed.before && followed.after > high) pan = followed.after - high;
  if (followed.after < followed.before && followed.after < low) pan = followed.after - low;
  return pan;
}
