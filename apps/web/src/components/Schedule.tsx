import { useState } from "react";
import type { EventsState } from "../hooks/useEvents.js";
import type { DecryptedEvent } from "../lib/events.js";
import { withSkippedOccurrence } from "../lib/recurrence.js";
import { rankAtEnd } from "../lib/fractionalRank.js";
import type { Session } from "../lib/session.js";
import { Timeline } from "./Timeline.js";
import { NewEventForm } from "./NewEventForm.js";
import { EventEditPanel } from "./EventEditPanel.js";
import { ShareEvent } from "./ShareEvent.js";

interface ScheduleProps {
  session: Session;
  data: EventsState;
}

interface Editing {
  eventId: string;
  origin: DOMRect | null;
  /** The occurrence that was clicked, so "skip this one" skips that one
   * rather than the start of the series. */
  occurrenceStart: Date;
}

/**
 * The signed-in view: the timeline, the create form, and the dialogs that
 * act on a single event. Data and persistence come from useEvents; this
 * component only decides what to show.
 */
export function Schedule({ session, data }: ScheduleProps) {
  const { events, offline, error, loading } = data;
  const [editing, setEditing] = useState<Editing | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);
  // Deleting a recurring event is ambiguous -- this occurrence, or all of
  // them? Rather than guess, hold the pending delete until the person says.
  const [pendingDelete, setPendingDelete] = useState<{ event: DecryptedEvent; occurrenceStart: Date } | null>(
    null
  );

  const editingEvent = editing ? events.find((e) => e.id === editing.eventId) : undefined;
  const sharingEvent = sharingId ? events.find((e) => e.id === sharingId) : undefined;

  function requestDelete(event: DecryptedEvent, occurrenceStart: Date) {
    setEditing(null);
    if (event.recurrence) {
      setPendingDelete({ event, occurrenceStart });
    } else {
      void data.remove(event.id);
    }
  }

  /** Skipping records an exception on the series rather than creating or
   * deleting rows -- the iCalendar EXDATE approach. */
  async function skipOccurrence(event: DecryptedEvent, occurrenceStart: Date) {
    setPendingDelete(null);
    await data.change(event.id, {
      skippedOccurrences: withSkippedOccurrence(event.skippedOccurrences, occurrenceStart),
    });
  }

  return (
    <div className="schedule">
      {offline && (
        <p className="offline-banner" role="status">
          You&rsquo;re offline &mdash; showing your last synced events.
        </p>
      )}

      {loading && events.length === 0 ? (
        <p role="status" aria-live="polite">
          Loading&hellip;
        </p>
      ) : (
        <Timeline
          events={events}
          onEditEvent={(eventId, origin, occurrenceStart) => {
            data.clearError();
            setEditing({ eventId, origin, occurrenceStart });
          }}
          onChangeEvent={(eventId, changes) => data.change(eventId, changes)}
        />
      )}

      {!loading && events.length === 0 && (
        <p className="empty-state">No events yet. Add your first one below.</p>
      )}

      <NewEventForm
        onCreate={data.create}
        nextRank={() => rankAtEnd(events.map((e) => e.rank).filter((r): r is string => Boolean(r)))}
      />

      {error && !editing && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}

      {pendingDelete && (
        <div className="delete-choice" role="dialog" aria-label="Delete recurring event">
          <p>
            &ldquo;{pendingDelete.event.title}&rdquo; repeats. Skip just this one, or delete the
            whole series?
          </p>
          <div className="delete-choice-actions">
            <button
              type="button"
              onClick={() => skipOccurrence(pendingDelete.event, pendingDelete.occurrenceStart)}
            >
              Skip this one
            </button>
            <button
              type="button"
              onClick={() => {
                setPendingDelete(null);
                void data.remove(pendingDelete.event.id);
              }}
            >
              Delete whole series
            </button>
            <button type="button" className="header-link" onClick={() => setPendingDelete(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {sharingEvent && (
        <ShareEvent session={session} event={sharingEvent} onClose={() => setSharingId(null)} />
      )}

      {editing && editingEvent && (
        <EventEditPanel
          key={editingEvent.id}
          event={editingEvent}
          origin={editing.origin}
          saveError={error}
          onSave={(changes) => data.change(editingEvent.id, changes)}
          onDelete={() => requestDelete(editingEvent, editing.occurrenceStart)}
          onLeave={() => {
            setEditing(null);
            void data.leave(editingEvent.id);
          }}
          onShare={() => {
            setEditing(null);
            setSharingId(editingEvent.id);
          }}
          onClose={() => {
            setEditing(null);
            data.clearError();
          }}
        />
      )}
    </div>
  );
}
