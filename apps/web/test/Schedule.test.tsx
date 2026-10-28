import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { decryptEnvelope } from "@schedule-app/crypto";
import type { EventContent } from "@schedule-app/shared";
import { Schedule } from "../src/components/Schedule.js";
import { useEvents } from "../src/hooks/useEvents.js";
import type { Session } from "../src/lib/session.js";
import { stubCapabilityServer, lastKeyringWrite, lastEventUpdate, type MockEvent } from "./mockServer.js";
import { testSession } from "./testSession.js";

let session: Session;

beforeEach(() => {
  localStorage.clear();
  session = testSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function Harness() {
  return <Schedule session={session} data={useEvents(session)} />;
}

const HOUR = 3_600_000;

describe("Schedule", () => {
  it("shows an empty state when there are no events", async () => {
    stubCapabilityServer(session);
    render(<Harness />);
    expect(await screen.findByText(/no events yet/i)).toBeInTheDocument();
  });

  it("saves 'repeat until' when creating an event", async () => {
    // Regression: the form collected an end date and silently dropped it.
    const fetchMock = stubCapabilityServer(session);
    const user = userEvent.setup();
    render(<Harness />);
    await screen.findByText(/no events yet/i);

    await user.type(screen.getByLabelText(/event title/i), "Gym");
    await user.click(screen.getByRole("button", { name: /repeat/i }));
    // Set the value in one go, as a date picker does: typing into a date
    // input character by character is timing-sensitive in jsdom, which
    // sanitises each partial date to "".
    fireEvent.change(screen.getByLabelText(/repeat until/i), { target: { value: "2027-01-31" } });
    await user.click(screen.getByRole("button", { name: /add event/i }));

    await waitFor(() => expect(lastKeyringWrite(fetchMock, session)).toHaveLength(1));
    const { eventKey } = lastKeyringWrite(fetchMock, session)![0] as unknown as { eventKey: string };
    const post = fetchMock.mock.calls.find((c) => c[0] === "/api/events" && c[1]?.method === "POST")!;
    const created = decryptEnvelope<EventContent>(JSON.parse(post[1].body).envelope, eventKey);
    expect(created.recurrence?.freq).toBe("DAILY");
    expect(new Date(created.recurrence!.until!).getFullYear()).toBe(2027);
    // New events get a rank up front instead of relying on render-time fallback.
    expect(created.rank).toBeTruthy();
  });

  it("'Skip this one' skips the occurrence that was opened, not the series start", async () => {
    // Regression: the edit panel passed the series' first start time, so
    // skipping from a long-running series removed an occurrence from weeks ago.
    const seriesStart = new Date(Date.now() - 10 * 24 * HOUR - HOUR);
    const events: MockEvent[] = [
      {
        id: "daily",
        content: {
          title: "Standup",
          startTime: seriesStart.toISOString(),
          endTime: new Date(seriesStart.getTime() + HOUR / 4).toISOString(),
          recurrence: { freq: "DAILY", interval: 1 },
        },
      },
    ];
    const fetchMock = stubCapabilityServer(session, events);
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(await screen.findByRole("button", { name: "Standup" }));
    await user.click(await screen.findByRole("button", { name: /^delete$/i }));
    await user.click(await screen.findByRole("button", { name: /skip this one/i }));

    await waitFor(() => expect(lastEventUpdate(fetchMock, session.encryptionKey)).not.toBeNull());
    const [skipped] = lastEventUpdate(fetchMock, session.encryptionKey)!.skippedOccurrences!;
    expect(new Date(skipped!).getTime()).not.toBe(seriesStart.getTime());
    expect(Math.abs(new Date(skipped!).getTime() - Date.now())).toBeLessThan(24 * HOUR);
  });

  it("removes a view-only event from this schedule without deleting it for anyone else", async () => {
    const events: MockEvent[] = [
      {
        id: "shared",
        canEdit: false,
        content: { title: "Their party", startTime: new Date(Date.now() - HOUR).toISOString() },
      },
    ];
    const fetchMock = stubCapabilityServer(session, events);
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(await screen.findByRole("button", { name: "Their party" }));
    await user.click(await screen.findByRole("button", { name: /remove from my schedule/i }));

    await waitFor(() => expect(lastKeyringWrite(fetchMock, session)).toEqual([]));
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "DELETE")).toBe(false);
  });

  it("opens sharing from the edit panel", async () => {
    // Sharing used to be reachable only from the hidden list view.
    stubCapabilityServer(session, [
      { id: "mine", content: { title: "Dinner", startTime: new Date(Date.now() - HOUR).toISOString() } },
    ]);
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(await screen.findByRole("button", { name: "Dinner" }));
    await user.click(await screen.findByRole("button", { name: /^share$/i }));
    expect(await screen.findByRole("region", { name: /share dinner/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/username or one-time code/i)).toBeInTheDocument();
  });

  it("falls back to cached events with an offline notice when the network fails", async () => {
    localStorage.setItem(
      `schedule-app:event-cache:${session.userId}`,
      JSON.stringify([
        { id: "c1", title: "Cached meeting", startTime: new Date(Date.now() - HOUR).toISOString(), canEdit: true },
      ])
    );
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<Harness />);
    expect(await screen.findByText(/you.re offline/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cached meeting" })).toBeInTheDocument();
  });
});
