import { useEffect, useMemo, useRef, useState } from "react";
import {
  TIME_SCALES,
  DEFAULT_SCALE_INDEX,
  DEFAULT_ORIENTATION,
  validBases,
  timeFraction,
  rectFor,
  assignLanes,
  laneCount,
  zoomSpan,
  snapToScale,
  type Orientation,
  type Viewport,
} from "../lib/timeline.js";
import { expandOccurrences } from "../lib/recurrence.js";
import { rankAtEnd } from "../lib/fractionalRank.js";
import {
  timeDeltaFromDrag,
  laneFromPointer,
  resizeEvent,
  moveEvent,
  rankForLane,
  type ResizeEdge,
} from "../lib/timelineInteraction.js";
import type { DecryptedEvent } from "../lib/events.js";

const LANE_SIZE = 28;
/** Roughly the width a short label needs, used to stop two events that
 * merely look adjacent from putting their text in the same lane. */
const LABEL_WIDTH_PX = 90;

interface TimelineProps {
  events: DecryptedEvent[];
  onEditEvent: (eventId: string, origin: DOMRect | null) => void;
  /** Applies a change to an event. Kept as a callback so the timeline
   * stays presentational and the owner decides how to persist. */
  onChangeEvent?: (eventId: string, changes: Partial<DecryptedEvent>) => Promise<void> | void;
}

type DragMode = { kind: "resize"; edge: ResizeEdge } | { kind: "move" };

interface DragState {
  eventId: string;
  mode: DragMode;
  startX: number;
  startY: number;
  original: { startTime: string; endTime?: string };
  /** Preview of the change, applied visually before it is saved so the
   * drag feels immediate rather than waiting on a round trip. */
  preview: { startTime: string; endTime?: string; rank?: string } | null;
}

