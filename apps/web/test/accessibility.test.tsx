import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { deriveAuthAndEncryptionKeys } from "@schedule-app/crypto";
import { Calendar } from "../src/components/Calendar.js";
import { stubCapabilityServer } from "./mockServer.js";
import { AuthForm } from "../src/components/AuthForm.js";
import type { Session } from "../src/lib/session.js";

async function makeSession(): Promise<Session> {
  const keys = await deriveAuthAndEncryptionKeys("pw");
  return {
    userId: "u1",
    username: "ada",
    token: "t",
    encryptionKey: keys.encryptionKey,
    identityPublicKey: keys.identityKeyPair.publicKey,
    identitySecretKey: keys.identityKeyPair.secretKey,
  };
}


/** The timeline is the default view; these assertions target list-view
 * markup, so they switch explicitly. */
function switchToListView() {
  // The view toggle now lives behind a disclosure button.
  fireEvent.click(screen.getByRole("button", { name: /view options/i }));
  fireEvent.click(screen.getByRole("button", { name: /^list$/i }));
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

  it("the calendar's event-title input has an accessible name, not just a placeholder", async () => {
    const session = await makeSession();
    stubCapabilityServer(session);
    render(<Calendar session={session} onLogout={() => {}} />);
    switchToListView();
    // A placeholder alone is not an accessible name: it isn't reliably
    // announced and disappears as soon as the person types.
    expect(screen.getByLabelText(/event title/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/no events yet/i)).toBeInTheDocument());
  }, 15_000);


  it("announces loading state to assistive tech rather than silently swapping content", async () => {
    const session = await makeSession();
    // Never-resolving fetch so the loading state stays visible.
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise(() => {})));
    render(<Calendar session={session} onLogout={() => {}} />);
    switchToListView();
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/loading/i);
  }, 15_000);

  it("icon-only priority controls expose what they do and which event they affect", async () => {
    const session = await makeSession();
    const content = {
      title: "Dentist",
      startTime: new Date(Date.now() + 86_400_000).toISOString(),
      endTime: new Date(Date.now() + 90_000_000).toISOString(),
      priority: 0,
    };
    stubCapabilityServer(session, [{ id: "e1", content }]);

    render(<Calendar session={session} onLogout={() => {}} />);

    switchToListView();
    await waitFor(() => expect(screen.getByText("Dentist")).toBeInTheDocument());

    // Triangle glyphs convey nothing to a screen reader on their own.
    expect(screen.getByRole("button", { name: /raise priority of Dentist/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /lower priority of Dentist/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete Dentist/i })).toBeInTheDocument();
  }, 15_000);

  it("surfaces errors via an alert role so they aren't missed", async () => {
    const session = await makeSession();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    render(<Calendar session={session} onLogout={() => {}} />);
    switchToListView();
    // No cache and a failed fetch => a real error the person must notice.
    const alert = await screen.findByRole("alert");
    expect(alert).toBeInTheDocument();
  }, 15_000);
});
