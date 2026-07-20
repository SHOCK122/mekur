import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { App } from "../src/App.js";

describe("App", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the app title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) })
    );
    render(<App />);
    expect(screen.getByRole("heading", { name: /schedule app/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("api-status")).toHaveTextContent("online"));
  });

  it("shows online once the API health check succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) })
    );
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("api-status")).toHaveTextContent("online")
    );
  });

  it("shows offline if the API health check fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("api-status")).toHaveTextContent("offline")
    );
  });
});
