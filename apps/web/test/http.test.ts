import { describe, it, expect } from "vitest";
import { parseJsonOrThrow } from "../src/lib/http.js";

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
