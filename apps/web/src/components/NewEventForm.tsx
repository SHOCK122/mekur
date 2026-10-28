import { useEffect, useState } from "react";
import type { EventContent, RecurrenceRule } from "@schedule-app/shared";
import { RecurrenceFields } from "./RecurrenceFields.js";
import { toLocalInput, fromLocalInput, validateTimes } from "../lib/datetime.js";

interface NewEventFormProps {
  /** Resolves true when the event was saved, so the form knows to reset. */
  onCreate: (content: EventContent) => Promise<boolean>;
  /** Places the new event in the stacking order (fractional rank). */
  nextRank: () => string;
}

export function NewEventForm({ onCreate, nextRank }: NewEventFormProps) {
  const [title, setTitle] = useState("");
  const [start, setStart] = useState(() => toLocalInput(new Date(), true));
  // Until the person edits the start field it follows the clock, so a new
  // event defaults to "right now" rather than to when the page loaded.
  const [startTouched, setStartTouched] = useState(false);
  const [end, setEnd] = useState("");
  const [recurrence, setRecurrence] = useState<RecurrenceRule | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (startTouched) return;
    const timer = setInterval(() => setStart(toLocalInput(new Date(), true)), 1000);
    return () => clearInterval(timer);
  }, [startTouched]);

  function reset() {
    setTitle("");
    setStart(toLocalInput(new Date(), true));
    setStartTouched(false);
    setEnd("");
    setRecurrence(undefined);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim()) return;

    // An event needs only a title: it starts now unless told otherwise,
    // and may be open-ended.
    const startTime = fromLocalInput(start) ?? new Date().toISOString();
    const endTime = fromLocalInput(end);
    const invalid = validateTimes(startTime, endTime);
    if (invalid) {
      setError(invalid);
      return;
    }

    setBusy(true);
    const saved = await onCreate({ title: title.trim(), startTime, endTime, recurrence, rank: nextRank() });
    setBusy(false);
    if (saved) reset();
  }

  return (
    <form onSubmit={handleSubmit} className="event-form" aria-label="New event">
      <input
        placeholder="Event title"
        aria-label="Event title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        required
      />
      <div className="event-form-row">
        <input
          type="datetime-local"
          step={1}
          value={start}
          onChange={(e) => {
            // Once touched, stop tracking the clock -- otherwise the field
            // would overwrite whatever was just typed.
            setStartTouched(true);
            setStart(e.target.value);
          }}
          aria-label="Start time"
        />
        <input
          type="datetime-local"
          step={1}
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          aria-label="End time (optional)"
        />
      </div>

      <RecurrenceFields value={recurrence} onChange={setRecurrence} />

      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}

      <button type="submit" disabled={busy}>
        {busy ? "Adding…" : "Add event"}
      </button>
    </form>
  );
}
