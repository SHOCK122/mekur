import { describe, it, expect, vi, afterEach } from "vitest";
import {
  deriveAuthAndEncryptionKeys,
  deriveSharedWrapKey,
  wrapKey,
  generateSymmetricKey,
  encryptEnvelope,
} from "@schedule-app/crypto";
import {
  createGroupEvent,
  listGroupEvents,
  submitVotes,
  lookupUser,
} from "../src/lib/groupEvents.js";
import type { Session } from "../src/lib/session.js";

async function makeSession(password: string, overrides: Partial<Session> = {}): Promise<Session> {
  const keys = await deriveAuthAndEncryptionKeys(password);
  return {
    userId: "user-" + Math.random().toString(36).slice(2),
    username: "someone",
    token: "t",
    encryptionKey: keys.encryptionKey,
    identityPublicKey: keys.identityKeyPair.publicKey,
    identitySecretKey: keys.identityKeyPair.secretKey,
    ...overrides,
  };
}

describe("groupEvents client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lookupUser fetches the directory endpoint", async () => {
    const session = await makeSession("pw1");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: { id: "u2", username: "bob", displayName: "Bob", publicKey: "pk" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = await lookupUser(session, "bob");
    expect(user.username).toBe("bob");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/users/bob");
  }, 15_000);

  it("createGroupEvent looks up invitees, wraps the key for everyone including self, and never leaks plaintext", async () => {
    const organizer = await makeSession("organizer-pw");
    const inviteeKeys = await deriveAuthAndEncryptionKeys("invitee-pw");
    const inviteeId = "invitee-user-id";

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const slots = {
      slot_1: { startTime: "2026-08-10T10:00:00.000Z", endTime: "2026-08-10T11:00:00.000Z" },
    };

    let sentBody: any;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/users/bob") {
        return {
          ok: true,
          json: async () => ({
            user: { id: inviteeId, username: "bob", displayName: "Bob", publicKey: inviteeKeys.identityKeyPair.publicKey },
          }),
        };
      }
      if (url === "/api/group-events") {
        sentBody = JSON.parse(init!.body as string);
        return {
          ok: true,
          json: async () => ({
            groupEvent: {
              id: "ge-1",
              organizerId: organizer.userId,
              organizerPublicKey: organizer.identityPublicKey,
              slotIds: sentBody.slotIds,
              contentEnvelope: sentBody.contentEnvelope,
              status: "open",
              resolvedSlotId: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              myWrappedKey: sentBody.participants.find((p: any) => p.userId === organizer.userId).wrappedKey,
              myVotes: [],
            },
          }),
        };
      }
      throw new Error("unexpected url " + url);
    });

    const created = await createGroupEvent(organizer, {
      title: "Team offsite",
      slots,
      inviteeUsernames: ["bob"],
    });

    expect(created.title).toBe("Team offsite");
    expect(created.slots).toEqual(slots);
    expect(sentBody.participants).toHaveLength(2);
    expect(sentBody.participants.map((p: any) => p.userId).sort()).toEqual([inviteeId, organizer.userId].sort());
    // No plaintext title/slot times anywhere in what was actually sent over the wire.
    expect(JSON.stringify(sentBody)).not.toContain("Team offsite");
    expect(JSON.stringify(sentBody)).not.toContain("2026-08-10");
  }, 20_000);

  it("listGroupEvents decrypts every record using the recipient's own wrapped key", async () => {
    const organizer = await makeSession("organizer-pw-2");
    const recipient = await makeSession("recipient-pw-2");

    const eventKey = generateSymmetricKey();
    const slots = { slot_1: { startTime: "2026-09-01T09:00:00.000Z", endTime: "2026-09-01T09:30:00.000Z" } };
    const contentEnvelope = encryptEnvelope({ title: "Sync", slots }, eventKey, "group-event-key");
    const wrapKeyForRecipient = deriveSharedWrapKey(organizer.identitySecretKey, recipient.identityPublicKey);
    const myWrappedKey = wrapKey(eventKey, wrapKeyForRecipient);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          groupEvents: [
            {
              id: "ge-2",
              organizerId: organizer.userId,
              organizerPublicKey: organizer.identityPublicKey,
              slotIds: ["slot_1"],
              contentEnvelope,
              status: "open",
              resolvedSlotId: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              myWrappedKey,
              myVotes: [],
            },
          ],
        }),
      })
    );

    const events = await listGroupEvents(recipient);
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("Sync");
    expect(events[0].slots).toEqual(slots);
  }, 15_000);

  it("submitVotes posts the rankings", async () => {
    const session = await makeSession("pw3");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await submitVotes(session, "ge-3", [{ slotId: "slot_1", rank: 1 }]);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/group-events/ge-3/votes");
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent).toEqual({ rankings: [{ slotId: "slot_1", rank: 1 }] });
  }, 15_000);
});
