import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App.js";
import { stubCapabilityServer } from "./mockServer.js";
import { testSession } from "./testSession.js";

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

  it("shows the schedule once a session is present, with a single sign-out", async () => {
    const session = testSession();
    localStorage.setItem("schedule-app:session", JSON.stringify(session));
    stubCapabilityServer(session);
    render(<App />);
    expect(await screen.findByText(/no events yet/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /sign out/i })).toHaveLength(1);
  });

  it("signing out returns to the sign-in form", async () => {
    const session = testSession();
    localStorage.setItem("schedule-app:session", JSON.stringify(session));
    stubCapabilityServer(session);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /sign out/i }));
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
    expect(localStorage.getItem("schedule-app:session")).toBeNull();
  });
});
