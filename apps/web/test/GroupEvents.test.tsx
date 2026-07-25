import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  deriveAuthAndEncryptionKeys,
  deriveSharedWrapKey,
  wrapKey,
  generateSymmetricKey,
  encryptEnvelope,
} from "@schedule-app/crypto";
import { GroupEvents } from "../src/components/GroupEvents.js";
import type { Session } from "../src/lib/session.js";

async function makeSession(password: string, overrides: Partial<Session> = {}): Promise<Session> {
  const keys = await deriveAuthAndEncryptionKeys(password);
  return {
    userId: "user-1",
    username: "ada",
    token: "t",
    encryptionKey: keys.encryptionKey,
    identityPublicKey: keys.identityKeyPair.publicKey,
    identitySecretKey: keys.identityKeyPair.secretKey,
    ...overrides,
  };
}

describe("GroupEvents", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the create form and an empty state with no events", async () => {
    const session = await makeSession("pw");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ groupEvents: [] }) })
    );
    render(<GroupEvents session={session} />);
    expect(screen.getByPlaceholderText(/event title/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/no group events yet/i)).toBeInTheDocument());
  }, 15_000);

  it("shows a pending-vote badge for an open event the user hasn't voted on", async () => {
    const organizer = await makeSession("organizer-pw", { userId: "organizer-id" });
    const recipient = await makeSession("recipient-pw", { userId: "recipient-id" });

    const eventKey = generateSymmetricKey();
    const slots = { slot_1: { startTime: "2026-09-01T09:00:00.000Z", endTime: "2026-09-01T09:30:00.000Z" } };
    const contentEnvelope = encryptEnvelope({ title: "Planning sync", slots }, eventKey, "group-event-key");
    const myWrappedKey = wrapKey(
      eventKey,
      deriveSharedWrapKey(organizer.identitySecretKey, recipient.identityPublicKey)
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          groupEvents: [
            {
              id: "ge-1",
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

    render(<GroupEvents session={recipient} />);
    await waitFor(() => expect(screen.getByText("Planning sync")).toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent(/1 awaiting your vote/i);
  }, 15_000);

  it("submits a ranking via the vote form", async () => {
    const organizer = await makeSession("organizer-pw-2", { userId: "organizer-id-2" });
    const recipient = await makeSession("recipient-pw-2", { userId: "recipient-id-2" });

    const eventKey = generateSymmetricKey();
    const slots = { slot_1: { startTime: "2026-09-02T09:00:00.000Z", endTime: "2026-09-02T09:30:00.000Z" } };
    const contentEnvelope = encryptEnvelope({ title: "Vote me", slots }, eventKey, "group-event-key");
    const myWrappedKey = wrapKey(
      eventKey,
      deriveSharedWrapKey(organizer.identitySecretKey, recipient.identityPublicKey)
    );
    const record = {
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
    };

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/group-events") {
        return { ok: true, json: async () => ({ groupEvents: [record] }) };
      }
      if (url === "/api/group-events/ge-2/votes") {
        return { ok: true, status: 204, json: async () => ({}) };
      }
      throw new Error("unexpected url " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<GroupEvents session={recipient} />);
    await waitFor(() => expect(screen.getByText("Vote me")).toBeInTheDocument());

    const rankInput = screen.getByRole("spinbutton", { name: /rank for/i });
    await user.type(rankInput, "1");
    await user.click(screen.getByRole("button", { name: /submit my ranking/i }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => c[0] === "/api/group-events/ge-2/votes")).toBe(true)
    );
    const voteCall = fetchMock.mock.calls.find((c) => c[0] === "/api/group-events/ge-2/votes")!;
    expect(JSON.parse(voteCall[1].body)).toEqual({ rankings: [{ slotId: "slot_1", rank: 1 }] });
  }, 15_000);

  it("shows a Resolve button only to the organizer, not other participants", async () => {
    const organizer = await makeSession("organizer-pw-3", { userId: "organizer-id-3" });
    const recipient = await makeSession("recipient-pw-3", { userId: "recipient-id-3" });

    const eventKey = generateSymmetricKey();
    const slots = { slot_1: { startTime: "2026-09-03T09:00:00.000Z", endTime: "2026-09-03T09:30:00.000Z" } };
    const contentEnvelope = encryptEnvelope({ title: "Who resolves?", slots }, eventKey, "group-event-key");
    const myWrappedKey = wrapKey(
      eventKey,
      deriveSharedWrapKey(organizer.identitySecretKey, recipient.identityPublicKey)
    );
    const record = {
      id: "ge-3",
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
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ groupEvents: [record] }) })
    );

    render(<GroupEvents session={recipient} />);
    await waitFor(() => expect(screen.getByText("Who resolves?")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /resolve now/i })).not.toBeInTheDocument();
  }, 15_000);
});
