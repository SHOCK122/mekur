import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App.js";

describe("App", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("shows the sign-in form when there is no saved session", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: /schedule/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("switches to the register form", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /need an account/i }));
    expect(screen.getByRole("button", { name: /create account/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
  });

  it("shows the calendar once a session is present in localStorage", async () => {
    localStorage.setItem(
      "schedule-app:session",
      JSON.stringify({ userId: "u1", username: "ada", token: "t", encryptionKey: "k" })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ events: [] }) })
    );
    render(<App />);
    expect(screen.getByRole("heading", { name: /your schedule/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/no events yet/i)).toBeInTheDocument());
  });
});
