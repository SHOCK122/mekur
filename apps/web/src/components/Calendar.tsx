import { useEffect, useMemo, useState } from "react";
import type { EventPriority, RecurrenceRule } from "@schedule-app/shared";
import { listEvents, createEvent, deleteEvent, type DecryptedEvent } from "../lib/api.js";
import { expandOccurrences, describeRecurrence } from "../lib/recurrence.js";
import type { Session } from "../lib/session.js";

interface CalendarProps {
  session: Session;
  onLogout: () => void;
}

type RepeatPreset = "none" | "daily" | "weekly" | "weekdays" | "custom";
type CustomUnit = "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY";

function buildRecurrence(
  preset: RepeatPreset,
  customInterval: number,
  customUnit: CustomUnit
): RecurrenceRule | undefined {
  switch (preset) {
    case "none":
      return undefined;
    case "daily":
      return { freq: "DAILY", interval: 1 };
    case "weekly":
      return { freq: "WEEKLY", interval: 1 };
    case "weekdays":
      return { freq: "WEEKLY", interval: 1, byDay: ["MO", "TU", "WE", "TH", "FR"] };
    case "custom":
      return { freq: customUnit, interval: Math.max(1, customInterval) };
  }
}

function formatDateTime(date: Date): string {
  const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
  const timeFmt = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
  return `${dateFmt.format(date)} \u00b7 ${timeFmt.format(date)}`;
}

const DISPLAY_WINDOW_DAYS = 90;

export function Calendar({ session, onLogout }: CalendarProps) {
  const [events, setEvents] = useState<DecryptedEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [priority, setPriority] = useState<EventPriority>("medium");
  const [repeatPreset, setRepeatPreset] = useState<RepeatPreset>("none");
  const [customInterval, setCustomInterval] = useState(37);
  const [customUnit, setCustomUnit] = useState<CustomUnit>("MINUTELY");

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const list = await listEvents(session);
      setEvents(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load events");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const occurrences = useMemo(() => {
    const rangeStart = new Date();
    const rangeEnd = new Date(rangeStart.getTime() + DISPLAY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    return events
      .flatMap((event) =>
        expandOccurrences(event, rangeStart, rangeEnd).map((occurrence) => ({ event, occurrence }))
      )
      .sort((a, b) => a.occurrence.start.getTime() - b.occurrence.start.getTime());
  }, [events]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title || !start || !end) return;

    const startIso = new Date(start).toISOString();
    const endIso = new Date(end).toISOString();
    if (new Date(endIso) <= new Date(startIso)) {
      setError("End time must be after the start time.");
      return;
    }

    try {
      await createEvent(session, {
        title,
        startTime: startIso,
        endTime: endIso,
        priority,
        recurrence: buildRecurrence(repeatPreset, customInterval, customUnit),
      });
      setTitle("");
      setStart("");
      setEnd("");
      setPriority("medium");
      setRepeatPreset("none");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create event");
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteEvent(session, id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete event");
    }
  }

  return (
    <div className="calendar">
      <header className="calendar-header">
        <h1>Your schedule</h1>
        <button type="button" className="logout" onClick={onLogout}>
          Sign out
        </button>
      </header>

      <form onSubmit={handleCreate} className="event-form">
        <input
          placeholder="Event title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
        <div className="event-form-row">
          <input
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            required
            aria-label="Start time"
          />
          <input
            type="datetime-local"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            required
            aria-label="End time"
          />
        </div>

        <div className="event-form-row">
          <label className="inline-label">
            Priority
            <select value={priority} onChange={(e) => setPriority(e.target.value as EventPriority)}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>

          <label className="inline-label">
            Repeat
            <select
              value={repeatPreset}
              onChange={(e) => setRepeatPreset(e.target.value as RepeatPreset)}
            >
              <option value="none">Does not repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="weekdays">Every weekday</option>
              <option value="custom">Custom interval\u2026</option>
            </select>
          </label>
        </div>

        {repeatPreset === "custom" && (
          <div className="event-form-row">
            <label className="inline-label">
              Every
              <input
                type="number"
                min={1}
                value={customInterval}
                onChange={(e) => setCustomInterval(Number(e.target.value))}
                aria-label="Custom repeat interval"
              />
            </label>
            <label className="inline-label">
              Unit
              <select value={customUnit} onChange={(e) => setCustomUnit(e.target.value as CustomUnit)}>
                <option value="MINUTELY">Minutes</option>
                <option value="HOURLY">Hours</option>
                <option value="DAILY">Days</option>
                <option value="WEEKLY">Weeks</option>
              </select>
            </label>
          </div>
        )}

        <button type="submit">Add event</button>
      </form>

      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p>Loading&hellip;</p>
      ) : occurrences.length === 0 ? (
        <p className="empty-state">No events yet. Add your first one above.</p>
      ) : (
        <ul className="event-list">
          {occurrences.map(({ event, occurrence }, index) => (
            <li key={`${event.id}-${index}`} className={`event-item priority-${event.priority}`}>
              <div>
                <strong>{event.title}</strong>
                <div className="event-time">{formatDateTime(occurrence.start)}</div>
                {event.recurrence && (
                  <div className="event-recurrence">{describeRecurrence(event.recurrence)}</div>
                )}
              </div>
              <div className="event-item-actions">
                <span className={`priority-badge priority-badge-${event.priority}`}>{event.priority}</span>
                <button
                  type="button"
                  onClick={() => handleDelete(event.id)}
                  aria-label={`Delete ${event.title}`}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
