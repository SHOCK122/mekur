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
