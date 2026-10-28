import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPair, openSealed } from "@schedule-app/crypto";
import { encodeShareCode, decodeShareCode, createShareCode, redeemShareCode } from "../src/lib/events.js";
import { sendInvite } from "../src/lib/social.js";
import { loadKeyring } from "../src/lib/keyring.js";
import { stubCapabilityServer } from "./mockServer.js";
import type { Session } from "../src/lib/session.js";
import { testSession } from "./testSession.js";

let session: Session;

beforeEach(() => {
  localStorage.clear();
  session = testSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const content = {
  title: "Offsite",
  startTime: "2026-09-01T09:00:00.000Z",
  endTime: "2026-09-01T10:00:00.000Z",
};

describe("share codes", () => {
  it("round-trips a payload", () => {
    const payload = { eventId: "e1", viewToken: "vt", eventKey: "ek" };
    expect(decodeShareCode(encodeShareCode(payload))).toEqual(payload);
  });

  it("is URL-safe, so it survives being pasted into a link or message", () => {
    const code = encodeShareCode({ eventId: "e1", viewToken: "a+b/c", eventKey: "d+e/f" });
    expect(code).not.toMatch(/[+/=]/);
  });

  it("rejects a malformed code with a clear message rather than a crash", () => {
    expect(() => decodeShareCode("not-a-real-code")).toThrow();
  });

  it("carries the event key, since the server cannot supply it to a joiner", () => {
    // This is the defining property: the server holds no key, so a late
    // joiner can only decrypt if the code itself carries one.
    const decoded = decodeShareCode(encodeShareCode({ eventId: "e1", viewToken: "vt", eventKey: "SECRET" }));
    expect(decoded.eventKey).toBe("SECRET");
  });

  it("mints a join capability and packages it with the key", async () => {
    // Capture the base mock first, then delegate to it for everything
    // except the capability-minting call.
    const base = stubCapabilityServer(session, [{ id: "e1", content }]);
    const baseImpl = base.getMockImplementation()!;
    base.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/events/e1/capabilities") {
        return { ok: true, status: 201, json: async () => ({ token: "join-token" }) };
      }
      return baseImpl(url, init);
    });

    const code = await createShareCode(session, "e1");
    const decoded = decodeShareCode(code);
    expect(decoded.eventId).toBe("e1");
    expect(decoded.viewToken).toBe("join-token");
    expect(decoded.eventKey).toBeTruthy();
  }, 20_000);

  it("verifies a code works before storing it, so a bad code fails loudly", async () => {
    stubCapabilityServer(session);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        if (url.startsWith("/api/events/")) {
          return { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
        }
        return { ok: true, status: 200, json: async () => ({ keyring: null, version: 0 }) };
      })
    );
    const code = encodeShareCode({ eventId: "gone", viewToken: "vt", eventKey: "ek" });
    // Storing an unusable capability would produce an event that appears in
    // the keyring but can never be read -- fail now instead.
    await expect(redeemShareCode(session, code)).rejects.toThrow(/isn't valid|no longer/i);
  }, 20_000);
});

describe("sendInvite", () => {
  function stubInboxServer() {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/inbox/deliver") return { ok: true, status: 204, json: async () => ({}) };
      throw new Error("unexpected " + url);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const recipient = generateKeyPair();
  const target = (viaCode: boolean) => ({
    userId: "u2",
    publicKey: recipient.publicKey,
    displayName: viaCode ? "Anonymous invitee" : "Bob",
    username: viaCode ? undefined : "bob",
    viaCode,
  });
  const capability = { eventId: "EVENT-ID", viewToken: "VIEW-TOKEN", eventKey: "EVENT-KEY" };

  function openAsRecipient(fetchMock: ReturnType<typeof vi.fn>) {
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    return openSealed<Record<string, unknown>>(body.envelope, recipient.secretKey);
  }

  it("seals the invite so the server sees no event id, token, key or sender", async () => {
    const fetchMock = stubInboxServer();
    await sendInvite(session, target(false), capability);
    const body = fetchMock.mock.calls[0]![1].body as string;
    for (const secret of ["EVENT-ID", "VIEW-TOKEN", "EVENT-KEY", session.identityPublicKey, "ada"]) {
      expect(body).not.toContain(secret);
    }
  });

  it("can be opened by the recipient with only their own key", async () => {
    // Regression: invites used to be encrypted with ECDH(sender, recipient),
    // so the recipient needed the sender's public key -- which the server
    // deliberately doesn't record. Only self-addressed invites ever opened.
    const fetchMock = stubInboxServer();
    await sendInvite(session, target(false), capability);
    expect(openAsRecipient(fetchMock).payload.eventId).toBe("EVENT-ID");
  });

  it("proves the sender of a named invite, so it can be connected to or blocked", async () => {
    const fetchMock = stubInboxServer();
    await sendInvite(session, target(false), capability);
    const opened = openAsRecipient(fetchMock);
    expect(opened.senderPublicKey).toBe(session.identityPublicKey);
    expect(opened.payload.fromDisplayName).toBe("ada");
  });

  it("stays anonymous when the recipient was reached by one-time code", async () => {
    const fetchMock = stubInboxServer();
    await sendInvite(session, target(true), capability);
    // Enforced at construction, so no UI path can leak it later.
    const opened = openAsRecipient(fetchMock);
    expect(opened.senderPublicKey).toBeNull();
    expect(opened.payload.fromDisplayName).toBeUndefined();
    expect(opened.payload.fromUsername).toBeUndefined();
    expect(opened.payload.viaCode).toBe(true);
  });
});