export function Timeline({ events, onEditEvent, onChangeEvent }: TimelineProps) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [orientation, setOrientation] = useState<Orientation>(DEFAULT_ORIENTATION);
  const [spanSeconds, setSpanSeconds] = useState(TIME_SCALES[DEFAULT_SCALE_INDEX]!.seconds);
  const [centre, setCentre] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState({ width: 800, height: 320 });

  // The present indicator has to actually move, so tick it. One second is
  // enough for a day view and cheap; finer zooms would want faster.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () =>
      setViewportSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    // ResizeObserver is absent in jsdom; the initial measurement still runs.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const viewStart = useMemo(() => new Date(centre - (spanSeconds * 1000) / 2), [centre, spanSeconds]);
  const viewEnd = useMemo(() => new Date(centre + (spanSeconds * 1000) / 2), [centre, spanSeconds]);

  const placements = useMemo(() => {
    // Ranks are assigned lazily so events created before fractional
    // ordering still lay out deterministically.
    const knownRanks = events.map((e) => e.rank).filter((r): r is string => Boolean(r));
    let fallbackSeed = knownRanks;

    const withPreview = events.map((event) =>
      drag?.preview && drag.eventId === event.id ? { ...event, ...drag.preview } : event
    );

    const occurrences = withPreview.flatMap((event) => {
      let rank = event.rank;
      if (!rank) {
        rank = rankAtEnd(fallbackSeed);
        fallbackSeed = [...fallbackSeed, rank];
      }
      return expandOccurrences(event, viewStart, viewEnd).map((occurrence, index) => ({
        id: `${event.id}-${index}`,
        event,
        occurrence,
        startMs: occurrence.start.getTime(),
        endMs: occurrence.end ? occurrence.end.getTime() : null,
        rank: rank!,
      }));
    });

    const msPerPixel = (spanSeconds * 1000) / Math.max(1, viewportSize.width);
    const separation = LABEL_WIDTH_PX * msPerPixel;
    return assignLanes(occurrences, viewEnd.getTime(), separation);
  }, [events, drag, viewStart, viewEnd, spanSeconds, viewportSize.width]);

  const lanes = laneCount(placements);
  const stackExtent = lanes * LANE_SIZE;
  const stackAxisSize =
    orientation.axis === "horizontal" ? viewportSize.height : viewportSize.width;
  const overflowing = stackExtent > stackAxisSize;
  const hiddenCount = overflowing
    ? placements.filter((p) => (p.lane + 1) * LANE_SIZE > stackAxisSize).length
    : 0;

  const viewport: Viewport = {
    width: viewportSize.width,
    height: Math.max(viewportSize.height, orientation.axis === "horizontal" ? stackExtent : 0),
    laneSize: LANE_SIZE,
  };
  if (orientation.axis === "vertical") {
    viewport.width = Math.max(viewportSize.width, stackExtent);
  }

  const nowFraction = timeFraction(new Date(now), viewStart, viewEnd);
  const currentScale = snapToScale(spanSeconds);

  function beginDrag(
    e: React.PointerEvent,
    event: DecryptedEvent,
    mode: DragMode
  ) {
    if (!event.canEdit) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({
      eventId: event.id,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      original: { startTime: event.startTime, endTime: event.endTime },
      preview: null,
    });
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!drag) return;
    const deltaMs = timeDeltaFromDrag(
      e.clientX - drag.startX,
      e.clientY - drag.startY,
      orientation,
      viewport,
      spanSeconds * 1000
    );

    if (drag.mode.kind === "resize") {
      const next = resizeEvent(drag.original, drag.mode.edge, deltaMs);
      setDrag({
        ...drag,
        preview: { startTime: next.startTime, endTime: next.endTime ?? undefined },
      });
      return;
    }

    const moved = moveEvent(drag.original, deltaMs);
    // Moving also re-ranks if the pointer crossed into another lane:
    // dragging away from the base means higher priority.
    const bounds = containerRef.current?.getBoundingClientRect();
    let rank: string | undefined;
    if (bounds) {
      const targetLane = laneFromPointer(
        e.clientX - bounds.left,
        e.clientY - bounds.top,
        orientation,
        viewport
      );
      rank = rankForLane(drag.eventId, targetLane, placements) ?? undefined;
    }
    setDrag({
      ...drag,
      preview: { startTime: moved.startTime, endTime: moved.endTime ?? undefined, ...(rank ? { rank } : {}) },
    });
  }

  async function handlePointerUp() {
    if (!drag) return;
    const { eventId, preview } = drag;
    setDrag(null);
    if (!preview || !onChangeEvent) return;
    // Nothing actually moved -- skip a pointless encrypted round trip.
    if (
      preview.startTime === drag.original.startTime &&
      preview.endTime === drag.original.endTime &&
      !preview.rank
    ) {
      return;
    }
    await onChangeEvent(eventId, preview);
  }

  function handleZoom(factor: number) {
    setSpanSeconds((current) => zoomSpan(current, factor));
  }

  function handlePan(fractionOfSpan: number) {
    setCentre((current) => current + spanSeconds * 1000 * fractionOfSpan);
  }

  return (
    <section className="timeline" aria-label="Timeline">
      <div className="timeline-controls">
        <div className="timeline-control-group" role="group" aria-label="Zoom">
          <button type="button" onClick={() => handleZoom(0.5)} aria-label="Zoom in">
            &minus;
          </button>
          <span className="timeline-scale" aria-live="polite">
            {currentScale.label}
          </span>
          <button type="button" onClick={() => handleZoom(2)} aria-label="Zoom out">
            +
          </button>
        </div>

        <div className="timeline-control-group" role="group" aria-label="Pan">
          <button type="button" onClick={() => handlePan(-0.25)} aria-label="Move back in time">
            &larr;
          </button>
          <button type="button" onClick={() => setCentre(Date.now())}>
            Now
          </button>
          <button type="button" onClick={() => handlePan(0.25)} aria-label="Move forward in time">
            &rarr;
          </button>
        </div>

        <label className="inline-label">
          Layout
          <select
            value={`${orientation.axis}:${orientation.direction}`}
            onChange={(e) => {
              const [axis, direction] = e.target.value.split(":") as [
                Orientation["axis"],
                Orientation["direction"],
              ];
              setOrientation((current) => ({
                axis,
                direction,
                // Keep the base valid: it must stay perpendicular to time.
                base: validBases(axis).includes(current.base)
                  ? current.base
                  : validBases(axis)[0]!,
              }));
            }}
          >
            <option value="horizontal:forward">Horizontal, past &rarr; future</option>
            <option value="horizontal:reverse">Horizontal, future &rarr; past</option>
            <option value="vertical:forward">Vertical, past &rarr; future</option>
            <option value="vertical:reverse">Vertical, future &rarr; past</option>
          </select>
        </label>

        <label className="inline-label">
          Base
          <select
            value={orientation.base}
            onChange={(e) =>
              setOrientation((current) => ({
                ...current,
                base: e.target.value as Orientation["base"],
              }))
            }
          >
            {validBases(orientation.axis).map((base) => (
              <option key={base} value={base}>
                {base}
              </option>
            ))}
          </select>
        </label>
      </div>

      {overflowing && (
        <p className="stack-overflow-note" role="status">
          {hiddenCount} more {hiddenCount === 1 ? "event" : "events"} stacked beyond the
          edge &mdash; scroll to see {hiddenCount === 1 ? "it" : "them"}.
        </p>
      )}

      <div
        className={`timeline-viewport timeline-${orientation.axis} base-${orientation.base}${
          overflowing ? " timeline-scrollable" : ""
        }`}
        ref={containerRef}
        tabIndex={0}
        aria-label="Timeline events"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div
          className="timeline-canvas"
          style={{
            width: orientation.axis === "vertical" ? viewport.width : undefined,
            height: orientation.axis === "horizontal" ? viewport.height : undefined,
          }}
        >
          {/* Present indicator */}
          {nowFraction >= 0 && nowFraction <= 1 && (
            <div
              className={`present-indicator present-${orientation.axis}`}
              style={
                orientation.axis === "horizontal"
                  ? {
                      left: `${
                        (orientation.direction === "forward" ? nowFraction : 1 - nowFraction) * 100
                      }%`,
                    }
                  : {
                      top: `${
                        (orientation.direction === "forward" ? nowFraction : 1 - nowFraction) * 100
                      }%`,
                    }
              }
              aria-hidden="true"
            />
          )}

          {placements.map(({ item, lane }) => {
            const startFraction = timeFraction(item.occurrence.start, viewStart, viewEnd);
            const endFraction = item.occurrence.end
              ? timeFraction(item.occurrence.end, viewStart, viewEnd)
              : 1;
            const rect = rectFor(
              Math.max(0, Math.min(1, startFraction)),
              Math.max(0, Math.min(1, endFraction)),
              lane,
              orientation,
              viewport
            );
            const openEnded = item.occurrence.end === null;

            return (
              <div
                key={item.id}
                className={`event-modal${openEnded ? " event-modal-open-ended" : ""}${
                  item.event.important ? " event-modal-important" : ""
                }`}
                style={{
                  left: rect.left,
                  top: rect.top,
                  width: Math.max(rect.width, 2),
                  height: Math.max(rect.height, 2),
                }}
                data-testid={`event-modal-${item.event.id}`}
                data-lane={lane}
              >
                {/* Background carries the fade; the label sits above it at
                    full opacity so it stays readable and clickable at any
                    depth. */}
                <div
                  className={`event-modal-fill fade-${orientation.base}${
                    openEnded ? " fade-open-ended" : ""
                  }`}
                  aria-hidden="true"
                />
                {/* Edge handles resize; the body moves and re-ranks. Both
                    are pointer-driven, so they work with touch as well. */}
                {item.event.canEdit && (
                  <>
                    <span
                      className="resize-handle resize-start"
                      role="separator"
                      aria-label={`Adjust start of ${item.event.title || "untitled event"}`}
                      onPointerDown={(e) =>
                        beginDrag(e, item.event, { kind: "resize", edge: "start" })
                      }
                    />
                    <span
                      className="resize-handle resize-end"
                      role="separator"
                      aria-label={`Adjust end of ${item.event.title || "untitled event"}`}
                      onPointerDown={(e) =>
                        beginDrag(e, item.event, { kind: "resize", edge: "end" })
                      }
                    />
                  </>
                )}
                <button
                  type="button"
                  className="event-modal-label"
                  onPointerDown={(e) => beginDrag(e, item.event, { kind: "move" })}
                  onClick={(e) =>
                    onEditEvent(item.event.id, (e.currentTarget as Element).getBoundingClientRect())
                  }
                >
                  {item.event.important && (
                    <>
                      <span className="visually-hidden">Important: </span>
                      <span aria-hidden="true" className="important-star">
                        &#9733;
                      </span>
                    </>
                  )}
                  {/* An em-square target when there is no readable label,
                      so a nameless or very narrow event is still clickable. */}
                  {item.event.title?.trim() ? (
                    <span className="event-modal-title">{item.event.title}</span>
                  ) : (
                    <span className="event-modal-square" aria-label="Untitled event" />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
