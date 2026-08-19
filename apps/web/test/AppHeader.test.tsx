import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  deriveAuthAndEncryptionKeys,
  encryptEnvelope,
  deriveSharedWrapKey,
  generateKeyPair,
} from "@schedule-app/crypto";
import { AppHeader } from "../src/components/AppHeader.js";
import type { Session } from "../src/lib/session.js";

let session: Session;

beforeEach(async () => {
  localStorage.clear();
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

/** Builds an inbox message the way sendInvite actually packages one: a
 * fresh ephemeral keypair wraps the key to the recipient's identity public
 * key. Self-addressed here (session is both "sender" and recipient) purely
 * for test convenience -- the crypto correctness for genuinely distinct
 * sender/recipient keypairs is covered separately in sharing.test.ts. */
function inviteMessage(overrides: Record<string, unknown> = {}) {
  const ephemeral = generateKeyPair();
  const wrapKey = deriveSharedWrapKey(ephemeral.secretKey, session.identityPublicKey);
  return {
    id: "msg-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    envelope: {
      ephemeralPublicKey: ephemeral.publicKey,
      payload: encryptEnvelope(
        {
          kind: "event-invite",
          eventId: "e1",
          viewToken: "vt",
          eventKey: "ek",
          viaCode: false,
          fromDisplayName: "Bob",
          fromFriendCode: "BOBCODE1",
          ...overrides,
        },
        wrapKey,
        "invite"
      ),
    },
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
    render(<AppHeader session={session} onLogout={() => {}} onInvitationAccepted={() => {}} />);
    expect(screen.getByText("ada")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
  }, 20_000);

  it("reveals the one-time invite code and can replace it", async () => {
    stubServer();
    const user = userEvent.setup();
    render(<AppHeader session={session} onLogout={() => {}} onInvitationAccepted={() => {}} />);

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
    render(<AppHeader session={session} onLogout={() => {}} onInvitationAccepted={onAccepted} />);

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
    render(<AppHeader session={session} onLogout={() => {}} onInvitationAccepted={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Bob invited you/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /add connection/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /block/i })).toBeInTheDocument();
  }, 20_000);

  it("never offers connect or block for an anonymous code invite", async () => {
    // The code exists precisely so no lasting identity is exchanged. There
    // is nothing stable to connect to, and offering it would imply the
    // sender is identifiable when they deliberately are not.
    stubServer([
      inviteMessage({ viaCode: true, fromDisplayName: undefined, fromFriendCode: undefined }),
    ]);
    render(<AppHeader session={session} onLogout={() => {}} onInvitationAccepted={() => {}} />);

    await waitFor(() => expect(screen.getByText(/someone invited you/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /add connection/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /block/i })).not.toBeInTheDocument();
    // And it must not name anyone.
    expect(screen.queryByText(/Bob/)).not.toBeInTheDocument();
  }, 20_000);

  it("hides invitations from a blocked sender, filtering client-side", async () => {
    localStorage.setItem(
      `schedule-app:connections:${session.userId}`,
      JSON.stringify([{ friendCode: "BOBCODE1", displayName: "Bob", state: "blocked" }])
    );
    stubServer([inviteMessage()]);
    render(<AppHeader session={session} onLogout={() => {}} onInvitationAccepted={() => {}} />);

    await waitFor(() => expect(screen.getByText("ada")).toBeInTheDocument());
    // The server can't filter for us -- it doesn't know who contacts whom --
    // so this has to happen here.
    expect(screen.queryByText(/Bob invited you/i)).not.toBeInTheDocument();
  }, 20_000);
});
