import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deriveAuthAndEncryptionKeys, encryptEnvelope, decryptEnvelope } from "@schedule-app/crypto";
import { loadKeyring, mutateKeyring, addKeyringEntry } from "../src/lib/keyring.js";
import { listEvents, createEvent, updateEvent } from "../src/lib/events.js";
import type { Session } from "../src/lib/session.js";

let session: Session;

beforeEach(async () => {
  const keys = await deriveAuthAndEncryptionKeys("pw");
  session = {
    userId: "u1",
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

/** Minimal in-memory stand-in for the server's keyring endpoint, including
 * its optimistic-concurrency behaviour. */
function keyringServer(initialEntries: unknown[] = [], initialVersion = 0) {
  const state = {
    envelope: initialVersion > 0 ? null : null,
    version: initialVersion,
    entries: initialEntries,
  } as { envelope: unknown; version: number; entries: unknown[] };

  if (initialVersion > 0) {
    state.envelope = encryptEnvelope({ entries: initialEntries }, session.encryptionKey, "keyring");
  }

  return {
    state,
    handle(url: string, init?: RequestInit) {
      if (url === "/api/keyring" && (!init || init.method === undefined || init.method === "GET")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ keyring: state.envelope, version: state.version }),
        };
      }
      if (url === "/api/keyring" && init?.method === "PUT") {
        const body = JSON.parse(init.body as string);
        if (body.expectedVersion !== state.version) {
          return { ok: false, status: 409, json: async () => ({ error: "conflict" }) };
        }
        state.envelope = body.envelope;
        state.version += 1;
        return { ok: true, status: 200, json: async () => ({ version: state.version }) };
      }
      throw new Error("unexpected url " + url);
    },
  };
}

describe("keyring", () => {
  it("reads as empty at version 0 when the account has none", async () => {
    const server = keyringServer();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (u: string, i?: RequestInit) => server.handle(u, i)));
    expect(await loadKeyring(session)).toEqual({ entries: [], version: 0 });
  }, 20_000);

  it("round-trips entries through encryption", async () => {
    const server = keyringServer();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (u: string, i?: RequestInit) => server.handle(u, i)));

    await addKeyringEntry(session, {
      eventId: "e1",
      viewToken: "vt",
      editToken: "et",
      eventKey: "ek",
    });

    const reloaded = await loadKeyring(session);
    expect(reloaded.entries).toHaveLength(1);
    expect(reloaded.entries[0]!.eventId).toBe("e1");
    expect(reloaded.entries[0]!.editToken).toBe("et");
  }, 20_000);

  it("never writes keyring contents in the clear", async () => {
    const server = keyringServer();
    const fetchMock = vi.fn().mockImplementation(async (u: string, i?: RequestInit) => server.handle(u, i));
    vi.stubGlobal("fetch", fetchMock);

    await addKeyringEntry(session, {
      eventId: "e1",
      viewToken: "SECRET-VIEW-TOKEN",
      eventKey: "SECRET-EVENT-KEY",
    });

    const putCall = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT")!;
    // The tokens are the capability -- leaking them to the server would
    // hand it exactly the access the model exists to withhold.
    expect(putCall[1].body).not.toContain("SECRET-VIEW-TOKEN");
    expect(putCall[1].body).not.toContain("SECRET-EVENT-KEY");
  }, 20_000);

  it("merges rather than clobbers when another device wrote first", async () => {
    // This is the data-loss case: two devices each adding a different
    // event. Losing either write means permanently losing access to that
    // event, since nothing else records the capability.
    const server = keyringServer();
    let interfered = false;
    const fetchMock = vi.fn().mockImplementation(async (u: string, i?: RequestInit) => {
      // Simulate the other device writing in between our read and write.
      if (u === "/api/keyring" && i?.method === "PUT" && !interfered) {
        interfered = true;
        server.state.envelope = encryptEnvelope(
          { entries: [{ eventId: "from-other-device", viewToken: "v", eventKey: "k", addedAt: "x" }] },
          session.encryptionKey,
          "keyring"
        );
        server.state.version += 1;
      }
      return server.handle(u, i);
    });
    vi.stubGlobal("fetch", fetchMock);

    await addKeyringEntry(session, { eventId: "from-this-device", viewToken: "v", eventKey: "k" });

    const final = await loadKeyring(session);
    const ids = final.entries.map((e) => e.eventId).sort();
    expect(ids).toEqual(["from-other-device", "from-this-device"]);
  }, 20_000);

  it("gives up with a clear error rather than looping forever on repeated conflict", async () => {
    const server = keyringServer();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (u: string, i?: RequestInit) => {
        if (u === "/api/keyring" && i?.method === "PUT") {
          return { ok: false, status: 409, json: async () => ({ error: "conflict" }) };
        }
        return server.handle(u, i);
      })
    );
    await expect(mutateKeyring(session, (e) => e)).rejects.toThrow();
  }, 20_000);
});

