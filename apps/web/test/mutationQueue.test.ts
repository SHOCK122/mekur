import { describe, it, expect, beforeEach } from "vitest";
import {
  enqueue,
  loadQueue,
  removeFromQueue,
  clearQueue,
  queueLength,
  collapseQueue,
  newMutationId,
  type PendingMutation,
} from "../src/lib/mutationQueue.js";

const USER = "user-1";

function content(title: string) {
  return {
    title,
    startTime: "2026-09-01T09:00:00.000Z",
    endTime: "2026-09-01T09:30:00.000Z",
    priority: 0,
  };
}

function update(eventId: string, title: string, id = newMutationId()): PendingMutation {
  return {
    id,
    type: "update",
    eventId,
    content: content(title),
    baseUpdatedAt: null,
    queuedAt: new Date().toISOString(),
  };
}

describe("mutationQueue storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts empty", () => {
    expect(loadQueue(USER)).toEqual([]);
    expect(queueLength(USER)).toBe(0);
  });

  it("enqueues and reloads mutations in order", () => {
    enqueue(USER, update("e1", "First"));
    enqueue(USER, update("e2", "Second"));
    const queue = loadQueue(USER);
    expect(queue).toHaveLength(2);
    expect(queue[0]!.type).toBe("update");
    expect(queueLength(USER)).toBe(2);
  });

  it("removes a single mutation by id", () => {
    const first = update("e1", "First", "m-1");
    enqueue(USER, first);
    enqueue(USER, update("e2", "Second", "m-2"));
    removeFromQueue(USER, "m-1");
    const queue = loadQueue(USER);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.id).toBe("m-2");
  });

  it("clears the whole queue", () => {
    enqueue(USER, update("e1", "First"));
    clearQueue(USER);
    expect(loadQueue(USER)).toEqual([]);
  });

  it("keeps separate queues per user", () => {
    enqueue("alice", update("e1", "Alice's"));
    enqueue("bob", update("e2", "Bob's"));
    expect(loadQueue("alice")).toHaveLength(1);
    expect(loadQueue("bob")).toHaveLength(1);
    expect((loadQueue("alice")[0] as { eventId: string }).eventId).toBe("e1");
  });

  it("survives corrupted storage without throwing", () => {
    localStorage.setItem(`schedule-app:mutation-queue:${USER}`, "not valid json{{{");
    expect(loadQueue(USER)).toEqual([]);
  });

  it("generates unique mutation ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newMutationId()));
    expect(ids.size).toBe(50);
  });
});

describe("collapseQueue", () => {
  it("keeps a single update as-is", () => {
    const queue = [update("e1", "Only")];
    expect(collapseQueue(queue)).toHaveLength(1);
  });

  it("collapses repeated updates to the same event down to the last one", () => {
    const queue = [
      update("e1", "First draft", "m-1"),
      update("e1", "Second draft", "m-2"),
      update("e1", "Final", "m-3"),
    ];
    const collapsed = collapseQueue(queue);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.id).toBe("m-3");
  });

  it("keeps updates to different events separate", () => {
    const queue = [update("e1", "One"), update("e2", "Two")];
    expect(collapseQueue(queue)).toHaveLength(2);
  });

  it("drops updates to an event that was later deleted", () => {
    const queue: PendingMutation[] = [
      update("e1", "Edited", "m-1"),
      { id: "m-2", type: "delete", eventId: "e1", queuedAt: new Date().toISOString() },
    ];
    const collapsed = collapseQueue(queue);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.type).toBe("delete");
  });

  it("drops both sides when an event is created and deleted entirely offline", () => {
    // The server never knew this event existed, so there's nothing to tell it.
    const queue: PendingMutation[] = [
      { id: "m-1", type: "create", tempId: "tmp-1", content: content("Ghost"), queuedAt: new Date().toISOString() },
      { id: "m-2", type: "delete", eventId: "tmp-1", queuedAt: new Date().toISOString() },
    ];
    expect(collapseQueue(queue)).toEqual([]);
  });

  it("keeps a create that wasn't subsequently deleted", () => {
    const queue: PendingMutation[] = [
      { id: "m-1", type: "create", tempId: "tmp-1", content: content("Real"), queuedAt: new Date().toISOString() },
      { id: "m-2", type: "create", tempId: "tmp-2", content: content("Also real"), queuedAt: new Date().toISOString() },
      { id: "m-3", type: "delete", eventId: "tmp-2", queuedAt: new Date().toISOString() },
    ];
    const collapsed = collapseQueue(queue);
    expect(collapsed).toHaveLength(1);
    expect((collapsed[0] as { tempId: string }).tempId).toBe("tmp-1");
  });

  it("preserves relative order of surviving mutations", () => {
    const queue: PendingMutation[] = [
      update("e1", "One", "m-1"),
      update("e2", "Two", "m-2"),
      update("e1", "One again", "m-3"),
    ];
    const collapsed = collapseQueue(queue);
    expect(collapsed.map((m) => m.id)).toEqual(["m-2", "m-3"]);
  });
});
