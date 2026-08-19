import { useEffect, useRef, useState } from "react";
import { validateEventTimes, type DecryptedEvent } from "../lib/events.js";
import { toLocalInputValue } from "../lib/dateInput.js";
import { getErrorMessage } from "../lib/http.js";

interface EventEditPanelProps {
  event: DecryptedEvent;
  /** Where on screen the event's modal sits, so the panel can visibly grow
   * out of it rather than appearing from nowhere. */
  origin?: { left: number; top: number; width: number; height: number } | null;
  onSave: (changes: Partial<DecryptedEvent>) => Promise<void> | void;
  onDelete: () => void;
  onClose: () => void;
}

const ANIMATION_MS = 180;

export function EventEditPanel({
  event,
  origin,
  onSave,
  onDelete,
  onClose,
}: EventEditPanelProps) {
  const [title, setTitle] = useState(event.title ?? "");
  const [start, setStart] = useState(toLocalInputValue(event.startTime));
  const [end, setEnd] = useState(toLocalInputValue(event.endTime));
  const [important, setImportant] = useState(Boolean(event.important));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Drives both the opening and closing animation; closing waits for it to
  // finish so the panel visibly collapses back rather than vanishing.
  const [open, setOpen] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpen(true));
    // Focus moves into the panel so keyboard users aren't left behind on
    // the timeline -- but only if nothing inside the panel has already
    // been focused by the time the animation finishes. Without this guard,
    // a keyboard/fast typist who starts interacting with a different field
    // (e.g. "Ends") before this timer fires gets their focus -- and
    // whatever they were mid-typing -- yanked back to Title.
    const focusTimer = setTimeout(() => {
      if (!panelRef.current?.contains(document.activeElement)) {
        titleRef.current?.focus();
      }
    }, ANIMATION_MS);
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

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!title.trim()) {
      setError("Give the event a title.");
      return;
    }
    if (!start) {
      setError("An event needs a start time.");
      return;
    }
    const startIso = new Date(start).toISOString();
    const endIso = end ? new Date(end).toISOString() : undefined;
    try {
      validateEventTimes(startIso, endIso);
    } catch (err) {
      setError(getErrorMessage(err, "End time must be after the start time."));
      return;
    }

    setBusy(true);
    try {
      await onSave({
        title: title.trim(),
        startTime: startIso,
        // Clearing the field makes the event open-ended again, rather than
        // being an error.
        endTime: endIso,
        important,
      });
      requestClose();
    } catch (err) {
      setError(getErrorMessage(err, "Could not save the event"));
    } finally {
      setBusy(false);
    }
  }

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
        ref={panelRef}
        className={`edit-panel${open ? " edit-panel-open" : ""}`}
        style={originStyle}
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${event.title || "untitled event"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={handleSave} className="edit-form">
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

          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}

          <div className="edit-actions">
            <button type="submit" disabled={busy}>
              {busy ? "Saving\u2026" : "Save"}
            </button>
            <button type="button" className="header-link" onClick={requestClose}>
              Cancel
            </button>
            <button type="button" className="edit-delete" onClick={onDelete}>
              Delete
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
