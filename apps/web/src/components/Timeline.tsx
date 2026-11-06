import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  TIME_SCALES,
  DEFAULT_SCALE_INDEX,
  DEFAULT_ORIENTATION,
  validBases,
  timeFraction,
  rectFor,
  assignLanes,
  laneCount,
  estimateLabelSize,
  laneSizeFor,
  fillToBase,
  stackOffsetFromScroll,
  scrollForStackOffset,
  stackOverflow,
  stackSides,
  zoomSpan,
  snapToScale,
  type BaseEdge,
  type LabelSize,
  type ScrollBox,
  type Orientation,
  type Viewport,
} from "../lib/timeline.js";
import { expandOccurrences, type Occurrence } from "../lib/recurrence.js";
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
  applyTimelineChange,
  changedFields,
  occurrenceTimes,
  type ResizeEdge,
  type KeyboardAdjustment,
  type TimelineChange,
} from "../lib/timelineInteraction.js";
import type { EventContent } from "@schedule-app/shared";
import type { DecryptedEvent } from "../lib/events.js";

/** The smallest lane size. Lanes grow past it when the text is larger
 * (see `laneSizeFor`). */
const MIN_LANE_SIZE = 28;
/** Space kept between the end of one label and the next label in the
 * same lane, so two names never run together even when they'd only
 * touch. */
const LABEL_GAP_PX = 8;
/** Keyboard nudges are saved once the keys go quiet for this long, so
 * holding an arrow down is one encrypted write rather than dozens. */
const KEYBOARD_COMMIT_DELAY_MS = 500;
/** How long a scroll button's destination is trusted over the view's
 * current position (see `scrollStack`). */
const SCROLL_TARGET_TTL_MS = 1000;

/** Where events hidden past an edge of the stack are, in words, and the
 * name of the button that scrolls to them. */
const SIDE_WORDS: Record<BaseEdge, { where: string; scroll: string }> = {
  top: { where: "above", scroll: "Scroll up" },
  bottom: { where: "below", scroll: "Scroll down" },
  left: { where: "to the left", scroll: "Scroll left" },
  right: { where: "to the right", scroll: "Scroll right" },
};

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
  /** The moved occurrence being dragged on its own (its recurrenceId), or
   * null when the drag changes the whole series. */
  occurrence: Date | null;
  mode: DragMode;
  startX: number;
  startY: number;
  original: { startTime: string; endTime?: string };
  /** Preview of the change, applied visually before it is saved so the
   * drag feels immediate rather than waiting on a round trip. */
  preview: TimelineChange | null;
}

/** Keyboard changes not yet saved. Shown exactly like a drag preview. */
interface Nudge {
  eventId: string;
  /** As in DragState: a moved occurrence on its own, or the series. */
  occurrence: Date | null;
  original: { startTime: string; endTime?: string };
  preview: TimelineChange;
  name: string;
}

/** What the arrow keys change: an event, or one moved occurrence of it. */
interface KeyTarget {
  eventId: string;
  occurrence: Date | null;
}

/** A change sent to the server but not yet confirmed. It stays on screen
 * until the save lands so the event doesn't flick back. Kept as the
 * fields it changes from the saved event, so later changes are applied
 * on top of it (applyTimelineChange composes) rather than merged with it:
 * a series move remaps occurrence moves, so their order matters. */
interface Saving {
  fields: Partial<EventContent>;
  token: object;
}

/** An event including any change still being saved. */
function withInFlight<T extends DecryptedEvent>(event: T, saving: ReadonlyMap<string, Saving>): T {
  const inFlight = saving.get(event.id)?.fields;
  return inFlight ? { ...event, ...inFlight } : event;
}

/** What a change applies to, in words, for labels and announcements:
 * the event, or one moved occurrence of it. */
