import { vi } from "vitest";
import { encryptEnvelope } from "@schedule-app/crypto";
import type { Session } from "../src/lib/session.js";
import type { EventContent } from "@schedule-app/shared";

export interface MockEvent {
  id: string;
  content: EventContent;
  /** Per-event key. Defaults to a key derived from the id so tests don't
   * have to manage key material they don't care about. */
  eventKey?: string;
  canEdit?: boolean;
}

/**
 * Stands in for the capability-model server: a keyring endpoint plus
 * batch-read, mirroring the real wire format. Tests that only care about
 * component behaviour shouldn't each have to re-implement this.
 */
export function stubCapabilityServer(session: Session, events: MockEvent[] = []) {
  const keyFor = (e: MockEvent) => e.eventKey ?? session.encryptionKey;

  const entries = events.map((e) => ({
    eventId: e.id,
    viewToken: `view-${e.id}`,
    editToken: e.canEdit === false ? undefined : `edit-${e.id}`,
    eventKey: keyFor(e),
    addedAt: "2026-01-01T00:00:00.000Z",
  }));

  const state = {
    keyring: entries.length
      ? encryptEnvelope({ entries }, session.encryptionKey, "keyring")
      : null,
    version: entries.length ? 1 : 0,
  };

  const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";

    if (url === "/api/keyring" && method === "GET") {
      return { ok: true, status: 200, json: async () => ({ keyring: state.keyring, version: state.version }) };
    }
    if (url === "/api/keyring" && method === "PUT") {
      const body = JSON.parse(init!.body as string);
      if (body.expectedVersion !== state.version) {
        return { ok: false, status: 409, json: async () => ({ error: "conflict" }) };
      }
      state.keyring = body.envelope;
      state.version += 1;
      return { ok: true, status: 200, json: async () => ({ version: state.version }) };
    }
    if (url === "/api/events/batch-read") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          events: events.map((e) => ({
            id: e.id,
            updatedAt: "2026-01-01T00:00:00.000Z",
            envelope: encryptEnvelope(e.content, keyFor(e), "event"),
          })),
        }),
      };
    }
    if (url === "/api/events" && method === "POST") {
      return {
        ok: true,
        status: 201,
        json: async () => ({ event: { id: "new-event" }, viewToken: "vt", editToken: "et" }),
      };
    }
    // Updates and deletes on individual events.
    if (url.startsWith("/api/events/")) {
      return { ok: true, status: method === "DELETE" ? 204 : 200, json: async () => ({ event: { id: "x" } }) };
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
