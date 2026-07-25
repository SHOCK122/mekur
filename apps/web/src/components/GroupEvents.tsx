import { useEffect, useMemo, useState } from "react";
import {
  listGroupEvents,
  createGroupEvent,
  submitVotes,
  resolveGroupEvent,
  type DecryptedGroupEvent,
} from "../lib/groupEvents.js";
import type { Session } from "../lib/session.js";

interface GroupEventsProps {
  session: Session;
}

interface DraftSlot {
  id: string;
  start: string;
  end: string;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
  const timeFmt = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
  return `${dateFmt.format(date)} \u00b7 ${timeFmt.format(date)}`;
}

let slotCounter = 0;
function nextSlotId() {
  slotCounter += 1;
  return `slot_${slotCounter}_${Date.now()}`;
}

export function GroupEvents({ session }: GroupEventsProps) {
  const [events, setEvents] = useState<DecryptedGroupEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create-form state
  const [title, setTitle] = useState("");
  const [draftSlots, setDraftSlots] = useState<DraftSlot[]>([
    { id: nextSlotId(), start: "", end: "" },
  ]);
  const [inviteeInput, setInviteeInput] = useState("");
  const [creating, setCreating] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setEvents(await listGroupEvents(session));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load group events");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pendingCount = useMemo(
    () => events.filter((e) => e.status === "open" && e.myVotes.length === 0).length,
    [events]
  );

  function addDraftSlot() {
    setDraftSlots((slots) => [...slots, { id: nextSlotId(), start: "", end: "" }]);
  }

  function removeDraftSlot(id: string) {
    setDraftSlots((slots) => (slots.length > 1 ? slots.filter((s) => s.id !== id) : slots));
  }

  function updateDraftSlot(id: string, field: "start" | "end", value: string) {
    setDraftSlots((slots) => slots.map((s) => (s.id === id ? { ...s, [field]: value } : s)));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const validSlots = draftSlots.filter((s) => s.start && s.end);
    if (!title || validSlots.length === 0) {
      setError("Give the event a title and at least one candidate time slot.");
      return;
    }
    for (const slot of validSlots) {
      if (new Date(slot.end) <= new Date(slot.start)) {
        setError("Every slot's end time must be after its start time.");
        return;
      }
    }

    const inviteeUsernames = inviteeInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    setCreating(true);
    try {
      const slots: Record<string, { startTime: string; endTime: string }> = {};
      for (const slot of validSlots) {
        slots[slot.id] = { startTime: new Date(slot.start).toISOString(), endTime: new Date(slot.end).toISOString() };
      }
      await createGroupEvent(session, { title, slots, inviteeUsernames });
      setTitle("");
      setDraftSlots([{ id: nextSlotId(), start: "", end: "" }]);
      setInviteeInput("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create group event");
    } finally {
      setCreating(false);
    }
  }

  async function handleResolve(id: string) {
    setError(null);
    try {
      await resolveGroupEvent(session, id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resolve event");
    }
  }

  return (
    <div className="group-events">
      <div className="group-events-header">
        <h2>Group events</h2>
        {pendingCount > 0 && (
          <span className="pending-badge" role="status">
            {pendingCount} awaiting your vote
          </span>
        )}
      </div>

      <form onSubmit={handleCreate} className="event-form">
        <input
          placeholder="Event title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />

        {draftSlots.map((slot, index) => (
          <div className="event-form-row slot-row" key={slot.id}>
            <input
              type="datetime-local"
              value={slot.start}
              onChange={(e) => updateDraftSlot(slot.id, "start", e.target.value)}
              aria-label={`Candidate slot ${index + 1} start`}
            />
            <input
              type="datetime-local"
              value={slot.end}
              onChange={(e) => updateDraftSlot(slot.id, "end", e.target.value)}
              aria-label={`Candidate slot ${index + 1} end`}
            />
            <button type="button" onClick={() => removeDraftSlot(slot.id)} aria-label="Remove this slot">
              &times;
            </button>
          </div>
        ))}
        <button type="button" className="add-slot" onClick={addDraftSlot}>
          + Add another time option
        </button>

        <input
          placeholder="Invite usernames, comma separated"
          value={inviteeInput}
          onChange={(e) => setInviteeInput(e.target.value)}
          aria-label="Invite usernames"
        />

        <button type="submit" disabled={creating}>
          {creating ? "Creating\u2026" : "Propose group event"}
        </button>
      </form>

      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p>Loading&hellip;</p>
      ) : events.length === 0 ? (
        <p className="empty-state">No group events yet.</p>
      ) : (
        <ul className="group-event-list">
          {events.map((event) => (
            <GroupEventItem
              key={event.id}
              event={event}
              session={session}
              onVoted={refresh}
              onResolve={() => handleResolve(event.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function GroupEventItem({
  event,
  session,
  onVoted,
  onResolve,
}: {
  event: DecryptedGroupEvent;
  session: Session;
  onVoted: () => void;
  onResolve: () => void;
}) {
  const [ranks, setRanks] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    for (const vote of event.myVotes) initial[vote.slotId] = vote.rank;
    return initial;
  });
  const [submitting, setSubmitting] = useState(false);

  const isOrganizer = event.organizerId === session.userId;

  async function handleVote(e: React.FormEvent) {
    e.preventDefault();
    const rankings = Object.entries(ranks)
      .filter(([, rank]) => rank > 0)
      .map(([slotId, rank]) => ({ slotId, rank }));
    if (rankings.length === 0) return;
    setSubmitting(true);
    try {
      await submitVotes(session, event.id, rankings);
      await onVoted();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <li className="group-event-item">
      <div className="group-event-item-header">
        <strong>{event.title}</strong>
        <span className={`status-badge status-${event.status}`}>{event.status}</span>
      </div>
      {event.description && <p className="group-event-description">{event.description}</p>}

      {event.status === "resolved" && event.resolvedSlotId ? (
        <p className="resolved-time">
          Scheduled for {formatDateTime(event.slots[event.resolvedSlotId]!.startTime)}
        </p>
      ) : (
        <form onSubmit={handleVote} className="vote-form">
          {event.slotIds.map((slotId) => (
            <div className="vote-row" key={slotId}>
              <span>{formatDateTime(event.slots[slotId]!.startTime)}</span>
              <label>
                Rank
                <input
                  type="number"
                  min={1}
                  value={ranks[slotId] ?? ""}
                  onChange={(e) => setRanks((r) => ({ ...r, [slotId]: Number(e.target.value) }))}
                  aria-label={`Rank for ${formatDateTime(event.slots[slotId]!.startTime)}`}
                />
              </label>
            </div>
          ))}
          <button type="submit" disabled={submitting}>
            {submitting ? "Saving\u2026" : "Submit my ranking"}
          </button>
        </form>
      )}

      {isOrganizer && event.status === "open" && (
        <button type="button" className="resolve-button" onClick={onResolve}>
          Resolve now
        </button>
      )}
    </li>
  );
}
