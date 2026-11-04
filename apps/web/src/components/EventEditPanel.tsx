import { useEffect, useRef, useState } from "react";
import { MAX_OCCURRENCE_OVERRIDES, type EventContent, type RecurrenceRule } from "@schedule-app/shared";
import type { DecryptedEvent } from "../lib/events.js";
import { RecurrenceFields } from "./RecurrenceFields.js";
import {
  activeOverrides,
  describeRecurrence,
  exceptionsFollowingStart,
  findOverride,
  withOverride,
  withoutOverride,
  withoutSkippedOccurrence,
} from "../lib/recurrence.js";
import { toLocalInput, fromLocalInput, dateFromLocalInput, validateTimes } from "../lib/datetime.js";

interface EventEditPanelProps {
  event: DecryptedEvent;
  /** Where on screen the event's modal sits, so the panel can visibly grow
   * out of it rather than appearing from nowhere. */
  origin?: { left: number; top: number; width: number; height: number } | null;
  /** The occurrence that was opened, by the start the series gives it.
   * With it, a repeating event offers to change just that occurrence. */
  occurrence?: Date;
  /** Resolves true once saved. */
  onSave: (changes: Partial<EventContent>) => Promise<boolean>;
  /** Delete for everyone. Only offered with an edit capability. */
  onDelete: () => void;
  /** Remove from this schedule only. Offered when the event is view-only. */
  onLeave: () => void;
  onShare: () => void;
  onClose: () => void;
  /** A save failure reported by the owner, shown here because the panel
   * covers wherever else it would appear. */
  saveError?: string | null;
}

