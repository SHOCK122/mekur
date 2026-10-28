import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { generateKeyPair, sealToRecipient, type KeyPair } from "@schedule-app/crypto";
import { AppHeader } from "../src/components/AppHeader.js";
import type { Session } from "../src/lib/session.js";
import { testSession } from "./testSession.js";

let session: Session;
let bob: KeyPair;

beforeEach(() => {
  localStorage.clear();
  session = testSession();
  bob = generateKeyPair();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Builds an inbox message the way sendInvite does: sealed to this
 * session, from Bob unless told the invite is anonymous. */
function inviteMessage(overrides: Record<string, unknown> = {}, sender: KeyPair | undefined = bob) {
  return {
    id: "msg-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    envelope: sealToRecipient(
      {
        kind: "event-invite",
        eventId: "e1",
        viewToken: "vt",
        eventKey: "ek",
        viaCode: false,
        fromDisplayName: "Bob",
        fromUsername: "bob",
        ...overrides,
      },
      session.identityPublicKey,
      sender
    ),
  };
}

function stubServer(messages: unknown[] = []) {
  const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/friend-code" && (init?.method ?? "GET") === "GET") {
      return { ok: true, status: 200, json: async () => ({ friendCode: { code: "ABCD2345", createdAt: "x" } }) };
    }
    if (url === "/api/friend-code/rotate") {
      return { ok: true, status: 200, json: async () => ({ friendCode: { code: "ZZZZ9999", createdAt: "x" } }) };
    }
    if (url === "/api/inbox" && (init?.method ?? "GET") === "GET") {
      return { ok: true, status: 200, json: async () => ({ messages }) };
    }
    if (url.startsWith("/api/inbox/")) {
      return { ok: true, status: 204, json: async () => ({}) };
    }
    if (url === "/api/keyring") {
      return { ok: true, status: 200, json: async () => ({ keyring: null, version: 0 }) };
    }
    throw new Error("unexpected " + url);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("AppHeader", () => {
  it("shows who is signed in and offers sign out", async () => {
    stubServer();
    render(<AppHeader session={session} onLogout={() => {}} onEventsChanged={() => {}} />);
    expect(screen.getByText("ada")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
  }, 20_000);

  it("reveals the one-time invite code and can replace it", async () => {
    stubServer();
    const user = userEvent.setup();
    render(<AppHeader session={session} onLogout={() => {}} onEventsChanged={() => {}} />);

    await user.click(screen.getByRole("button", { name: /invite code/i }));
    await waitFor(() => expect(screen.getByText("ABCD2345")).toBeInTheDocument());
    // The single-use nature must be stated, not assumed -- someone sharing
    // a code needs to know it stops working after one use.
    expect(screen.getByText(/single use/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /replace this code/i }));
    await waitFor(() => expect(screen.getByText("ZZZZ9999")).toBeInTheDocument());
  }, 20_000);

  it("lists an invitation and can accept it", async () => {
    const fetchMock = stubServer([inviteMessage()]);
    const onAccepted = vi.fn();
    const user = userEvent.setup();
    render(<AppHeader session={session} onLogout={() => {}} onEventsChanged={onAccepted} />);

    await waitFor(() => expect(screen.getByText(/Bob invited you/i)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^accept$/i }));

    // Accepting must record the capability in the keyring, or the event is
    // unreachable despite having been accepted.
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => c[0] === "/api/keyring" && c[1]?.method === "PUT")).toBe(true)
    );
    expect(onAccepted).toHaveBeenCalled();
  }, 20_000);

  it("offers connect and block for a named invite", async () => {
    stubServer([inviteMessage()]);
    render(<AppHeader session={session} onLogout={() => {}} onEventsChanged={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Bob invited you/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /add connection/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /block/i })).toBeInTheDocument();
  }, 20_000);

  it("never offers connect or block for an anonymous code invite", async () => {
    // The code exists precisely so no lasting identity is exchanged. There
    // is nothing stable to connect to, and offering it would imply the
    // sender is identifiable when they deliberately are not.
    stubServer([
      inviteMessage({ viaCode: true, fromDisplayName: undefined, fromUsername: undefined }, undefined),
    ]);
    render(<AppHeader session={session} onLogout={() => {}} onEventsChanged={() => {}} />);

    await waitFor(() => expect(screen.getByText(/someone invited you/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /add connection/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /block/i })).not.toBeInTheDocument();
    // And it must not name anyone.
    expect(screen.queryByText(/Bob/)).not.toBeInTheDocument();
  }, 20_000);

  it("hides invitations from a blocked sender, filtering client-side", async () => {
    localStorage.setItem(
      `schedule-app:connections:${session.userId}`,
      JSON.stringify([{ publicKey: bob.publicKey, displayName: "Bob", state: "blocked" }])
    );
    stubServer([inviteMessage()]);
    render(<AppHeader session={session} onLogout={() => {}} onEventsChanged={() => {}} />);

    await waitFor(() => expect(screen.getByText("ada")).toBeInTheDocument());
    // The server can't filter for us -- it doesn't know who contacts whom --
    // so this has to happen here.
    expect(screen.queryByText(/Bob invited you/i)).not.toBeInTheDocument();
  }, 20_000);

  it("keeps blocking someone who renames themselves, because blocks follow the verified key", async () => {
    localStorage.setItem(
      `schedule-app:connections:${session.userId}`,
      JSON.stringify([{ publicKey: bob.publicKey, displayName: "Bob", state: "blocked" }])
    );
    stubServer([inviteMessage({ fromDisplayName: "Definitely not Bob", fromUsername: "notbob" })]);
    render(<AppHeader session={session} onLogout={() => {}} onEventsChanged={() => {}} />);
    await waitFor(() => expect(screen.getByText("ada")).toBeInTheDocument());
    expect(screen.queryByText(/invited you/i)).not.toBeInTheDocument();
  });

  it("shows a saved connection's name rather than the self-described one", async () => {
    localStorage.setItem(
      `schedule-app:connections:${session.userId}`,
      JSON.stringify([{ publicKey: bob.publicKey, displayName: "Bob from work", state: "connected" }])
    );
    stubServer([inviteMessage({ fromDisplayName: "Someone Important" })]);
    render(<AppHeader session={session} onLogout={() => {}} onEventsChanged={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Bob from work invited you/i)).toBeInTheDocument());
    // Already a connection, so don't offer to add them again.
    expect(screen.queryByRole("button", { name: /add connection/i })).not.toBeInTheDocument();
  });

  it("drops an invite whose claimed sender doesn't verify", async () => {
    const mallory = generateKeyPair();
    // Mallory claims to be Bob's key but can only sign with her own.
    stubServer([inviteMessage({}, { publicKey: bob.publicKey, secretKey: mallory.secretKey })]);
    render(<AppHeader session={session} onLogout={() => {}} onEventsChanged={() => {}} />);
    await waitFor(() => expect(screen.getByText("ada")).toBeInTheDocument());
    expect(screen.queryByText(/invited you/i)).not.toBeInTheDocument();
  });

  it("records a block against the sender's key and discards their invite", async () => {
    const fetchMock = stubServer([inviteMessage()]);
    const user = userEvent.setup();
    render(<AppHeader session={session} onLogout={() => {}} onEventsChanged={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Bob invited you/i)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /block/i }));

    const saved = JSON.parse(localStorage.getItem(`schedule-app:connections:${session.userId}`)!);
    expect(saved).toEqual([expect.objectContaining({ publicKey: bob.publicKey, state: "blocked" })]);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => c[0] === "/api/inbox/msg-1" && c[1]?.method === "DELETE")).toBe(true)
    );
  });

  it("deletes invites from blocked senders and unreadable messages, so they can't fill the inbox", async () => {
    // Hidden messages still count toward the server's 200-message inbox cap;
    // left in place, a blocked sender could push real invites out of view.
    localStorage.setItem(
      `schedule-app:connections:${session.userId}`,
      JSON.stringify([{ publicKey: bob.publicKey, displayName: "Bob", state: "blocked" }])
    );
    const garbage = { ...inviteMessage(), id: "msg-garbage" };
    garbage.envelope = sealToRecipient("not for you", generateKeyPair().publicKey);
    const fetchMock = stubServer([inviteMessage(), garbage]);
    render(<AppHeader session={session} onLogout={() => {}} onEventsChanged={() => {}} />);

    const deleted = () =>
      fetchMock.mock.calls.filter((c) => c[1]?.method === "DELETE").map((c) => c[0]).sort();
    await waitFor(() => expect(deleted()).toEqual(["/api/inbox/msg-1", "/api/inbox/msg-garbage"]));
    expect(screen.queryByText(/invited you/i)).not.toBeInTheDocument();
  });
});
