import { useEffect, useMemo, useState } from "react";
import type { EventContent } from "@schedule-app/shared";
import {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  validateEventTimes,
  type DecryptedEvent,
} from "../lib/events.js";
import {
  expandOccurrences,
  describeRecurrence,
  withSkippedOccurrence,
  withoutSkippedOccurrence,
  buildRecurrenceRule,
} from "../lib/recurrence.js";
import { loadEventCache, saveEventCache } from "../lib/eventCache.js";
import { toLocalInputValue } from "../lib/dateInput.js";
import { getErrorMessage } from "../lib/http.js";
import { NotificationToggle } from "./NotificationToggle.js";
import { ShareEvent } from "./ShareEvent.js";
import { Timeline } from "./Timeline.js";
import { EventEditPanel } from "./EventEditPanel.js";
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

// "Now" is exact to the second so it stays current while the field is
// still following the clock (see startTouched below).
const toLocalInput = (date: Date) => toLocalInputValue(date, { seconds: true });

export function Calendar({ session, onLogout }: CalendarProps) {
  const [events, setEvents] = useState<DecryptedEvent[]>(() => loadEventCache(session.userId) ?? []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [sharingEventId, setSharingEventId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editOrigin, setEditOrigin] = useState<DOMRect | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [showViewOptions, setShowViewOptions] = useState(false);
  // The timeline is now the primary view: it edits, resizes, re-ranks and
  // deletes. The list is retained as a debugging surface and an
  // accessibility fallback on very small screens, and is slated for
  // removal once the timeline is confirmed to cover both.
  const [view, setView] = useState<"timeline" | "list">("timeline");
  // Deleting a recurring event is ambiguous -- this occurrence, or all of
  // them? Rather than guess, hold the pending delete until the person says.
  const [pendingDelete, setPendingDelete] = useState<{
    eventId: string;
    occurrenceStart: Date;
    title: string;
  } | null>(null);

  const [title, setTitle] = useState("");
  const [start, setStart] = useState(() => toLocalInput(new Date()));
  // Tracks whether the person has edited the start field. Until they do,
  // it follows the clock so a new event defaults to "right now".
  const [startTouched, setStartTouched] = useState(false);
  const [end, setEnd] = useState("");
  const [repeatEnabled, setRepeatEnabled] = useState(false);
  const [customInterval, setCustomInterval] = useState(1);
  const [customUnit, setCustomUnit] = useState<CustomUnit>("DAILY");
  const [repeatUntil, setRepeatUntil] = useState("");

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
        setError(getErrorMessage(err, "Could not load events"));
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (startTouched) return;
    const timer = setInterval(() => setStart(toLocalInput(new Date())), 1000);
    return () => clearInterval(timer);
  }, [startTouched]);

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
    if (!title) return;

    // An event needs only a title: it starts now unless told otherwise,
    // and may be open-ended.
    const startIso = (start ? new Date(start) : new Date()).toISOString();
    const endIso = end ? new Date(end).toISOString() : undefined;
    try {
      validateEventTimes(startIso, endIso);
    } catch (err) {
      setError(getErrorMessage(err, "End time must be after the start time."));
      return;
    }

    const newContent = {
      title,
      startTime: startIso,
      endTime: endIso,
      priority: 0,
      recurrence: buildRecurrenceRule(repeatEnabled, customUnit, customInterval, repeatUntil),
    };

    try {
      await createEvent(session, newContent);
      setTitle("");
      setStart(toLocalInput(new Date()));
      setStartTouched(false);
      setEnd("");
      setRepeatEnabled(false);
      setRepeatUntil("");
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err, "Could not create event"));
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
      setError(getErrorMessage(err, "Could not update priority"));
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
      setError(getErrorMessage(err, "Could not update priority"));
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
      setError(getErrorMessage(err, "Could not skip that occurrence"));
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
      setError(getErrorMessage(err, "Could not restore that occurrence"));
    }
  }

  /** Persists a change to one event. Shared by timeline dragging and the
   * edit panel so both go through the same validation and refresh path. */
  async function handleChangeEvent(eventId: string, changes: Partial<DecryptedEvent>) {
    const target = events.find((e) => e.id === eventId);
    if (!target) return;
    setError(null);
    try {
      const { id, canEdit, updatedAt, ...content } = { ...target, ...changes };
      await updateEvent(session, eventId, content);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err, "Could not save the change"));
    }
  }

  async function handleDelete(id: string) {
    setPendingDelete(null);
    try {
      await deleteEvent(session, id);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err, "Could not delete event"));
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


      <div className="view-toggle">
        <button
          type="button"
          className="header-link"
          aria-expanded={showViewOptions}
          onClick={() => setShowViewOptions((v) => !v)}
        >
          {showViewOptions ? "Hide view options" : "View options"}
        </button>
        {showViewOptions && (
          <div className="view-toggle-buttons" role="group" aria-label="View">
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
        )}
      </div>

      {view === "timeline" && (
        <Timeline
          events={events}
          onEditEvent={(id, origin) => {
            setEditOrigin(origin);
            setEditingId(id);
          }}
          onChangeEvent={handleChangeEvent}
        />
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
            step={1}
            value={start}
            onChange={(e) => {
              // Once touched, stop tracking the clock -- otherwise the
              // field would overwrite whatever was just typed.
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
            placeholder="Optional"
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
            <label className="inline-label">
              Repeat until <span className="field-hint">(optional)</span>
              <input
                type="date"
                value={repeatUntil}
                onChange={(e) => setRepeatUntil(e.target.value)}
                aria-label="Repeat until"
              />
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

      {editingId && (() => {
        const editing = events.find((e) => e.id === editingId);
        if (!editing) return null;
        return (
          <EventEditPanel
            event={editing}
            origin={editOrigin}
            onSave={(changes) => handleChangeEvent(editingId, changes)}
            onDelete={() => {
              setEditingId(null);
              void requestDelete(editing, new Date(editing.startTime));
            }}
            onClose={() => setEditingId(null)}
          />
        );
      })()}
    </div>
  );
}
