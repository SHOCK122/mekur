import { useEffect, useMemo, useState } from "react";
import type { EventContent } from "@schedule-app/shared";
import { listEvents, createEvent, updateEvent, deleteEvent, type DecryptedEvent } from "../lib/events.js";
import {
  expandOccurrences,
  describeRecurrence,
  withSkippedOccurrence,
  withoutSkippedOccurrence,
} from "../lib/recurrence.js";
import { loadEventCache, saveEventCache } from "../lib/eventCache.js";
import { NotificationToggle } from "./NotificationToggle.js";
import { ShareEvent } from "./ShareEvent.js";
import { Timeline } from "./Timeline.js";
import type { Session } from "../lib/session.js";

interface CalendarProps {
  session: Session;
  onLogout: () => void;
}

type CustomUnit = "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY";

function formatDateTime(date: Date): string {
  const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
  const timeFmt = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
  return `${dateFmt.format(date)} \u00b7 ${timeFmt.format(date)}`;
}

// The display window is deliberately NOT anchored tightly to "this exact
// instant" on the lower end: an event created moments ago (or earlier
// today) should still show up rather than silently vanish because its
// start time is a few minutes in the past by the time the list re-renders.
const DISPLAY_WINDOW_PAST_DAYS = 30;
const DISPLAY_WINDOW_FUTURE_DAYS = 90;