describe("events under the capability model", () => {
  it("creates an event, encrypts it under a fresh per-event key, and records the capability", async () => {
    const server = keyringServer();
    const fetchMock = vi.fn().mockImplementation(async (u: string, i?: RequestInit) => {
      if (u === "/api/events" && i?.method === "POST") {
        return {
          ok: true,
          status: 201,
          json: async () => ({ event: { id: "e1" }, viewToken: "vt", editToken: "et" }),
        };
      }
      return server.handle(u, i);
    });
    vi.stubGlobal("fetch", fetchMock);

    const created = await createEvent(session, content("Dentist"));
    expect(created.id).toBe("e1");
    expect(created.canEdit).toBe(true);

    // Plaintext must never reach the wire.
    const postCall = fetchMock.mock.calls.find((c) => c[0] === "/api/events")!;
    expect(postCall[1].body).not.toContain("Dentist");

    // And the capability must be in the keyring, or the event is lost.
    const keyring = await loadKeyring(session);
    expect(keyring.entries[0]!.eventId).toBe("e1");
    expect(keyring.entries[0]!.editToken).toBe("et");
  }, 20_000);

  it("lists events by presenting keyring capabilities and decrypting each", async () => {
    const eventKey = (await deriveAuthAndEncryptionKeys("other")).encryptionKey;
    const envelope = encryptEnvelope(content("Standup"), eventKey, "event");
    const server = keyringServer(
      [{ eventId: "e1", viewToken: "vt", eventKey, addedAt: "x" }],
      1
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (u: string, i?: RequestInit) => {
        if (u === "/api/events/batch-read") {
          const sent = JSON.parse(i!.body as string);
          expect(sent.events).toEqual([{ eventId: "e1", token: "vt" }]);
          return { ok: true, status: 200, json: async () => ({ events: [{ id: "e1", envelope }] }) };
        }
        return server.handle(u, i);
      })
    );

    const events = await listEvents(session);
    expect(events).toHaveLength(1);
    expect(events[0]!.title).toBe("Standup");
    // No edit token in the keyring, so the UI must not offer editing.
    expect(events[0]!.canEdit).toBe(false);
  }, 20_000);

  it("skips an undecryptable event rather than blanking the whole calendar", async () => {
    const goodKey = (await deriveAuthAndEncryptionKeys("good")).encryptionKey;
    const goodEnvelope = encryptEnvelope(content("Readable"), goodKey, "event");
    const wrongKey = (await deriveAuthAndEncryptionKeys("wrong")).encryptionKey;
    const badEnvelope = encryptEnvelope(content("Unreadable"), wrongKey, "event");

    const server = keyringServer(
      [
        { eventId: "good", viewToken: "v1", eventKey: goodKey, addedAt: "x" },
        // Stale key: this entry can no longer open its event.
        { eventId: "bad", viewToken: "v2", eventKey: goodKey, addedAt: "x" },
      ],
      1
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (u: string, i?: RequestInit) => {
        if (u === "/api/events/batch-read") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              events: [
                { id: "good", envelope: goodEnvelope },
                { id: "bad", envelope: badEnvelope },
              ],
            }),
          };
        }
        return server.handle(u, i);
      })
    );

    const events = await listEvents(session);
    expect(events.map((e) => e.title)).toEqual(["Readable"]);
  }, 20_000);

  it("refuses to edit an event the keyring holds no edit capability for", async () => {
    const server = keyringServer([{ eventId: "e1", viewToken: "vt", eventKey: "k", addedAt: "x" }], 1);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (u: string, i?: RequestInit) => server.handle(u, i)));
    await expect(updateEvent(session, "e1", content("nope"))).rejects.toThrow(/permission/i);
  }, 20_000);
});
