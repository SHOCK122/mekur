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
  const [showLayoutOptions, setShowLayoutOptions] = useState(false);
  // Panning by dragging the background, distinct from dragging an event.
  const [pan, setPan] = useState<{ startX: number; startY: number; startCentre: number } | null>(
    null
  );
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
    const update = () => {
      // Ignore zero measurements. They occur before layout settles (and
      // always in jsdom), and a zero width would make every drag compute a
      // zero time delta, silently disabling panning and resizing.
      if (element.clientWidth > 0 && element.clientHeight > 0) {
        setViewportSize({ width: element.clientWidth, height: element.clientHeight });
      }
    };
    update();
    // ResizeObserver is absent in jsdom; the initial measurement still runs.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const viewStart = useMemo(() => new Date(centre - (spanSeconds * 1000) / 2), [centre, spanSeconds]);
  const viewEnd = useMemo(() => new Date(centre + (spanSeconds * 1000) / 2), [centre, spanSeconds]);

  /**
   * Occurrences are grouped into one entry per event, so every repeat of a
   * series shares a single lane rather than each occurrence competing for
   * its own. A daily standup is one row, not thirty. Non-repeating events
   * are simply series of one, which keeps a single rendering path.
   */
  const placements = useMemo(() => {
    const withPreview = events.map((event) =>
      drag?.preview && drag.eventId === event.id ? { ...event, ...drag.preview } : event
    );

    const knownRanks = withPreview.map((e) => e.rank).filter((r): r is string => Boolean(r));
    let fallbackSeed = knownRanks;

    const series = withPreview
      .map((event) => {
        let rank = event.rank;
        if (!rank) {
          rank = rankAtEnd(fallbackSeed);
          fallbackSeed = [...fallbackSeed, rank];
        }
        const occurrences = expandOccurrences(event, viewStart, viewEnd);
        if (occurrences.length === 0) return null;

        // The series occupies its lane from its first visible occurrence
        // to its last, so nothing else can be laid into the gaps between
        // repeats and break the single-row rule.
        const startMs = Math.min(...occurrences.map((o) => o.start.getTime()));
        const openEnded = occurrences.some((o) => o.end === null);
        const endMs = openEnded
          ? null
          : Math.max(...occurrences.map((o) => o.end!.getTime()));

        return { id: event.id, event, occurrences, startMs, endMs, rank: rank! };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    const msPerPixel = (spanSeconds * 1000) / Math.max(1, viewportSize.width);
    const separation = LABEL_WIDTH_PX * msPerPixel;
    return assignLanes(series, viewEnd.getTime(), separation);
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

  function beginPan(e: React.PointerEvent) {
    // Only the background pans; presses that land on an event are handled
    // by that event's own drag handlers.
    if (e.target !== e.currentTarget && !(e.target as Element).classList.contains("timeline-canvas")) {
      return;
    }
    setPan({ startX: e.clientX, startY: e.clientY, startCentre: centre });
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (pan) {
      // Dragging right should reveal the PAST, the way dragging a map
      // moves the surface under the pointer rather than the viewpoint.
      const deltaMs = timeDeltaFromDrag(
        e.clientX - pan.startX,
        e.clientY - pan.startY,
        orientation,
        viewport,
        spanSeconds * 1000
      );
      setCentre(pan.startCentre - deltaMs);
      return;
    }
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
    if (pan) {
      setPan(null);
      return;
    }
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

  /**
   * Continuous zoom on the wheel: scrolling up zooms in, down zooms out.
   * The factor is derived from the scroll magnitude so a trackpad's small
   * increments feel smooth rather than stepping, and the exponential form
   * keeps zooming perceptually even across nine orders of magnitude --
   * a fixed additive step would crawl at one end and leap at the other.
   */
  function handleWheel(e: React.WheelEvent) {
    if (e.deltaY === 0) return;
    e.preventDefault();
    const factor = Math.exp(e.deltaY * 0.002);
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

        <button
          type="button"
          className="header-link"
          aria-expanded={showLayoutOptions}
          onClick={() => setShowLayoutOptions((v) => !v)}
        >
          {showLayoutOptions ? "Hide layout options" : "Layout options"}
        </button>
      </div>

      {showLayoutOptions && (
        <div className="timeline-controls-panel">
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
      )}

      {overflowing && (
        <p className="stack-overflow-note" role="status">
          {hiddenCount} more {hiddenCount === 1 ? "event" : "events"} stacked beyond the
          edge &mdash; scroll to see {hiddenCount === 1 ? "it" : "them"}.
        </p>
      )}

      <div
        className={`timeline-viewport timeline-${orientation.axis} direction-${orientation.direction} base-${orientation.base}${
          overflowing ? " timeline-scrollable" : ""
        }`}
        ref={containerRef}
        tabIndex={0}
        aria-label="Timeline events"
        onWheel={handleWheel}
        onPointerDown={beginPan}
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
              data-testid="present-indicator"
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
            const { event, occurrences } = item;
            const openEnded = item.endMs === null;

            return (
              <div
                key={event.id}
                className={`event-series${event.important ? " event-series-important" : ""}`}
                data-testid={`event-series-${event.id}`}
                data-lane={lane}
                data-occurrences={occurrences.length}
              >
                {occurrences.map((occurrence, index) => {
                  const startFraction = timeFraction(occurrence.start, viewStart, viewEnd);
                  const endFraction = occurrence.end
                    ? timeFraction(occurrence.end, viewStart, viewEnd)
                    : 1;
                  const rect = rectFor(
                    Math.max(0, Math.min(1, startFraction)),
                    Math.max(0, Math.min(1, endFraction)),
                    lane,
                    orientation,
                    viewport,
                    true
                  );
                  // The name belongs to the series, not to each repeat, so
                  // only the first visible occurrence carries it.
                  const isFirst = index === 0;

                  return (
                    <div
                      key={`${event.id}-${index}`}
                      className={`event-modal${openEnded ? " event-modal-open-ended" : ""}${
                        event.important ? " event-modal-important" : ""
                      }${occurrence.skipped ? " event-modal-skipped" : ""}`}
                      style={{
                        left: rect.left,
                        top: rect.top,
                        width: Math.max(rect.width, 2),
                        height: Math.max(rect.height, 2),
                      }}
                      data-testid={isFirst ? `event-modal-${event.id}` : undefined}
                      data-lane={lane}
                    >
                      <div
                        className={`event-modal-fill fade-${orientation.base}${
                          openEnded ? " fade-open-ended" : ""
                        }`}
                        aria-hidden="true"
                      />

                      {event.canEdit && (
                        <>
                          <span
                            className="resize-handle resize-start"
                            role="separator"
                            aria-label={`Adjust start of ${event.title || "untitled event"}`}
                            onPointerDown={(e) =>
                              beginDrag(e, event, { kind: "resize", edge: "start" })
                            }
                          />
                          <span
                            className="resize-handle resize-end"
                            role="separator"
                            aria-label={`Adjust end of ${event.title || "untitled event"}`}
                            onPointerDown={(e) =>
                              beginDrag(e, event, { kind: "resize", edge: "end" })
                            }
                          />
                        </>
                      )}

                      {isFirst && (
                        <button
                          type="button"
                          className="event-modal-label"
                          onPointerDown={(e) => beginDrag(e, event, { kind: "move" })}
                          onClick={(e) =>
                            onEditEvent(
                              event.id,
                              (e.currentTarget as Element).getBoundingClientRect()
                            )
                          }
                        >
                          {event.important && (
                            <>
                              <span className="visually-hidden">Important: </span>
                              <span aria-hidden="true" className="important-star">
                                &#9733;
                              </span>
                            </>
                          )}
                          {event.title?.trim() ? (
                            <span className="event-modal-title">{event.title}</span>
                          ) : (
                            <span className="event-modal-square" aria-label="Untitled event" />
                          )}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
