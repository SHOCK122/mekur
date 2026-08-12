import type { EventContent } from "@schedule-app/shared";

/**
 * Offline mutation queue.
 *
 * Design note (why this and not a CRDT like Yjs): CRDTs solve concurrent
 * editing of a *shared* document by multiple simultaneous writers. Personal
 * events here have exactly one writer -- their owner -- so there is no
 * concurrent multi-writer merge to perform. The real problem is narrower:
 * a single user makes changes while offline, and those changes need to be
 * replayed when connectivity returns, with a sane answer if the same
 * account changed the event on another device meanwhile. That's a mutation
 * queue with conflict detection, not a CRDT. Adding Yjs would mean a large
 * dependency and restructuring the encrypted data model to solve a problem
 * this app doesn't have. See docs/ARCHITECTURE.md.
 */

export type PendingMutation =
  | { id: string; type: "create"; tempId: string; content: EventContent; queuedAt: string }
  | {
      id: string;
      type: "update";
      eventId: string;
      content: EventContent;
      /** The updatedAt the client last saw for this event. If the server's
       * copy has moved on since, another device changed it and we have a
       * genuine conflict rather than a straightforward replay. */
      baseUpdatedAt: string | null;
      queuedAt: string;
    }
  | { id: string; type: "delete"; eventId: string; queuedAt: string };

function queueKey(userId: string): string {
  return `schedule-app:mutation-queue:${userId}`;
}

let counter = 0;
export function newMutationId(): string {
  counter += 1;
  return `m_${Date.now()}_${counter}`;
}

export function loadQueue(userId: string): PendingMutation[] {
  try {
    const raw = localStorage.getItem(queueKey(userId));
    return raw ? (JSON.parse(raw) as PendingMutation[]) : [];
  } catch {
    return [];
  }
}

function saveQueue(userId: string, queue: PendingMutation[]): void {
  try {
    localStorage.setItem(queueKey(userId), JSON.stringify(queue));
  } catch {
    // Storage failures (quota, private browsing) must never break the app.
    // The cost is that this particular offline change won't survive a
    // reload -- worse than ideal, but better than crashing mid-edit.
  }
}

export function enqueue(userId: string, mutation: PendingMutation): void {
  saveQueue(userId, [...loadQueue(userId), mutation]);
}

export function removeFromQueue(userId: string, mutationId: string): void {
  saveQueue(
    userId,
    loadQueue(userId).filter((m) => m.id !== mutationId)
  );
}

export function clearQueue(userId: string): void {
  saveQueue(userId, []);
}

export function queueLength(userId: string): number {
  return loadQueue(userId).length;
}

/**
 * Collapses redundant mutations before replay, so a burst of offline edits
 * doesn't replay as a burst of requests:
 *  - repeated updates to the same event keep only the last one
 *  - deleting an event drops any earlier queued updates to it
 *  - creating then deleting the same not-yet-synced event drops both
 *    (the server never knew about it, so there's nothing to tell it)
 */
export function collapseQueue(queue: PendingMutation[]): PendingMutation[] {
  const deletedEventIds = new Set(
    queue.filter((m): m is Extract<PendingMutation, { type: "delete" }> => m.type === "delete").map((m) => m.eventId)
  );

  // A create whose tempId was later deleted never needs to reach the server.
  const abandonedTempIds = new Set(
    queue
      .filter((m): m is Extract<PendingMutation, { type: "create" }> => m.type === "create")
      .filter((m) => deletedEventIds.has(m.tempId))
      .map((m) => m.tempId)
  );

  const lastUpdateByEvent = new Map<string, string>();
  for (const mutation of queue) {
    if (mutation.type === "update") lastUpdateByEvent.set(mutation.eventId, mutation.id);
  }

  return queue.filter((mutation) => {
    if (mutation.type === "create") return !abandonedTempIds.has(mutation.tempId);
    if (mutation.type === "delete") return !abandonedTempIds.has(mutation.eventId);
    // update
    if (deletedEventIds.has(mutation.eventId)) return false;
    return lastUpdateByEvent.get(mutation.eventId) === mutation.id;
  });
}