export function Calendar({ session, onLogout }: CalendarProps) {
  const [events, setEvents] = useState<DecryptedEvent[]>(() => loadEventCache(session.userId) ?? []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [sharingEventId, setSharingEventId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  // Defaults to the list for now because the timeline is still view-only:
  // it has no create, edit, delete or priority controls yet, so making it
  // the default would remove function rather than add it. Flips to
  // timeline-by-default once it reaches parity.
  const [view, setView] = useState<"timeline" | "list">("list");
  // Deleting a recurring event is ambiguous -- this occurrence, or all of
  // them? Rather than guess, hold the pending delete until the person says.
  const [pendingDelete, setPendingDelete] = useState<{
    eventId: string;
    occurrenceStart: Date;
    title: string;
  } | null>(null);

  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [repeatEnabled, setRepeatEnabled] = useState(false);
  const [customInterval, setCustomInterval] = useState(1);
  const [customUnit, setCustomUnit] = useState<CustomUnit>("DAILY");

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const list = await listEvents(session);
      setEvents(list);
      saveEventCache(session.userId, list);
      setOffline(false);
    } catch (err) {
      // A cached copy is still shown (if we have one) so the calendar stays
      // usable offline; this is a status note, not a blocking error.
      const cached = loadEventCache(session.userId);
      if (cached) {
        setEvents(cached);
        setOffline(true);
      } else {
        setError(err instanceof Error ? err.message : "Could not load events");
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const occurrences = useMemo(() => {
    const now = new Date();
    const rangeStart = new Date(now.getTime() - DISPLAY_WINDOW_PAST_DAYS * 24 * 60 * 60 * 1000);
    const rangeEnd = new Date(now.getTime() + DISPLAY_WINDOW_FUTURE_DAYS * 24 * 60 * 60 * 1000);
    return events
      .flatMap((event) =>
        expandOccurrences(event, rangeStart, rangeEnd, { includeSkipped: showSkipped }).map(
          (occurrence) => ({ event, occurrence })
        )
      )
      .sort((a, b) => a.occurrence.start.getTime() - b.occurrence.start.getTime());
  }, [events, showSkipped]);

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

    const newContent = {
      title,
      startTime: startIso,
      endTime: endIso,
      priority: 0,
      recurrence: repeatEnabled ? { freq: customUnit, interval: Math.max(1, customInterval) } : undefined,
    };

    try {
      await createEvent(session, newContent);
      setTitle("");
      setStart("");
      setEnd("");
      setRepeatEnabled(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create event");
    }
  }

  function toContent(event: DecryptedEvent): EventContent {
    const { id, ...content } = event;
    return content;
  }

  /** Moves this event up in priority. */
  async function handlePriorityUp(id: string) {
    const target = events.find((e) => e.id === id);
    if (!target) return;
    try {
      await updateEvent(session, id, { ...toContent(target), priority: target.priority + 1 });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update priority");
    }
  }

  /** Moves this event down in priority by raising every other event instead --
   * priorities only ever increase, so we never need a lower bound or negative
   * numbers to represent "less important". */
  async function handlePriorityDown(id: string) {
    const others = events.filter((e) => e.id !== id);
    if (others.length === 0) return;
    try {
      await Promise.all(
        others.map((e) => updateEvent(session, e.id, { ...toContent(e), priority: e.priority + 1 }))
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update priority");
    }
  }

  async function requestDelete(event: DecryptedEvent, occurrenceStart: Date) {
    if (event.recurrence) {
      setPendingDelete({ eventId: event.id, occurrenceStart, title: event.title });
      return;
    }
    await handleDelete(event.id);
  }

  /** Skipping records an exception on the series rather than creating or
   * deleting rows -- the iCalendar EXDATE approach. */
  async function handleSkipOccurrence(eventId: string, occurrenceStart: Date) {
    const target = events.find((e) => e.id === eventId);
    if (!target) return;
    setPendingDelete(null);
    try {
      const { id, canEdit, updatedAt, ...content } = target;
      await updateEvent(session, eventId, {
        ...content,
        skippedOccurrences: withSkippedOccurrence(target.skippedOccurrences, occurrenceStart),
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not skip that occurrence");
    }
  }

  async function handleRestoreOccurrence(eventId: string, occurrenceStart: Date) {
    const target = events.find((e) => e.id === eventId);
    if (!target) return;
    try {
      const { id, canEdit, updatedAt, ...content } = target;
      await updateEvent(session, eventId, {
        ...content,
        skippedOccurrences: withoutSkippedOccurrence(target.skippedOccurrences, occurrenceStart),
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not restore that occurrence");
    }
  }

  async function handleDelete(id: string) {
    setPendingDelete(null);
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
        <div className="calendar-header-actions">
          <NotificationToggle session={session} />
          <button type="button" className="logout" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </header>

      {offline && (
        <p className="offline-banner" role="status">
          You&rsquo;re offline &mdash; showing your last synced events.
        </p>
      )}


      <div className="view-toggle" role="group" aria-label="View">
        <button
          type="button"
          className={view === "timeline" ? "tab active" : "tab"}
          onClick={() => setView("timeline")}
        >
          Timeline
        </button>
        <button
          type="button"
          className={view === "list" ? "tab active" : "tab"}
          onClick={() => setView("list")}
        >
          List
        </button>
      </div>

      {view === "timeline" && (
        <Timeline events={events} onEditEvent={(id) => setSharingEventId(null) ?? setEditingId(id)} />
      )}

      <button
        type="button"
        className="header-link"
        aria-pressed={showSkipped}
        onClick={() => setShowSkipped((v) => !v)}
      >
        {showSkipped ? "Hide skipped occurrences" : "View skipped occurrences"}
      </button>

      <form onSubmit={handleCreate} className="event-form">
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

        <button
          type="button"
          className="repeat-toggle"
          aria-expanded={repeatEnabled}
          onClick={() => setRepeatEnabled((v) => !v)}
        >
          {repeatEnabled ? "Repeating \u25be" : "Repeat \u25b8"}
        </button>

        {repeatEnabled && (
          <div className="event-form-row repeat-panel">
            <label className="inline-label">
              Every
              <input
                type="number"
                min={1}
                value={customInterval}
                onChange={(e) => setCustomInterval(Number(e.target.value))}
                aria-label="Repeat interval"
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

      {pendingDelete && (
        <div className="delete-choice" role="dialog" aria-label="Delete recurring event">
          <p>
            &ldquo;{pendingDelete.title}&rdquo; repeats. Delete just this one, or the
            whole series?
          </p>
          <div className="delete-choice-actions">
            <button
              type="button"
              onClick={() =>
                handleSkipOccurrence(pendingDelete.eventId, pendingDelete.occurrenceStart)
              }
            >
              Skip this one
            </button>
            <button type="button" onClick={() => handleDelete(pendingDelete.eventId)}>
              Delete whole series
            </button>
            <button type="button" className="header-link" onClick={() => setPendingDelete(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {sharingEventId && (
        <ShareEvent
          session={session}
          eventId={sharingEventId}
          eventTitle={events.find((e) => e.id === sharingEventId)?.title ?? "this event"}
          onClose={() => setSharingEventId(null)}
        />
      )}

      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}

      {view === "list" && loading ? (
        <p role="status" aria-live="polite">Loading&hellip;</p>
      ) : view === "list" && occurrences.length === 0 ? (
        <p className="empty-state">No events yet. Add your first one above.</p>
      ) : view === "list" ? (
        <ul className="event-list">
          {occurrences.map(({ event, occurrence }, index) => (
            <li
              key={`${event.id}-${index}`}
              className={occurrence.skipped ? "event-item event-item-skipped" : "event-item"}
            >
              <div>
                <strong>{event.title}</strong>
                <div className="event-time">{formatDateTime(occurrence.start)}</div>
                {event.recurrence && (
                  <div className="event-recurrence">
                    {describeRecurrence(event.recurrence)}
                    {occurrence.skipped && " \u00b7 skipped"}
                  </div>
                )}
              </div>
              <div className="event-item-actions">
                <div className="priority-controls">
                  <button
                    type="button"
                    className="priority-arrow"
                    onClick={() => handlePriorityUp(event.id)}
                    aria-label={`Raise priority of ${event.title}`}
                    title="More important"
                  >
                    &#9650;
                  </button>
                  <button
                    type="button"
                    className="priority-arrow"
                    onClick={() => handlePriorityDown(event.id)}
                    aria-label={`Lower priority of ${event.title}`}
                    title="Less important"
                  >
                    &#9660;
                  </button>
                </div>
                {event.canEdit && (
                  <button
                    type="button"
                    onClick={() => setSharingEventId(event.id)}
                    aria-label={`Share ${event.title}`}
                  >
                    Share
                  </button>
                )}
                {occurrence.skipped ? (
                  <button
                    type="button"
                    onClick={() => handleRestoreOccurrence(event.id, occurrence.start)}
                    aria-label={`Restore skipped occurrence of ${event.title}`}
                  >
                    Restore
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => requestDelete(event, occurrence.start)}
                    aria-label={`Delete ${event.title}`}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {editingId && (
        <p className="share-status" role="status">
          Editing panel for this event is coming next.{" "}
          <button type="button" className="header-link" onClick={() => setEditingId(null)}>
            Dismiss
          </button>
        </p>
      )}
    </div>
  );
}
