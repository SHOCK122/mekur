import type { Session } from "./session.js";
import { createEvent, updateEvent, deleteEvent, listEvents, type DecryptedEvent } from "./api.js";
import {
  loadQueue,
  collapseQueue,
  removeFromQueue,
  type PendingMutation,
} from "./mutationQueue.js";

export interface SyncConflict {
  eventId: string;
  /** What this device tried to write. */
  localTitle: string;
  /** What the server actually has (another device got there first). */
  remoteTitle: string;
}

export interface SyncResult {
  applied: number;
  failed: number;
  conflicts: SyncConflict[];
}

/**
 * Replays queued offline mutations against the server.
 *
 * Conflict policy is deliberately conservative and explicit: for updates,
 * we compare the `updatedAt` the client last saw against what the server
 * currently reports. If they differ, another device changed that event
 * while this one was offline, and we do NOT silently overwrite it --
 * we surface it as a conflict and leave the server's version alone.
 * Last-write-wins would be less code but would silently destroy the other
 * device's change, which is exactly the kind of quiet data loss people
 * don't forgive in a calendar.
 */
export async function syncPendingMutations(session: Session): Promise<SyncResult> {
  const queue = collapseQueue(loadQueue(session.userId));
  if (queue.length === 0) return { applied: 0, failed: 0, conflicts: [] };

  // Fetch current server state once so update conflicts can be detected
  // without a round-trip per mutation.
  let serverEvents: DecryptedEvent[];
  try {
    serverEvents = await listEvents(session);
  } catch {
    // Still offline (or the server is down) -- leave the queue untouched
    // so nothing is lost, and report that nothing was applied.
    return { applied: 0, failed: queue.length, conflicts: [] };
  }
  const serverById = new Map(serverEvents.map((event) => [event.id, event]));

  const result: SyncResult = { applied: 0, failed: 0, conflicts: [] };

  for (const mutation of queue) {
    try {
      const outcome = await applyMutation(session, mutation, serverById);
      if (outcome === "conflict") {
        // Keep the mutation queued? No -- leaving it would retry the same
        // losing write forever. Drop it and surface the conflict so the
        // person can decide, rather than looping silently.
        removeFromQueue(session.userId, mutation.id);
      } else {
        removeFromQueue(session.userId, mutation.id);
        result.applied += 1;
      }
    } catch {
      // A genuine failure (network died mid-sync, server error): leave it
      // queued so the next sync attempt retries it.
      result.failed += 1;
    }
  }

  return result;

  async function applyMutation(
    activeSession: Session,
    mutation: PendingMutation,
    server: Map<string, DecryptedEvent>
  ): Promise<"applied" | "conflict"> {
    if (mutation.type === "create") {
      await createEvent(activeSession, mutation.content);
      return "applied";
    }

    if (mutation.type === "delete") {
      // Deleting something the server no longer has is a no-op success,
      // not an error -- the desired end state already holds.
      if (!server.has(mutation.eventId)) return "applied";
      await deleteEvent(activeSession, mutation.eventId);
      return "applied";
    }

    // update
    const remote = server.get(mutation.eventId);
    if (!remote) {
      // The event was deleted elsewhere while we were offline. Re-creating
      // it from a stale edit would resurrect something the person deleted,
      // so treat it as a conflict rather than guessing.
      result.conflicts.push({
        eventId: mutation.eventId,
        localTitle: mutation.content.title,
        remoteTitle: "(deleted on another device)",
      });
      return "conflict";
    }

    if (mutation.baseUpdatedAt && remote.updatedAt && remote.updatedAt !== mutation.baseUpdatedAt) {
      result.conflicts.push({
        eventId: mutation.eventId,
        localTitle: mutation.content.title,
        remoteTitle: remote.title,
      });
      return "conflict";
    }

    await updateEvent(activeSession, mutation.eventId, mutation.content);
    return "applied";
  }
}
