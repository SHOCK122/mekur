import { describe, it, expect, vi, afterEach } from "vitest";
import { parseJsonOrThrow, apiFetch } from "../src/lib/http.js";

function mockResponse(ok: boolean, status: number, body: unknown): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

describe("parseJsonOrThrow", () => {
  it("returns the parsed body on success", async () => {
    const response = mockResponse(true, 200, { hello: "world" });
    expect(await parseJsonOrThrow(response)).toEqual({ hello: "world" });
  });

  it("throws the server's error message on failure", async () => {
    const response = mockResponse(false, 401, { error: "Invalid username or password" });
    await expect(parseJsonOrThrow(response)).rejects.toThrow("Invalid username or password");
  });

  it("surfaces validation details instead of just a generic error code", async () => {
    // This is the actual bug: a 400 with zod `details` used to collapse
    // into a bare "Invalid request" with no indication of what to fix.
    const response = mockResponse(false, 400, {
      error: "Invalid request",
      details: [{ path: ["username"], message: "username must be lowercase letters, numbers, _ . -" }],
    });
    await expect(parseJsonOrThrow(response)).rejects.toThrow(
      "Invalid request: username: username must be lowercase letters, numbers, _ . -"
    );
  });

  it("joins multiple validation issues", async () => {
    const response = mockResponse(false, 400, {
      error: "Invalid request",
      details: [
        { path: ["title"], message: "title is required" },
        { path: ["endTime"], message: "endTime must be after startTime" },
      ],
    });
    await expect(parseJsonOrThrow(response)).rejects.toThrow(
      "Invalid request: title: title is required; endTime: endTime must be after startTime"
    );
  });

  it("falls back to a generic message when the body can't be parsed as JSON", async () => {
    const response = {
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    } as Response;
    await expect(parseJsonOrThrow(response)).rejects.toThrow("Request failed with status 500");
  });
});

describe("apiFetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("omits Content-Type when there is no body, so a DELETE isn't rejected", async () => {
    // Regression: Fastify refuses JSON-typed requests with no body, which
    // surfaced as a bare "Bad Request" when deleting an event.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    await apiFetch(null, "/events/x", { method: "DELETE", capability: "cap" });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.headers).not.toHaveProperty("Content-Type");
    expect(init.headers).toHaveProperty("x-event-capability", "cap");
  });

  it("keeps the status on errors so callers can branch on it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: "conflict" }) })
    );
    await expect(apiFetch(null, "/keyring")).rejects.toMatchObject({ status: 409 });
  });

  it("treats explicitly allowed statuses as success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));
    await expect(apiFetch(null, "/push-subscriptions", { method: "DELETE", allow: [404] })).resolves.toEqual({});
  });
});
