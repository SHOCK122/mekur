import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deriveAuthAndEncryptionKeys, decryptEnvelope, deriveSharedWrapKey } from "@schedule-app/crypto";
import { encodeShareCode, decodeShareCode, createShareCode, redeemShareCode } from "../src/lib/events.js";
import { sendInvite } from "../src/lib/social.js";
import { loadKeyring } from "../src/lib/keyring.js";
import { stubCapabilityServer } from "./mockServer.js";
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

const content = {
  title: "Offsite",
  startTime: "2026-09-01T09:00:00.000Z",
  endTime: "2026-09-01T10:00:00.000Z",
  priority: 0,
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

  it("encrypts the invite so the server sees no event id, token or key", async () => {
    const fetchMock = stubInboxServer();
    await sendInvite(
      session,
      { userId: "u2", publicKey: session.identityPublicKey, displayName: "Bob", viaCode: false },
      { eventId: "EVENT-ID", viewToken: "VIEW-TOKEN", eventKey: "EVENT-KEY", fromDisplayName: "ada" }
    );
    const body = fetchMock.mock.calls[0]![1].body as string;
    expect(body).not.toContain("EVENT-ID");
    expect(body).not.toContain("VIEW-TOKEN");
    expect(body).not.toContain("EVENT-KEY");
  }, 20_000);

  it("strips sender identity when the recipient was reached by anonymous code", async () => {
    const fetchMock = stubInboxServer();
    await sendInvite(
      session,
      { userId: "u2", publicKey: session.identityPublicKey, displayName: "Anonymous invitee", viaCode: true },
      {
        eventId: "e1",
        viewToken: "vt",
        eventKey: "ek",
        fromDisplayName: "ada",
        fromUsername: "ada",
        fromFriendCode: "ADACODE1",
      }
    );
    // Decrypt as the recipient would and confirm nothing identifies the
    // sender. Enforced at construction so the UI cannot leak it later.
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    const wrapKey = deriveSharedWrapKey(session.identitySecretKey, session.identityPublicKey);
    const invite = decryptEnvelope<Record<string, unknown>>(body.envelope, wrapKey);
    expect(invite.fromDisplayName).toBeUndefined();
    expect(invite.fromUsername).toBeUndefined();
    expect(invite.fromFriendCode).toBeUndefined();
    expect(invite.viaCode).toBe(true);
  }, 20_000);

  it("keeps sender identity for a named invite, so it can be connected to", async () => {
    const fetchMock = stubInboxServer();
    await sendInvite(
      session,
      { userId: "u2", publicKey: session.identityPublicKey, displayName: "Bob", username: "bob", viaCode: false },
      { eventId: "e1", viewToken: "vt", eventKey: "ek", fromDisplayName: "ada", fromFriendCode: "ADACODE1" }
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    const wrapKey = deriveSharedWrapKey(session.identitySecretKey, session.identityPublicKey);
    const invite = decryptEnvelope<Record<string, unknown>>(body.envelope, wrapKey);
    expect(invite.fromDisplayName).toBe("ada");
    expect(invite.fromFriendCode).toBe("ADACODE1");
  }, 20_000);
});
