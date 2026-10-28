import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Schedule } from "../src/components/Schedule.js";
import { AuthForm } from "../src/components/AuthForm.js";
import { useEvents } from "../src/hooks/useEvents.js";
import type { Session } from "../src/lib/session.js";
import { stubCapabilityServer } from "./mockServer.js";
import { testSession } from "./testSession.js";

function Harness({ session }: { session: Session }) {
  return <Schedule session={session} data={useEvents(session)} />;
}

describe("accessibility", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("every interactive control in the auth form has an accessible name", () => {
    render(<AuthForm onAuthenticated={() => {}} />);
    // getByLabelText throws if no accessible name resolves, so these
    // assertions double as the check.
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    for (const button of screen.getAllByRole("button")) {
      expect(button.textContent?.trim()).toBeTruthy();
    }
  });

  it("the create form's inputs have accessible names, not just placeholders", async () => {
    const session = testSession();
    stubCapabilityServer(session);
    render(<Harness session={session} />);
    // A placeholder alone is not an accessible name: it isn't reliably
    // announced and disappears as soon as the person types.
    expect(screen.getByLabelText(/event title/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/start time/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/end time/i)).toBeInTheDocument();
    await screen.findByText(/no events yet/i);
  });

  it("announces loading state to assistive tech rather than silently swapping content", async () => {
    const session = testSession();
    // Never-resolving fetch so the loading state stays visible.
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise(() => {})));
    render(<Harness session={session} />);
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/loading/i);
  });

  it("timeline events are reachable as named buttons", async () => {
    const session = testSession();
    stubCapabilityServer(session, [
      { id: "e1", content: { title: "Dentist", startTime: new Date(Date.now() - 3_600_000).toISOString() } },
    ]);
    render(<Harness session={session} />);
    expect(await screen.findByRole("button", { name: "Dentist" })).toBeInTheDocument();
  });

  it("surfaces errors via an alert role so they aren't missed", async () => {
    const session = testSession();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    render(<Harness session={session} />);
    // No cache and a failed fetch => a real error the person must notice.
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