const ANIMATION_MS = 180;
const formatDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function EventEditPanel({
  event,
  origin,
  occurrence,
  onSave,
  onDelete,
  onLeave,
  onShare,
  onClose,
  saveError,
}: EventEditPanelProps) {
  const readOnly = !event.canEdit;
  const [title, setTitle] = useState(event.title ?? "");
  // The inputs show minutes, but stored times can carry seconds (new events
  // default to "now" to the second). Remember what the fields started as so
  // an untouched field saves the original instant: rounding it would shift
  // a recurring series, and its skipped occurrences would stop matching.
  const [initialStart] = useState(() => toLocalInput(new Date(event.startTime)));
  const [initialEnd] = useState(() => (event.endTime ? toLocalInput(new Date(event.endTime)) : ""));
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(initialEnd);
  const [important, setImportant] = useState(Boolean(event.important));
  const [recurrence, setRecurrence] = useState<RecurrenceRule | undefined>(event.recurrence);
  // The moves that apply. Decrypted content is untrusted, and moves left
  // behind by a change to the series no longer apply: neither is shown,
  // and saving a move drops them.
  const moved = activeOverrides(event);

  // Changing one occurrence of a series moves it (an override) and leaves
  // the rest; only its times can differ. Offered for an occurrence of a
  // series this account can edit.
  const canMoveOne = !readOnly && Boolean(event.recurrence) && occurrence !== undefined;
  const [scope, setScope] = useState<"series" | "occurrence">("series");
  const onlyThisOne = canMoveOne && scope === "occurrence";
  // Where the opened occurrence is now, and where the series alone would
  // put it. Untouched fields save these exact instants, as above.
  const [occurrenceTimes] = useState(() => {
    if (!occurrence) return null;
    const seriesEnd = event.endTime
      ? new Date(occurrence.getTime() + new Date(event.endTime).getTime() - new Date(event.startTime).getTime())
      : null;
    const series = { startTime: occurrence.toISOString(), endTime: seriesEnd?.toISOString() };
    const override = findOverride(moved, occurrence);
    return { series, current: override ? { startTime: override.startTime, endTime: override.endTime } : series };
  });
  const [initialOccurrenceStart] = useState(() =>
    occurrenceTimes ? toLocalInput(new Date(occurrenceTimes.current.startTime)) : ""
  );
  const [initialOccurrenceEnd] = useState(() =>
    occurrenceTimes?.current.endTime ? toLocalInput(new Date(occurrenceTimes.current.endTime)) : ""
  );
  const [occurrenceStart, setOccurrenceStart] = useState(initialOccurrenceStart);
  const [occurrenceEnd, setOccurrenceEnd] = useState(initialOccurrenceEnd);
  // What the repeat patterns are derived from; untouched, the exact start.
  const startDate = start === initialStart ? new Date(event.startTime) : dateFromLocalInput(start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Drives both the opening and closing animation; closing waits for it to
  // finish so the panel visibly collapses back rather than vanishing.
  const [open, setOpen] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpen(true));
    // Focus moves into the panel so keyboard users aren't left behind on
    // the timeline.
    const focusTimer = setTimeout(() => titleRef.current?.focus(), ANIMATION_MS);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(focusTimer);
    };
  }, []);

  function requestClose() {
    setOpen(false);
    setTimeout(onClose, ANIMATION_MS);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") requestClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(changes: Partial<EventContent>, closeAfter: boolean) {
    setBusy(true);
    const saved = await onSave(changes);
    setBusy(false);
    if (saved && closeAfter) requestClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (onlyThisOne && occurrence && occurrenceTimes) {
      await saveOccurrence(occurrence, occurrenceTimes);
      return;
    }
    if (!title.trim()) {
      setError("Give the event a title.");
      return;
    }
    const startTime = start === initialStart ? event.startTime : fromLocalInput(start);
    const endTime = end === initialEnd ? event.endTime : fromLocalInput(end);
    const invalid = validateTimes(startTime, endTime);
    if (invalid) {
      setError(invalid);
      return;
    }
    // Clearing the end makes the event open-ended again rather than being
    // an error; clearing the repeat makes it a one-off. Skips and moves
    // follow a moved start where the rule allows it.
    await save(
      {
        title: title.trim(),
        startTime,
        endTime,
        important,
        recurrence,
        ...(startTime ? exceptionsFollowingStart(event, startTime, recurrence) : {}),
      },
      true
    );
  }

  async function saveOccurrence(
    which: Date,
    times: { series: { startTime: string; endTime?: string }; current: { startTime: string; endTime?: string } }
  ) {
    const startTime =
      occurrenceStart === initialOccurrenceStart ? times.current.startTime : fromLocalInput(occurrenceStart);
    const endTime = occurrenceEnd === initialOccurrenceEnd ? times.current.endTime : fromLocalInput(occurrenceEnd);
    const invalid = validateTimes(startTime, endTime);
    if (invalid || startTime === undefined) {
      setError(invalid);
      return;
    }
    // Moved back to exactly where the series has it, it is no longer moved.
    const sameInstant = (a?: string, b?: string) =>
      a === undefined || b === undefined ? a === b : new Date(a).getTime() === new Date(b).getTime();
    const backInPlace =
      sameInstant(startTime, times.series.startTime) && sameInstant(endTime, times.series.endTime);
    const occurrenceOverrides = backInPlace
      ? withoutOverride(moved, which)
      : withOverride(moved, which, { startTime, endTime });
    if (occurrenceOverrides.length > MAX_OCCURRENCE_OVERRIDES) {
      setError(`At most ${MAX_OCCURRENCE_OVERRIDES} occurrences can be moved. Put some back first.`);
      return;
    }
    await save({ occurrenceOverrides }, true);
  }

  const skipped = event.skippedOccurrences ?? [];

  // Animate outward from where the event sits, so it's obvious which one
  // is being edited without pinning the panel to the timeline.
  const originStyle = origin
    ? ({
        "--origin-x": `${origin.left + origin.width / 2}px`,
        "--origin-y": `${origin.top + origin.height / 2}px`,
      } as React.CSSProperties)
    : undefined;

  return (
    <div className={`edit-overlay${open ? " edit-overlay-open" : ""}`} onClick={requestClose}>
      <div
        className={`edit-panel${open ? " edit-panel-open" : ""}`}
        style={originStyle}
        role="dialog"
        aria-modal="true"
        aria-label={`${readOnly ? "View" : "Edit"} ${event.title || "untitled event"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit} className="edit-form">
          {readOnly && (
            <p className="field-hint">
              Shared with you to view. You can&rsquo;t change it, but you can remove it
              from your schedule.
            </p>
          )}

          {canMoveOne && (
            <fieldset className="edit-scope">
              <legend>Change</legend>
              <label className="checkbox-label">
                <input
                  type="radio"
                  name="edit-scope"
                  checked={scope === "series"}
                  onChange={() => setScope("series")}
                />
                Every occurrence
              </label>
              <label className="checkbox-label">
                <input
                  type="radio"
                  name="edit-scope"
                  checked={scope === "occurrence"}
                  onChange={() => setScope("occurrence")}
                />
                Only this one ({formatDate.format(occurrence)})
              </label>
            </fieldset>
          )}

          <fieldset disabled={readOnly} className="edit-fields">
            <label>
              Title
              <input
                ref={titleRef}
                // Shows the series' own title while it can't be changed, so
                // an unsaved edit doesn't look as if it will be saved.
                value={onlyThisOne ? event.title : title}
                disabled={onlyThisOne}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>

            {onlyThisOne ? (
              <>
                <p className="field-hint">
                  Only this occurrence&rsquo;s times change. Everything else belongs to the series.
                </p>
                <label>
                  Starts
                  <input
                    type="datetime-local"
                    value={occurrenceStart}
                    onChange={(e) => setOccurrenceStart(e.target.value)}
                  />
                </label>
                <label>
                  Ends <span className="field-hint">(leave empty for open-ended)</span>
                  <input
                    type="datetime-local"
                    value={occurrenceEnd}
                    onChange={(e) => setOccurrenceEnd(e.target.value)}
                  />
                </label>
              </>
            ) : (
              <>
                <label>
                  Starts
                  <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
                </label>

                <label>
                  Ends <span className="field-hint">(leave empty for open-ended)</span>
                  <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
                </label>
              </>
            )}

            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={onlyThisOne ? Boolean(event.important) : important}
                disabled={onlyThisOne}
                onChange={(e) => setImportant(e.target.checked)}
              />
              Mark as important
            </label>

            {readOnly ? (
              event.recurrence && <p className="event-recurrence">{describeRecurrence(event.recurrence)}</p>
            ) : (
              !onlyThisOne && <RecurrenceFields value={recurrence} onChange={setRecurrence} start={startDate} />
            )}
          </fieldset>

          {moved.length > 0 && (
            <section className="skipped-occurrences" aria-label="Moved occurrences">
              <h3>Moved</h3>
              <ul>
                {moved.map((override) => {
                  const from = formatDate.format(new Date(override.occurrence));
                  const to = formatDate.format(new Date(override.startTime));
                  return (
                    <li key={override.occurrence}>
                      <span>
                        {from} &rarr; {to}
                      </span>
                      {!readOnly && (
                        <button
                          type="button"
                          className="header-link"
                          disabled={busy}
                          onClick={() =>
                            save(
                              {
                                occurrenceOverrides: withoutOverride(moved, new Date(override.occurrence)),
                              },
                              false
                            )
                          }
                          aria-label={`Put ${from} back`}
                        >
                          Put back
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {skipped.length > 0 && (
            <section className="skipped-occurrences" aria-label="Skipped occurrences">
              <h3>Skipped</h3>
              <ul>
                {skipped.map((iso) => (
                  <li key={iso}>
                    <span>{formatDate.format(new Date(iso))}</span>
                    {!readOnly && (
                      <button
                        type="button"
                        className="header-link"
                        disabled={busy}
                        onClick={() =>
                          save(
                            { skippedOccurrences: withoutSkippedOccurrence(skipped, new Date(iso)) },
                            false
                          )
                        }
                        aria-label={`Restore ${formatDate.format(new Date(iso))}`}
                      >
                        Restore
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(error ?? saveError) && (
            <p className="auth-error" role="alert">
              {error ?? saveError}
            </p>
          )}

          <div className="edit-actions">
            {!readOnly && (
              <button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </button>
            )}
            <button type="button" className="header-link" onClick={requestClose}>
              {readOnly ? "Close" : "Cancel"}
            </button>
            {!readOnly && (
              <button type="button" className="header-link" onClick={onShare}>
                Share
              </button>
            )}
            {readOnly ? (
              <button type="button" className="edit-delete" onClick={onLeave}>
                Remove from my schedule
              </button>
            ) : (
              <button type="button" className="edit-delete" onClick={onDelete}>
                Delete
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
