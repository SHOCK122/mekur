import { useEffect, useState } from "react";
import { listEvents, createEvent, deleteEvent, type DecryptedEvent } from "../lib/api.js";
import type { Session } from "../lib/session.js";

interface CalendarProps {
  session: Session;
  onLogout: () => void;
}

function formatRange(startTime: string, endTime: string): string {
  const start = new Date(startTime);
  const end = new Date(endTime);
  const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
  const timeFmt = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
  return `${dateFmt.format(start)} \u00b7 ${timeFmt.format(start)}\u2013${timeFmt.format(end)}`;
}

export function Calendar({ session, onLogout }: CalendarProps) {
  const [events, setEvents] = useState<DecryptedEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const list = await listEvents(session);
      list.sort((a, b) => a.startTime.localeCompare(b.startTime));
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

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!title || !start || !end) return;
    try {
      await createEvent(session, {
        title,
        startTime: new Date(start).toISOString(),
        endTime: new Date(end).toISOString(),
      });
      setTitle("");
      setStart("");
      setEnd("");
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
        <button type="submit">Add event</button>
      </form>

      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p>Loading&hellip;</p>
      ) : events.length === 0 ? (
        <p className="empty-state">No events yet. Add your first one above.</p>
      ) : (
        <ul className="event-list">
          {events.map((event) => (
            <li key={event.id} className="event-item">
              <div>
                <strong>{event.title}</strong>
                <div className="event-time">{formatRange(event.startTime, event.endTime)}</div>
              </div>
              <button type="button" onClick={() => handleDelete(event.id)} aria-label={`Delete ${event.title}`}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
