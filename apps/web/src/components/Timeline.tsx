import { useEffect, useId, useMemo, useRef, useState } from "react";
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
  keyboardAdjustment,
  keyboardStepMs,
  rankStep,
  panToKeepInView,
  timeAxisSize,
  timeAxisKeys,
  stackAxisKeys,
  type ResizeEdge,
  type KeyboardAdjustment,
} from "../lib/timelineInteraction.js";
import type { EventContent } from "@schedule-app/shared";
import type { DecryptedEvent } from "../lib/events.js";

const LANE_SIZE = 28;
/** Roughly the width a short label needs, used to stop two events that
 * merely look adjacent from putting their text in the same lane. */
const LABEL_WIDTH_PX = 90;
/** Keyboard nudges are saved once the keys go quiet for this long, so
 * holding an arrow down is one encrypted write rather than dozens. */
const KEYBOARD_COMMIT_DELAY_MS = 500;

interface TimelineProps {
  events: DecryptedEvent[];
  /** Opens an event. `occurrenceStart` is the occurrence whose label was
   * clicked, so per-occurrence actions act on the right one. */
  onEditEvent: (eventId: string, origin: DOMRect | null, occurrenceStart: Date) => void;
  /** Applies a change to an event. Kept as a callback so the timeline
   * stays presentational and the owner decides how to persist. */
  onChangeEvent?: (eventId: string, changes: Partial<EventContent>) => Promise<unknown> | void;
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
  preview: EventPreview | null;
}

interface EventPreview {
  startTime: string;
  endTime?: string;
  rank?: string;
}

/** Keyboard changes not yet saved. Shown exactly like a drag preview. */
interface Nudge {
  eventId: string;
  original: { startTime: string; endTime?: string };
  preview: EventPreview;
  name: string;
}

/** A change sent to the server but not yet confirmed. It stays on screen
 * until the save lands so the event doesn't flick back. */
interface Saving {
  preview: EventPreview;
  token: object;
}

