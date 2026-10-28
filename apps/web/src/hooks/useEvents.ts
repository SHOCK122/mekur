import { useCallback, useEffect, useState } from "react";
import type { EventContent } from "@schedule-app/shared";
import {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  leaveEvent,
  toContent,
  type DecryptedEvent,
} from "../lib/events.js";
import { loadEventCache, saveEventCache } from "../lib/eventCache.js";
import type { Session } from "../lib/session.js";

export interface EventsState {
  events: DecryptedEvent[];
  loading: boolean;
  /** True when showing the last synced copy because the network failed. */
  offline: boolean;
  error: string | null;
  clearError: () => void;
  refresh: () => Promise<void>;
  create: (content: EventContent) => Promise<boolean>;
  /** Merges changes into an event and saves it. Resolves false (with
   * `error` set) rather than throwing, so callers can stay simple. */
  change: (eventId: string, changes: Partial<EventContent>) => Promise<boolean>;
  /** Deletes for everyone (edit capability required). */
  remove: (eventId: string) => Promise<boolean>;
  /** Removes from this account's schedule only. */
  leave: (eventId: string) => Promise<boolean>;
}

/**
 * The schedule's data: loading through the keyring, the offline fallback,
 * and every mutation. Every mutation re-reads from the server afterwards
 * rather than patching local state, so what's shown is always what's
 * stored -- including anything another device changed meanwhile.
 */
export function useEvents(session: Session): EventsState {
  const [events, setEvents] = useState<DecryptedEvent[]>(() => loadEventCache(session.userId) ?? []);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listEvents(session);
      setEvents(list);
      saveEventCache(session.userId, list);
      setOffline(false);
    } catch (err) {
      // A cached copy keeps the schedule usable offline; that's a status
      // note, not a blocking error.
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
  }, [session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Runs a mutation, then refreshes. Errors become `error`. */
  const run = useCallback(
    async (action: () => Promise<unknown>, failure: string): Promise<boolean> => {
      setError(null);
      try {
        await action();
        await refresh();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : failure);
        return false;
      }
    },
    [refresh]
  );

  return {
    events,
    loading,
    offline,
    error,
    clearError: () => setError(null),
    refresh,
    create: (content) => run(() => createEvent(session, content), "Could not create the event"),
    change: (eventId, changes) => {
      const target = events.find((e) => e.id === eventId);
      if (!target) return Promise.resolve(false);
      return run(
        () => updateEvent(session, eventId, { ...toContent(target), ...changes }),
        "Could not save the change"
      );
    },
    remove: (eventId) => run(() => deleteEvent(session, eventId), "Could not delete the event"),
    leave: (eventId) => run(() => leaveEvent(session, eventId), "Could not remove the event"),
  };
}