function targetName(event: DecryptedEvent, occurrence: Date | null): string {
  const title = event.title?.trim() || "untitled event";
  return occurrence ? `this occurrence of ${title}` : title;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Labels showing the same thing measure the same, so sizes are keyed by
 * what the label renders (the title as stored, or the untitled square)
 * rather than by event. */
function labelKey(event: { title?: string; important?: boolean }): string {
  return `${event.important ? "!" : "-"}${event.title?.trim() ? event.title : ""}`;
}

/** Measured label sizes kept across pans and zooms, so a label coming
 * back into view is laid out at its real size straight away. Bounded:
 * the oldest entries go first. */
const MAX_MEASURED_LABELS = 500;

function rootFontPx(): number {
  if (typeof document === "undefined") return 16;
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(px) && px > 0 ? px : 16;
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
  /** What the arrow keys change while an event's label keeps focus: set by
   * the first press, cleared on blur. Kept across saves so a moved
   * occurrence nudged past a sibling (which then carries the label) is
   * still the one that moves. */
  const keyTargetRef = useRef<KeyTarget | null>(null);
  // Mirrored in state for the label's key help, which describes it.
  const [keyTarget, setKeyTarget] = useState<KeyTarget | null>(null);
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
  const movedKeysHelpId = useId();
  /** Labels' measured sizes, by `labelKey`. Labels not measured yet (not
   * rendered yet, or no layout, as in jsdom) use an estimate. */
  const [measuredLabels, setMeasuredLabels] = useState<ReadonlyMap<string, LabelSize>>(new Map());
  /** The root font size, for estimates. Re-read whenever labels are
   * measured, so it follows the user's text size. */
  const [fontPx, setFontPx] = useState(rootFontPx);
  /** How far the stack axis is scrolled away from the base, in px (see
   * `stackOffsetFromScroll`). The ref is always exact and is what the view
   * is re-anchored to; the state only changes when that changes which
   * events are hidden, so scrolling doesn't re-render every frame. */
  const stackOffsetRef = useRef(0);
  const [stackOffset, setStackOffset] = useState(0);
  /** Where a scroll button last sent the view, while it is still getting
   * there, so a second press during a smooth scroll goes a page further
   * rather than a page from wherever the animation had reached. */
  const scrollTargetRef = useRef<{ offset: number; at: number } | null>(null);
  /** The native scrollbar's thickness, so the edge cues don't cover it. */
  const [scrollbarGutter, setScrollbarGutter] = useState(0);
  const canvasRef = useRef<HTMLDivElement>(null);

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
  // Label sizes are in px; lane assignment works in time. The time axis is
  // the viewport's width or height depending on the layout.
  const msPerPx =
    (spanSeconds * 1000) /
    Math.max(1, timeAxisSize(orientation, { ...viewportSize, laneSize: MIN_LANE_SIZE }));
  const labelGapMs = LABEL_GAP_PX * msPerPx;
  const labelSize = (event: { title?: string; important?: boolean }): LabelSize =>
    measuredLabels.get(labelKey(event)) ??
    estimateLabelSize(event.title, Boolean(event.important), fontPx);

  const placements = useMemo(() => {
    const withPreview = events.map((saved) => {
      const base = withInFlight(saved, saving);
      const active =
        drag?.preview && drag.eventId === saved.id
          ? { preview: drag.preview, occurrence: drag.occurrence }
          : nudge && nudge.eventId === saved.id
            ? nudge
            : null;
      return active ? applyTimelineChange(base, active.preview, active.occurrence) : base;
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

        // The name sits on the first visible occurrence, at `startMs`.
        const label = labelSize(event);
        const labelMs = label.along * msPerPx;
        return { id: event.id, event, occurrences, startMs, endMs, rank: rank!, labelMs, label };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    return assignLanes(series, viewEnd.getTime(), labelGapMs);
    // labelSize derives from measuredLabels and fontPx; labelGapMs from
    // msPerPx.
  }, [events, drag, nudge, saving, viewStart, viewEnd, msPerPx, measuredLabels, fontPx]);

  /**
   * Measures the rendered labels after layout, so lane assignment uses
   * real sizes rather than estimates. Sizes depend only on what a label
   * shows, never on where it is laid out, so this settles after one extra
   * render. Reading sizes forces the browser to lay out, so it runs when
   * the set of labels on screen or the layout axis changes -- not on every
   * drag frame or clock tick -- and otherwise only when a label actually
   * changes size (the user enlarging the text, a font loading).
   */
  const renderedLabels = placements.map((p) => labelKey(p.item.event)).sort().join("\n");
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const labels = Array.from(container.querySelectorAll<HTMLElement>("[data-label-key]"));

    const measure = () => {
      setFontPx((previous) => {
        const current = rootFontPx();
        return current === previous ? previous : current;
      });
      const measured = new Map<string, LabelSize>();
      for (const label of labels) {
        const box = label.getBoundingClientRect();
        // No layout (jsdom), or not displayed: keep the estimate.
        if (box.width <= 0 || box.height <= 0) continue;
        // Vertical layouts set the text sideways, running along time.
        const [along, across] =
          orientation.axis === "horizontal" ? [box.width, box.height] : [box.height, box.width];
        measured.set(label.dataset.labelKey!, { along: Math.ceil(along), across: Math.ceil(across) });
      }
      setMeasuredLabels((previous) => {
        const changed = [...measured].some(([key, size]) => {
          const old = previous.get(key);
          return !old || old.along !== size.along || old.across !== size.across;
        });
        if (!changed) return previous;
        const next = new Map(previous);
        for (const [key, size] of measured) {
          // Re-inserting moves the key to the newest end.
          next.delete(key);
          next.set(key, size);
        }
        for (const key of next.keys()) {
          if (next.size <= MAX_MEASURED_LABELS) break;
          next.delete(key);
        }
        return next;
      });
    };

    measure();
    // ResizeObserver is absent in jsdom; the measurement above still runs.
    if (typeof ResizeObserver === "undefined") return;
    // It also reports each label once on observing; harmless, since an
    // unchanged measurement changes no state.
    const observer = new ResizeObserver(measure);
    for (const label of labels) observer.observe(label);
    return () => observer.disconnect();
  }, [renderedLabels, orientation.axis]);

  const eventOrder = useMemo(() => new Map(events.map((e, i) => [e.id, i])), [events]);

  const lanes = laneCount(placements);
  // Every lane is at least as thick as the thickest label on screen, so
  // names in neighbouring lanes can't overlap.
  const laneSize = laneSizeFor(
    placements.map((p) => p.item.label.across),
    MIN_LANE_SIZE
  );
  const stackExtent = lanes * laneSize;
  const stackAxisSize =
    orientation.axis === "horizontal" ? viewportSize.height : viewportSize.width;
  const overflowing = stackExtent > stackAxisSize;
  const placedLanes = placements.map((p) => p.lane);
  const hidden = overflowing
    ? stackOverflow(placedLanes, laneSize, stackAxisSize, stackOffset)
    : { towardBase: 0, beyond: 0 };
  const sides = stackSides(orientation.base);
  // How many events don't fit, independent of the scroll position: what
  // is hidden when the view is at the base.
  const notFitting = overflowing ? stackOverflow(placedLanes, laneSize, stackAxisSize, 0).beyond : 0;

  const viewport: Viewport = {
    width: viewportSize.width,
    height: Math.max(viewportSize.height, orientation.axis === "horizontal" ? stackExtent : 0),
    laneSize,
  };
  if (orientation.axis === "vertical") {
    viewport.width = Math.max(viewportSize.width, stackExtent);
  }

  /**
   * Keeps the view the same distance from the base whenever the stack's
   * size or the layout changes -- which also opens it *at* the base.
   * Without this, a base at the bottom (the default) or the right opened
   * at scroll position 0: the lanes furthest from the base, with the base
   * itself out of view.
   */
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    if (!overflowing) {
      stackOffsetRef.current = 0;
      setStackOffset(0);
      return;
    }
    const position = scrollForStackOffset(orientation.base, stackOffsetRef.current, element);
    if ("top" in position) element.scrollTop = position.top;
    else element.scrollLeft = position.left;
    const actual = stackOffsetFromScroll(orientation.base, element);
    stackOffsetRef.current = actual;
    setStackOffset(actual);
    // The scrollbar runs along the time axis's far side; clientLeft and
    // clientTop are the border widths.
    const gutter =
      orientation.axis === "horizontal"
        ? element.offsetWidth - element.clientWidth - 2 * element.clientLeft
        : element.offsetHeight - element.clientHeight - 2 * element.clientTop;
    setScrollbarGutter(Math.max(0, gutter));
  }, [overflowing, stackExtent, stackAxisSize, orientation.axis, orientation.base]);

  function handleScroll() {
    const element = containerRef.current;
    if (!element || !overflowing) return;
    const offset = stackOffsetFromScroll(orientation.base, element);
    stackOffsetRef.current = offset;
    const target = scrollTargetRef.current;
    if (target && Math.abs(target.offset - offset) < 1) scrollTargetRef.current = null;
    const after = stackOverflow(placedLanes, laneSize, stackAxisSize, offset);
    if (after.towardBase !== hidden.towardBase || after.beyond !== hidden.beyond) {
      setStackOffset(offset);
    }
  }

  /** Scrolls one view's worth toward the hidden events, less a lane, so
   * the last lane seen stays in view for context. */
  function scrollStack(toward: "base" | "beyond") {
    const element = containerRef.current;
    if (!element) return;
    const page = Math.max(laneSize, stackAxisSize - laneSize);
    // A smooth scroll still under way counts as having arrived; one that
    // was interrupted (by the user scrolling) stops counting after a
    // second.
    const pending = scrollTargetRef.current;
    const from =
      pending && Date.now() - pending.at < SCROLL_TARGET_TTL_MS
        ? pending.offset
        : stackOffsetRef.current;
    const position = scrollForStackOffset(
      orientation.base,
      from + (toward === "beyond" ? page : -page),
      element
    );
    // Clamped, so it is a place the view can actually reach.
    scrollTargetRef.current = {
      offset: stackOffsetFromScroll(orientation.base, {
        ...scrollBoxOf(element),
        scrollTop: "top" in position ? position.top : 0,
        scrollLeft: "left" in position ? position.left : 0,
      }),
      at: Date.now(),
    };
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof element.scrollTo === "function") {
      element.scrollTo({ ...position, behavior: reduceMotion ? "auto" : "smooth" });
    } else if ("top" in position) {
      element.scrollTop = position.top;
    } else {
      element.scrollLeft = position.left;
    }
  }

  const nowFraction = timeFraction(new Date(now), viewStart, viewEnd);
  const currentScale = snapToScale(spanSeconds);

  function beginDrag(
    e: React.PointerEvent,
    event: DecryptedEvent,
    mode: DragMode,
    occurrence: Date | null
  ) {
    if (!event.canEdit) return;
    e.preventDefault();
    e.stopPropagation();
    commitNudge();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    // Build on any change still being saved, not the stale stored copy.
    const current = latestTimes(event, occurrence);
    setDrag({
      eventId: event.id,
      occurrence,
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
    // Measured against the canvas, not the viewport: when the stack is
    // scrolled, the canvas's rect carries the scroll offset.
    const bounds = canvasRef.current?.getBoundingClientRect();
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
    const { eventId, preview, occurrence } = drag;
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
    if (!event) return;
    await enqueueSave(eventId, preview, occurrence, targetName(event, occurrence));
  }

  function updateKeyTarget(next: KeyTarget | null) {
    keyTargetRef.current = next;
    setKeyTarget(next);
  }

  function updateNudge(next: Nudge | null) {
    nudgeRef.current = next;
    setNudge(next);
  }

  function updateSaving(next: ReadonlyMap<string, Saving>) {
    savingRef.current = next;
    setSaving(next);
  }

  /** The times a drag or nudge starts from: the series', or one
   * occurrence's, including any change still being saved. */
  function latestTimes(
    event: DecryptedEvent,
    occurrence: Date | null
  ): { startTime: string; endTime?: string } {
    const latest = withInFlight(event, savingRef.current);
    if (occurrence) return occurrenceTimes(latest, occurrence);
    return { startTime: latest.startTime, endTime: latest.endTime };
  }

  /**
   * Queues a save behind any earlier one and shows it until it lands. The
   * change is applied on top of whatever is still in flight for the
   * event, so a rank saved a moment ago isn't lost by a later move, and
   * the save carries both.
   */
  function enqueueSave(
    eventId: string,
    preview: TimelineChange,
    occurrence: Date | null,
    name: string
  ): Promise<unknown> {
    const saved = events.find((e) => e.id === eventId);
    if (!saved) return Promise.resolve();
    const inFlight = savingRef.current.get(eventId)?.fields;
    const base = withInFlight(saved, savingRef.current);
    // A moved start carries its monthly/yearly pattern, skips and moves
    // along; a moved occurrence changes only its own override
    // (applyTimelineChange).
    const changes: Partial<EventContent> = {
      ...inFlight,
      ...changedFields(base, applyTimelineChange(base, preview, occurrence)),
    };
    const token = {};
    updateSaving(new Map(savingRef.current).set(eventId, { fields: changes, token }));
    const done = saveChain.current
      .then(() => onChangeRef.current?.(eventId, changes))
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
    void enqueueSave(pending.eventId, preview, pending.occurrence, pending.name);
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
  function handleEventKeyDown(e: React.KeyboardEvent, event: DecryptedEvent, labelled: Occurrence) {
    if (!event.canEdit || !onChangeEvent) return;
    const adjustment = keyboardAdjustment(e.key, e, orientation);
    if (!adjustment) return;
    e.preventDefault();

    if (nudgeRef.current && nudgeRef.current.eventId !== event.id) commitNudge();
    // The target lasts while the label keeps focus (it's reset on focus
    // and blur), and only while that occurrence is still on screen, which
    // keepInView sees to; anything else starts from the label's own.
    const kept = keyTargetRef.current;
    const placed = placements.find((p) => p.item.id === event.id)?.item;
    const stillThere =
      kept?.eventId === event.id &&
      (kept.occurrence === null ||
        placed?.occurrences.some((o) => o.recurrenceId.getTime() === kept.occurrence!.getTime()));
    const target: KeyTarget = stillThere
      ? kept!
      : { eventId: event.id, occurrence: labelled.moved ? labelled.recurrenceId : null };
    if (target !== kept) updateKeyTarget(target);
    const { occurrence } = target;
    // Any other event's change has been sent, so this is either our own
    // unsaved change or nothing.
    const pending = nudgeRef.current;
    const original = pending?.original ?? latestTimes(event, occurrence);
    const current: TimelineChange = pending?.preview ?? { ...original };
    const name = targetName(event, occurrence);

    const next = applyAdjustment(adjustment, event, name, targetName(event, null), current);
    if (!next) return;
    if (adjustment.kind !== "rank") keepInView(event.id, occurrence, adjustment, current, next);

    updateNudge({ eventId: event.id, occurrence, original, preview: next, name });
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(commitNudge, KEYBOARD_COMMIT_DELAY_MS);
  }

  /**
   * Pans so a keyboard change can't carry the event off screen, which
   * would unmount its label and drop keyboard focus. The label sits on the
   * first visible occurrence (pinned to the view's start while that one is
   * already in progress), and a change shifts every occurrence of a series
   * alike, so that occurrence is the one followed -- the first one that
   * isn't moved, since moved ones don't shift with the series. A moved
   * occurrence changed on its own is followed itself. Either way the
   * series stays on screen, so the label (on whichever occurrence is
   * first) does too.
   */
  function keepInView(
    eventId: string,
    occurrence: Date | null,
    adjustment: Exclude<KeyboardAdjustment, { kind: "rank" }>,
    current: TimelineChange,
    next: TimelineChange
  ) {
    const placed = placements.find((p) => p.item.id === eventId)?.item;
    const labelled = occurrence
      ? placed?.occurrences.find((o) => o.recurrenceId.getTime() === occurrence.getTime())
      : placed?.occurrences.find((o) => !o.moved);
    if (!placed || !labelled) return;
    const shift = (from?: string, to?: string) =>
      from && to ? new Date(to).getTime() - new Date(from).getTime() : 0;
    const startMs = labelled.start.getTime();
    const start = { before: startMs, after: startMs + shift(current.startTime, next.startTime) };
    // An occurrence already in progress has its start off screen and its
    // label pinned to the view's start; what can carry it out of view is
    // its end, moving earlier. (Moving later, nothing can.)
    const clipped = startMs < viewStart.getTime();
    const movingEarlier = shift(current.startTime, next.startTime) < 0;
    const followsEnd =
      (adjustment.kind === "resize" && adjustment.edge === "end") ||
      (adjustment.kind === "move" && clipped && movingEarlier);
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
      placed.labelMs
    );
    if (pan !== 0) setCentre((c) => c + pan);
  }

  /** The preview after one key press, announcing the result. Null when
   * there was nothing to do. */
  function applyAdjustment(
    adjustment: KeyboardAdjustment,
    event: DecryptedEvent,
    name: string,
    seriesName: string,
    current: TimelineChange
  ): TimelineChange | null {
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
        labelGapMs
      );
      const raising = adjustment.direction === 1;
      if (!step) {
        setAnnouncement(
          `${capitalise(seriesName)} is already ${raising ? "above" : "below"} every event it overlaps.`
        );
        return null;
      }
      // Priority belongs to the series, which shares one row.
      const other = step.past.event.title?.trim() || "untitled event";
      setAnnouncement(`${capitalise(seriesName)} ${raising ? "raised above" : "lowered below"} ${other}.`);
      return { ...current, rank: step.rank };
    }

    const delta = adjustment.direction * stepMs;
    if (adjustment.kind === "move") {
      const moved = moveEvent(current, delta);
      setAnnouncement(
        `${capitalise(name)} moved to ${format(moved.startTime)}${
          moved.endTime ? ` until ${format(moved.endTime)}` : ""
        }.`
      );
      return { ...current, startTime: moved.startTime, endTime: moved.endTime ?? undefined };
    }

    const resized = resizeEvent(current, adjustment.edge, delta);
    setAnnouncement(
      adjustment.edge === "start"
        ? `${capitalise(name)} starts ${format(resized.startTime)}.`
        : `${capitalise(name)} ends ${format(resized.endTime!)}.`
    );
    return { ...current, startTime: resized.startTime, endTime: resized.endTime ?? undefined };
  }

  const [earlierKey, laterKey] = timeAxisKeys(orientation).map((k) => KEY_NAMES[k]);
  const [towardKey, awayKey] = stackAxisKeys(orientation).map((k) => KEY_NAMES[k]);
  const keysHelp =
    `Arrow keys: ${laterKey} or ${earlierKey} moves the event later or earlier; ` +
    `with Shift, changes its end; with Alt and Shift, changes its start. ` +
    `${awayKey} or ${towardKey} raises or lowers its priority.`;
  const movedKeysHelp =
    `This occurrence was moved. Arrow keys: ${laterKey} or ${earlierKey} moves only this ` +
    `occurrence later or earlier; with Shift, changes its end; with Alt and Shift, its start. ` +
    `${awayKey} or ${towardKey} raises or lowers the whole series' priority.`;

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
  // Attached natively because React's wheel listener is passive, where
  // `preventDefault` does nothing: the wheel would zoom *and* scroll the
  // stack, jerking the view away from the base mid-zoom.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      const factor = Math.exp(e.deltaY * 0.002);
      setSpanSeconds((current) => zoomSpan(current, factor));
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, []);

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
      <p id={movedKeysHelpId} className="visually-hidden">
        {movedKeysHelp}
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

      {/* Announces only how many don't fit, which scrolling doesn't
          change: the per-side counts below change at every lane boundary,
          and as a live region they'd be read out over and over while
          scrolling. */}
      <p className="visually-hidden" role="status">
        {notFitting > 0
          ? `${notFitting} ${
              notFitting === 1 ? "event doesn't" : "events don't"
            } fit in the timeline; scroll it to see them.`
          : ""}
      </p>
      {overflowing && (
        <div className="stack-overflow-note">
          <span data-testid="stack-overflow-summary">{overflowSummary(hidden, sides)}</span>
          {/* Both buttons stay while the stack overflows, disabled rather
              than removed when their side has nothing left, so pressing one
              to the end doesn't drop keyboard focus. aria-disabled, since a
              natively disabled button loses focus too. */}
          {(["beyond", "towardBase"] as const).map((side) => (
            <button
              key={side}
              type="button"
              className="header-link"
              aria-disabled={hidden[side] === 0}
              onClick={() => {
                if (hidden[side] > 0) scrollStack(side === "beyond" ? "beyond" : "base");
              }}
            >
              {SIDE_WORDS[sides[side]].scroll}
            </button>
          ))}
        </div>
      )}

      <div className="timeline-frame">
        {/* Edge cues: a fade and a chevron on each edge with events hidden
            past it. Decorative; the note above says the same in words. */}
        {(["beyond", "towardBase"] as const).map((side) =>
          overflowing && hidden[side] > 0 ? (
            <div
              key={side}
              className={`stack-cue stack-cue-${sides[side]}`}
              style={
                orientation.axis === "horizontal"
                  ? { right: 1 + scrollbarGutter }
                  : { bottom: 1 + scrollbarGutter }
              }
              aria-hidden="true"
            >
              <span className="stack-cue-chevron" />
            </div>
          ) : null
        )}
        <div
          className={`timeline-viewport timeline-${orientation.axis} direction-${orientation.direction} base-${orientation.base}${
            overflowing ? " timeline-scrollable" : ""
          }`}
          ref={containerRef}
          tabIndex={0}
          aria-label="Timeline events"
          onScroll={handleScroll}
          onPointerDown={beginPan}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <div
            className="timeline-canvas"
            ref={canvasRef}
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
              const toBase = fillToBase(lane, orientation, viewport.laneSize);

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
                      viewport
                    );
                    // The name belongs to the series, not to each repeat, so
                    // only the first visible occurrence carries it.
                    const isFirst = index === 0;
                    // Dragging, resizing and arrow keys change the whole
                    // series -- except on a moved occurrence, which isn't
                    // where the series puts it and wouldn't follow: there
                    // they change only that occurrence.
                    const target = occurrence.moved ? occurrence.recurrenceId : null;
                    const what = targetName(event, target);
                    // The key help describes what the arrow keys will
                    // change, which is kept while the label has focus even
                    // if the label passes to another occurrence.
                    const keysMoveOccurrence =
                      keyTarget?.eventId === event.id
                        ? keyTarget.occurrence !== null
                        : occurrence.moved;

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
                        {/* The event stays in its lane; only its fill
                            reaches down to the base, and lets clicks
                            through to whatever is in the lanes below. */}
                        <div
                          className={`event-modal-fill fade-${orientation.base}${
                            openEnded ? " fade-open-ended" : ""
                          }`}
                          style={{ [toBase.side]: -toBase.px }}
                          aria-hidden="true"
                        />

                        {event.canEdit && (
                          <>
                            <span
                              className="resize-handle resize-start"
                              role="separator"
                              aria-label={`Adjust start of ${what}`}
                              onPointerDown={(e) =>
                                beginDrag(e, event, { kind: "resize", edge: "start" }, target)
                              }
                            />
                            <span
                              className="resize-handle resize-end"
                              role="separator"
                              aria-label={`Adjust end of ${what}`}
                              onPointerDown={(e) =>
                                beginDrag(e, event, { kind: "resize", edge: "end" }, target)
                              }
                            />
                          </>
                        )}

                        {isFirst && (
                          <button
                            type="button"
                            className="event-modal-label"
                            data-label-key={labelKey(event)}
                            aria-describedby={
                              event.canEdit && onChangeEvent
                                ? keysMoveOccurrence
                                  ? movedKeysHelpId
                                  : keysHelpId
                                : undefined
                            }
                            onPointerDown={(e) => beginDrag(e, event, { kind: "move" }, target)}
                            onKeyDown={(e) => handleEventKeyDown(e, event, occurrence)}
                            // Each focus starts afresh from the occurrence the
                            // label is on (a label unmounted while focused
                            // never blurs).
                            onFocus={() => updateKeyTarget(null)}
                            onBlur={() => {
                              updateKeyTarget(null);
                              commitNudge();
                            }}
                            onClick={(e) =>
                              void openEvent(
                                event,
                                (e.currentTarget as Element).getBoundingClientRect(),
                                // Which occurrence it is, not where it is now:
                                // a moved one is skipped or moved again by
                                // the start the series gives it.
                                occurrence.recurrenceId
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
      </div>
    </section>
  );
}

/** The overflow note's text: "3 more events above." or, scrolled part
 * way, "3 more events above, 2 below." */
function overflowSummary(
  hidden: { towardBase: number; beyond: number },
  sides: { towardBase: BaseEdge; beyond: BaseEdge }
): string {
  const [first, second] = (["beyond", "towardBase"] as const)
    .filter((side) => hidden[side] > 0)
    .map((side) => ({ count: hidden[side], where: SIDE_WORDS[sides[side]].where }));
  // Overflowing by less than a lane: every event is (just) in view.
  if (!first) return "Scroll the timeline to see the rest of the stack.";
  const lead = `${first!.count} more ${first!.count === 1 ? "event" : "events"} ${first!.where}`;
  return second ? `${lead}, ${second.count} ${second.where}.` : `${lead}.`;
}

function scrollBoxOf(element: HTMLElement): Omit<ScrollBox, "scrollTop" | "scrollLeft"> {
  return {
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
  };
}
