import { useEffect, useRef, useState } from "react";
import type { EventContent, RecurrenceRule } from "@schedule-app/shared";
import type { DecryptedEvent } from "../lib/events.js";
import { RecurrenceFields } from "./RecurrenceFields.js";
import { describeRecurrence, withoutSkippedOccurrence } from "../lib/recurrence.js";
import { toLocalInput, fromLocalInput, validateTimes } from "../lib/datetime.js";

interface EventEditPanelProps {
  event: DecryptedEvent;
  /** Where on screen the event's modal sits, so the panel can visibly grow
   * out of it rather than appearing from nowhere. */
  origin?: { left: number; top: number; width: number; height: number } | null;
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
    // an error; clearing the repeat makes it a one-off.
    await save({ title: title.trim(), startTime, endTime, important, recurrence }, true);
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

          <fieldset disabled={readOnly} className="edit-fields">
            <label>
              Title
              <input ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>

            <label>
              Starts
              <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            </label>

            <label>
              Ends <span className="field-hint">(leave empty for open-ended)</span>
              <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
            </label>

            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={important}
                onChange={(e) => setImportant(e.target.checked)}
              />
              Mark as important
            </label>

            {readOnly ? (
              event.recurrence && <p className="event-recurrence">{describeRecurrence(event.recurrence)}</p>
            ) : (
              <RecurrenceFields value={recurrence} onChange={setRecurrence} />
            )}
          </fieldset>

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
