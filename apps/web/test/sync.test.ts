import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deriveAuthAndEncryptionKeys, encryptEnvelope } from "@schedule-app/crypto";
import { syncPendingMutations } from "../src/lib/sync.js";
import { enqueue, loadQueue, type PendingMutation } from "../src/lib/mutationQueue.js";
import type { Session } from "../src/lib/session.js";

let session: Session;

beforeEach(async () => {
  localStorage.clear();
  const keys = await deriveAuthAndEncryptionKeys("pw");
  session = {
    userId: "user-1",
    username: "ada",
    token: "t",
    encryptionKey: keys.encryptionKey,
    identityPublicKey: keys.identityKeyPair.publicKey,
    identitySecretKey: keys.identityKeyPair.secretKey,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function content(title: string) {
  return {
    title,
    startTime: "2026-09-01T09:00:00.000Z",
    endTime: "2026-09-01T09:30:00.000Z",
    priority: 0,
  };
}

/** Builds a server-side event list response the way listEvents expects it. */
function serverEventsResponse(
  events: { id: string; title: string; updatedAt: string }[],
  encryptionKey: string
) {
  return {
    events: events.map((e) => ({
      id: e.id,
      updatedAt: e.updatedAt,
      envelope: encryptEnvelope(content(e.title), encryptionKey, "user-key-1"),
    })),
  };
}

describe("syncPendingMutations", () => {
  it("does nothing and reports nothing when the queue is empty", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await syncPendingMutations(session);
    expect(result).toEqual({ applied: 0, failed: 0, conflicts: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  }, 15_000);

  it("leaves the queue intact if still offline, so nothing is lost", async () => {
    enqueue(session.userId, {
      id: "m-1",
      type: "create",
      tempId: "tmp-1",
      content: content("Offline event"),
      queuedAt: new Date().toISOString(),
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("still offline")));

    const result = await syncPendingMutations(session);
    expect(result.applied).toBe(0);
    expect(result.failed).toBe(1);
    expect(loadQueue(session.userId)).toHaveLength(1); // still queued for a later retry
  }, 15_000);

  it("replays a queued create and clears it from the queue", async () => {
    enqueue(session.userId, {
      id: "m-1",
      type: "create",
      tempId: "tmp-1",
      content: content("Made offline"),
      queuedAt: new Date().toISOString(),
    });

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/events" && (!init || !init.method || init.method === "GET")) {
        return { ok: true, json: async () => serverEventsResponse([], session.encryptionKey) };
      }
      return { ok: true, json: async () => ({ event: { id: "e-new" } }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncPendingMutations(session);
    expect(result.applied).toBe(1);
    expect(result.conflicts).toEqual([]);
    expect(loadQueue(session.userId)).toHaveLength(0);
  }, 15_000);

  it("applies an update when the server copy hasn't moved on", async () => {
    const sameTimestamp = "2026-09-01T10:00:00.000Z";
    enqueue(session.userId, {
      id: "m-1",
      type: "update",
      eventId: "e-1",
      content: content("Edited offline"),
      baseUpdatedAt: sameTimestamp,
      queuedAt: new Date().toISOString(),
    });

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/events" && (!init || !init.method || init.method === "GET")) {
        return {
          ok: true,
          json: async () =>
            serverEventsResponse([{ id: "e-1", title: "Original", updatedAt: sameTimestamp }], session.encryptionKey),
        };
      }
      return { ok: true, json: async () => ({ event: { id: "e-1" } }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncPendingMutations(session);
    expect(result.applied).toBe(1);
    expect(result.conflicts).toEqual([]);
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "PUT")).toBe(true);
  }, 15_000);

  it("reports a conflict and does NOT overwrite when another device changed the same event", async () => {
    enqueue(session.userId, {
      id: "m-1",
      type: "update",
      eventId: "e-1",
      content: content("My offline edit"),
      baseUpdatedAt: "2026-09-01T10:00:00.000Z",
      queuedAt: new Date().toISOString(),
    });

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/events" && (!init || !init.method || init.method === "GET")) {
        return {
          ok: true,
          json: async () =>
            serverEventsResponse(
              // Server has moved on since we went offline.
              [{ id: "e-1", title: "Their newer edit", updatedAt: "2026-09-01T11:30:00.000Z" }],
              session.encryptionKey
            ),
        };
      }
      return { ok: true, json: async () => ({ event: { id: "e-1" } }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncPendingMutations(session);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toEqual({
      eventId: "e-1",
      localTitle: "My offline edit",
      remoteTitle: "Their newer edit",
    });
    // Critically: no PUT was sent -- the other device's change survives.
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "PUT")).toBe(false);
  }, 15_000);

  it("treats an update to an event deleted elsewhere as a conflict, not a resurrection", async () => {
    enqueue(session.userId, {
      id: "m-1",
      type: "update",
      eventId: "e-gone",
      content: content("Edit of a deleted event"),
      baseUpdatedAt: "2026-09-01T10:00:00.000Z",
      queuedAt: new Date().toISOString(),
    });

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/events" && (!init || !init.method || init.method === "GET")) {
        return { ok: true, json: async () => serverEventsResponse([], session.encryptionKey) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncPendingMutations(session);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.remoteTitle).toMatch(/deleted on another device/i);
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "PUT")).toBe(false);
  }, 15_000);

  it("treats deleting an already-gone event as success, not an error", async () => {
    enqueue(session.userId, {
      id: "m-1",
      type: "delete",
      eventId: "e-already-gone",
      queuedAt: new Date().toISOString(),
    });

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/events" && (!init || !init.method || init.method === "GET")) {
        return { ok: true, json: async () => serverEventsResponse([], session.encryptionKey) };
      }
      return { ok: true, status: 204, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncPendingMutations(session);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    // No DELETE needed -- the desired end state already held.
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "DELETE")).toBe(false);
    expect(loadQueue(session.userId)).toHaveLength(0);
  }, 15_000);

  it("collapses a burst of offline edits into a single replayed write", async () => {
    const base = "2026-09-01T10:00:00.000Z";
    const mutations: PendingMutation[] = [
      { id: "m-1", type: "update", eventId: "e-1", content: content("Draft 1"), baseUpdatedAt: base, queuedAt: base },
      { id: "m-2", type: "update", eventId: "e-1", content: content("Draft 2"), baseUpdatedAt: base, queuedAt: base },
      { id: "m-3", type: "update", eventId: "e-1", content: content("Final"), baseUpdatedAt: base, queuedAt: base },
    ];
    for (const m of mutations) enqueue(session.userId, m);

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/events" && (!init || !init.method || init.method === "GET")) {
        return {
          ok: true,
          json: async () =>
            serverEventsResponse([{ id: "e-1", title: "Original", updatedAt: base }], session.encryptionKey),
        };
      }
      return { ok: true, json: async () => ({ event: { id: "e-1" } }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncPendingMutations(session);
    expect(result.applied).toBe(1);
    const putCalls = fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT");
    expect(putCalls).toHaveLength(1); // three edits, one request
  }, 15_000);
});