const KEY_NAMES: Record<string, string> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
};

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
  const [nudge, setNudge] = useState<Nudge | null>(null);
  // The latest nudge and save callback, for the debounce timer, blur and
  // unmount, which would otherwise see a stale render's values.
  const nudgeRef = useRef<Nudge | null>(null);
  const [saving, setSaving] = useState<ReadonlyMap<string, Saving>>(new Map());
  const savingRef = useRef<ReadonlyMap<string, Saving>>(saving);
  // Saves run one at a time, so an older write can never land after a
  // newer one for the same event.
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChangeEvent);
  onChangeRef.current = onChangeEvent;
  const [announcement, setAnnouncement] = useState("");
  const keysHelpId = useId();

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

  // Save anything still pending if the timeline goes away mid-nudge.
  useEffect(() => () => commitNudge(), []);

  const viewStart = useMemo(() => new Date(centre - (spanSeconds * 1000) / 2), [centre, spanSeconds]);
  const viewEnd = useMemo(() => new Date(centre + (spanSeconds * 1000) / 2), [centre, spanSeconds]);

  /**
   * Occurrences are grouped into one entry per event, so every repeat of a
   * series shares a single lane rather than each occurrence competing for
   * its own. A daily standup is one row, not thirty. Non-repeating events
   * are simply series of one, which keeps a single rendering path.
   */
  const separation = LABEL_WIDTH_PX * ((spanSeconds * 1000) / Math.max(1, viewportSize.width));
  const placements = useMemo(() => {
    const withPreview = events.map((saved) => {
      const inFlight = saving.get(saved.id);
      const event = inFlight ? { ...saved, ...inFlight.preview } : saved;
      if (drag?.preview && drag.eventId === event.id) return { ...event, ...drag.preview };
      if (nudge && nudge.eventId === event.id) return { ...event, ...nudge.preview };
      return event;
    });

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
        // repeats and break the single-row rule. An occurrence already in
        // progress is drawn (and labelled) from the view's start, so that
        // is where it begins competing for room.
        const startMs = Math.max(
          viewStart.getTime(),
          Math.min(...occurrences.map((o) => o.start.getTime()))
        );
        const openEnded = occurrences.some((o) => o.end === null);
        const endMs = openEnded
          ? null
          : Math.max(...occurrences.map((o) => o.end!.getTime()));

        return { id: event.id, event, occurrences, startMs, endMs, rank: rank! };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    return assignLanes(series, viewEnd.getTime(), separation);
  }, [events, drag, nudge, saving, viewStart, viewEnd, spanSeconds, viewportSize.width]);

  const eventOrder = useMemo(() => new Map(events.map((e, i) => [e.id, i])), [events]);

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
    commitNudge();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    // Build on any change still being saved, not the stale stored copy.
    const current = latestTimes(event);
    setDrag({
      eventId: event.id,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      original: current,
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
    const event = events.find((e) => e.id === eventId);
    await enqueueSave(eventId, preview, event?.title?.trim() || "Untitled event");
  }

  function updateNudge(next: Nudge | null) {
    nudgeRef.current = next;
    setNudge(next);
  }

  function updateSaving(next: ReadonlyMap<string, Saving>) {
    savingRef.current = next;
    setSaving(next);
  }

  /** An event's times including any change still being saved. */
  function latestTimes(event: DecryptedEvent): { startTime: string; endTime?: string } {
    const inFlight = savingRef.current.get(event.id)?.preview;
    return {
      startTime: inFlight?.startTime ?? event.startTime,
      endTime: inFlight ? inFlight.endTime : event.endTime,
    };
  }

  /**
   * Queues a save behind any earlier one and shows it until it lands. The
   * change is merged with whatever is still in flight for the event, so a
   * rank saved a moment ago isn't lost by a later move.
   */
  function enqueueSave(eventId: string, preview: EventPreview, name: string): Promise<unknown> {
    const merged = { ...savingRef.current.get(eventId)?.preview, ...preview };
    const token = {};
    updateSaving(new Map(savingRef.current).set(eventId, { preview: merged, token }));
    const done = saveChain.current
      .then(() => onChangeRef.current?.(eventId, merged))
      .then(
        (result) => {
          if (result === false) setAnnouncement(`Couldn't save the change to ${name}.`);
        },
        () => setAnnouncement(`Couldn't save the change to ${name}.`)
      )
      .finally(() => {
        // A newer change for the same event replaced this one; it stays.
        if (savingRef.current.get(eventId)?.token !== token) return;
        const next = new Map(savingRef.current);
        next.delete(eventId);
        updateSaving(next);
      });
    saveChain.current = done;
    return done;
  }

  /** Sends the pending keyboard change. It moves from "pending" to
   * "saving", so a later press on any event starts from a clean slate. */
  function commitNudge() {
    if (commitTimer.current) {
      clearTimeout(commitTimer.current);
      commitTimer.current = null;
    }
    const pending = nudgeRef.current;
    if (!pending) return;
    updateNudge(null);
    const { preview, original } = pending;
    const unchanged =
      preview.startTime === original.startTime &&
      preview.endTime === original.endTime &&
      !preview.rank;
    if (!onChangeRef.current || unchanged) return;
    void enqueueSave(pending.eventId, preview, pending.name);
  }

  /** Opens an event, first waiting for any of its changes still being
   * saved so the editor doesn't start from (and save back) stale times. */
  async function openEvent(event: DecryptedEvent, origin: DOMRect, occurrenceStart: Date) {
    commitNudge();
    if (savingRef.current.has(event.id)) await saveChain.current;
    onEditEvent(event.id, origin, occurrenceStart);
  }

  /**
   * The keyboard equivalent of every drag (WCAG 2.5.7): arrows along the
   * time axis move the focused event, Shift moves its end, Alt+Shift its
   * start, and arrows across the axis re-rank it. Changes preview at once,
   * are announced, and are saved together once the keys go quiet.
   */
  function handleEventKeyDown(e: React.KeyboardEvent, event: DecryptedEvent) {
    if (!event.canEdit || !onChangeEvent) return;
    const adjustment = keyboardAdjustment(e.key, e, orientation);
    if (!adjustment) return;
    e.preventDefault();

    if (nudgeRef.current && nudgeRef.current.eventId !== event.id) commitNudge();
    // Any other event's change has been sent, so this is either our own
    // unsaved change or nothing.
    const pending = nudgeRef.current;
    const original = pending?.original ?? latestTimes(event);
    const current: EventPreview = pending?.preview ?? { ...original };
    const name = event.title?.trim() || "Untitled event";

    const next = applyAdjustment(adjustment, event, name, current);
    if (!next) return;
    if (adjustment.kind !== "rank") keepInView(event.id, adjustment, current, next);

    updateNudge({ eventId: event.id, original, preview: next, name });
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(commitNudge, KEYBOARD_COMMIT_DELAY_MS);
  }

  /**
   * Pans so a keyboard change can't carry the event off screen, which
   * would unmount its label and drop keyboard focus. The label sits on the
   * first visible occurrence (pinned to the view's start while that one is
   * already in progress), and a change shifts every occurrence of a series
   * alike, so that occurrence is the one followed.
   */
  function keepInView(
    eventId: string,
    adjustment: Exclude<KeyboardAdjustment, { kind: "rank" }>,
    current: EventPreview,
    next: EventPreview
  ) {
    const labelled = placements.find((p) => p.item.id === eventId)?.item.occurrences[0];
    if (!labelled) return;
    const shift = (from?: string, to?: string) =>
      from && to ? new Date(to).getTime() - new Date(from).getTime() : 0;
    const startMs = labelled.start.getTime();
    const start = { before: startMs, after: startMs + shift(current.startTime, next.startTime) };
    // An occurrence already in progress has its start off screen and its
    // label pinned to the view's start; what can still carry it out of
    // view when it moves is its end.
    const clipped = startMs < viewStart.getTime();
    const followsEnd =
      (adjustment.kind === "resize" && adjustment.edge === "end") ||
      (adjustment.kind === "move" && clipped);
    // An open-ended event given an end by Shift+arrow had no end on screen
    // to follow; its start is all there is to keep in view.
    const end =
      followsEnd && labelled.end
        ? {
            before: labelled.end.getTime(),
            after: labelled.end.getTime() + shift(current.endTime, next.endTime),
          }
        : null;

    const pan = panToKeepInView(
      { startMs: viewStart.getTime(), endMs: viewEnd.getTime() },
      start,
      end,
      // Room for the label, which sits just after the start.
      LABEL_WIDTH_PX * ((spanSeconds * 1000) / Math.max(1, timeAxisSize(orientation, viewport)))
    );
    if (pan !== 0) setCentre((c) => c + pan);
  }

  /** The preview after one key press, announcing the result. Null when
   * there was nothing to do. */
  function applyAdjustment(
    adjustment: KeyboardAdjustment,
    event: DecryptedEvent,
    name: string,
    current: EventPreview
  ): EventPreview | null {
    const stepMs = keyboardStepMs(spanSeconds * 1000);
    const format = (iso: string) =>
      new Date(iso).toLocaleString(undefined, {
        // The date matters too: at week or month zoom a press moves days.
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        ...(stepMs < 60_000 ? { second: "2-digit" } : {}),
      });

    if (adjustment.kind === "rank") {
      const step = rankStep(
        event.id,
        adjustment.direction,
        placements.map((p) => p.item),
        viewEnd.getTime(),
        separation
      );
      const raising = adjustment.direction === 1;
      if (!step) {
        setAnnouncement(
          `${name} is already ${raising ? "above" : "below"} every event it overlaps.`
        );
        return null;
      }
      const other = step.past.event.title?.trim() || "untitled event";
      setAnnouncement(`${name} ${raising ? "raised above" : "lowered below"} ${other}.`);
      return { ...current, rank: step.rank };
    }

    const delta = adjustment.direction * stepMs;
    if (adjustment.kind === "move") {
      const moved = moveEvent(current, delta);
      setAnnouncement(
        `${name} moved to ${format(moved.startTime)}${
          moved.endTime ? ` until ${format(moved.endTime)}` : ""
        }.`
      );
      return { ...current, startTime: moved.startTime, endTime: moved.endTime ?? undefined };
    }

    const resized = resizeEvent(current, adjustment.edge, delta);
    setAnnouncement(
      adjustment.edge === "start"
        ? `${name} starts ${format(resized.startTime)}.`
        : `${name} ends ${format(resized.endTime!)}.`
    );
    return { ...current, startTime: resized.startTime, endTime: resized.endTime ?? undefined };
  }

  const [earlierKey, laterKey] = timeAxisKeys(orientation).map((k) => KEY_NAMES[k]);
  const [towardKey, awayKey] = stackAxisKeys(orientation).map((k) => KEY_NAMES[k]);
  const keysHelp =
    `Arrow keys: ${laterKey} or ${earlierKey} moves the event later or earlier; ` +
    `with Shift, changes its end; with Alt and Shift, changes its start. ` +
    `${awayKey} or ${towardKey} raises or lowers its priority.`;

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

      <p id={keysHelpId} className="visually-hidden">
        {keysHelp}
      </p>
      <p
        className="visually-hidden"
        aria-live="polite"
        data-testid="timeline-announcer"
      >
        {announcement}
      </p>

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

          {/* Rendered in the stable order of `events`, not rank order: if
              re-ranking reordered the DOM, the focused label would be
              moved and lose keyboard focus. */}
          {[...placements]
            .sort((a, b) => (eventOrder.get(a.item.id) ?? 0) - (eventOrder.get(b.item.id) ?? 0))
            .map(({ item, lane }) => {
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
                  // Already in progress at the view's start: the start edge
                  // is off screen, so there is no start to grab here.
                  const startClipped = startFraction < 0;

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
                          {!startClipped && (
                            <span
                              className="resize-handle resize-start"
                              role="separator"
                              aria-label={`Adjust start of ${event.title || "untitled event"}`}
                              onPointerDown={(e) =>
                                beginDrag(e, event, { kind: "resize", edge: "start" })
                              }
                            />
                          )}
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
                          aria-describedby={
                            event.canEdit && onChangeEvent ? keysHelpId : undefined
                          }
                          onPointerDown={(e) => beginDrag(e, event, { kind: "move" })}
                          onKeyDown={(e) => handleEventKeyDown(e, event)}
                          onBlur={commitNudge}
                          onClick={(e) =>
                            void openEvent(
                              event,
                              (e.currentTarget as Element).getBoundingClientRect(),
                              occurrence.start
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
