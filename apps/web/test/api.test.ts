import { describe, it, expect, vi, afterEach } from "vitest";
import { encryptEnvelope, deriveAuthAndEncryptionKeys } from "@schedule-app/crypto";
import { register, login, listEvents, createEvent } from "../src/lib/api.js";

describe("api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("register() posts derived keys, never the raw password", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        user: { id: "user-1", username: "ada" },
        token: "jwt-token",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = await register("ada", "Ada Lovelace", "correct horse battery staple");

    expect(session).toEqual({
      userId: "user-1",
      username: "ada",
      token: "jwt-token",
      encryptionKey: expect.any(String),
    });
    const [, requestInit] = fetchMock.mock.calls[0];
    const sentBody = JSON.parse(requestInit.body);
    expect(sentBody.username).toBe("ada");
    expect(JSON.stringify(sentBody)).not.toContain("correct horse battery staple");
  }, 15_000);

  it("login() fetches the salt, derives keys, and posts only the authKey", async () => {
    const registered = await deriveAuthAndEncryptionKeys("hunter2222");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ authSalt: registered.salt }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user: { id: "user-1", username: "ada" }, token: "jwt-token" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const session = await login("ada", "hunter2222");

    expect(session.token).toBe("jwt-token");
    expect(session.encryptionKey).toBe(registered.encryptionKey);
    const loginRequestBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(loginRequestBody).toEqual({ username: "ada", authKey: registered.authKey });
  }, 15_000);

  it("propagates a clear error on invalid login", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ authSalt: "c29tZXNhbHQ=" }) })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: "Invalid username or password" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(login("ada", "wrong")).rejects.toThrow("Invalid username or password");
  }, 15_000);

  it("listEvents() decrypts every envelope returned by the server", async () => {
    const session = {
      userId: "user-1",
      username: "ada",
      token: "jwt-token",
      encryptionKey: (await deriveAuthAndEncryptionKeys("pw")).encryptionKey,
    };
    const content = { title: "Standup", startTime: "2026-08-01T09:00:00.000Z", endTime: "2026-08-01T09:15:00.000Z" };
    const envelope = encryptEnvelope(content, session.encryptionKey, "user-key-1");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ events: [{ id: "event-1", envelope }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const events = await listEvents(session);
    expect(events).toEqual([{ id: "event-1", ...content }]);
  }, 15_000);

  it("createEvent() sends an encrypted envelope, never the plaintext title", async () => {
    const session = {
      userId: "user-1",
      username: "ada",
      token: "jwt-token",
      encryptionKey: (await deriveAuthAndEncryptionKeys("pw")).encryptionKey,
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ event: { id: "event-1" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const content = { title: "Secret plan", startTime: "2026-08-01T09:00:00.000Z", endTime: "2026-08-01T09:15:00.000Z" };
    await createEvent(session, content);

    const sentBody = fetchMock.mock.calls[0][1].body;
    expect(sentBody).not.toContain("Secret plan");
  }, 15_000);
});
