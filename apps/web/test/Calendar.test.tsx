import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { deriveAuthAndEncryptionKeys, encryptEnvelope } from "@schedule-app/crypto";
import { Calendar } from "../src/components/Calendar.js";
import { saveEventCache } from "../src/lib/eventCache.js";

describe("Calendar", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("renders decrypted events fetched from the server", async () => {
    const { encryptionKey } = await deriveAuthAndEncryptionKeys("pw");
    const session = { userId: "u1", username: "ada", token: "t", encryptionKey };
    const content = {
      title: "Standup",
      startTime: "2026-08-01T09:00:00.000Z",
      endTime: "2026-08-01T09:15:00.000Z",
    };
    const envelope = encryptEnvelope(content, encryptionKey, "user-key-1");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ events: [{ id: "event-1", envelope }] }),
      })
    );

    render(<Calendar session={session} onLogout={() => {}} />);
    await waitFor(() => expect(screen.getByText("Standup")).toBeInTheDocument());
  }, 15_000);

  it("shows an empty state when there are no events", async () => {
    const { encryptionKey } = await deriveAuthAndEncryptionKeys("pw");
    const session = { userId: "u1", username: "ada", token: "t", encryptionKey };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ events: [] }) })
    );

    render(<Calendar session={session} onLogout={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no events yet/i)).toBeInTheDocument());
  }, 15_000);

  it("calls onLogout when Sign out is clicked", async () => {
    const { encryptionKey } = await deriveAuthAndEncryptionKeys("pw");
    const session = { userId: "u1", username: "ada", token: "t", encryptionKey };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ events: [] }) })
    );

    const onLogout = vi.fn();
    const user = userEvent.setup();
    render(<Calendar session={session} onLogout={onLogout} />);
    await waitFor(() => expect(screen.getByText(/no events yet/i)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /sign out/i }));
    expect(onLogout).toHaveBeenCalled();
  }, 15_000);

  it("rejects an end time before the start time without calling the API", async () => {
    const { encryptionKey } = await deriveAuthAndEncryptionKeys("pw");
    const session = { userId: "u1", username: "ada", token: "t", encryptionKey };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ events: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<Calendar session={session} onLogout={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no events yet/i)).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText(/event title/i), "Backwards event");
    await user.type(screen.getByLabelText(/start time/i), "2026-08-01T10:00");
    await user.type(screen.getByLabelText(/end time/i), "2026-08-01T09:00");
    const callsBefore = fetchMock.mock.calls.length;
    await user.click(screen.getByRole("button", { name: /add event/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/end time must be after/i);
    expect(fetchMock.mock.calls.length).toBe(callsBefore); // no POST /events happened
  }, 15_000);

  it("submits a custom recurrence interval via the repeat toggle", async () => {
    const { encryptionKey } = await deriveAuthAndEncryptionKeys("pw");
    const session = { userId: "u1", username: "ada", token: "t", encryptionKey };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ events: [] }) }) // initial load
      .mockResolvedValueOnce({ ok: true, json: async () => ({ event: { id: "e1" } }) }) // create
      .mockResolvedValueOnce({ ok: true, json: async () => ({ events: [] }) }); // refresh after create
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<Calendar session={session} onLogout={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no events yet/i)).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText(/event title/i), "Check the oven");
    await user.type(screen.getByLabelText(/start time/i), "2026-08-01T09:00");
    await user.type(screen.getByLabelText(/end time/i), "2026-08-01T09:05");

    // Repeat options are collapsed by default, revealed by the toggle button.
    expect(screen.queryByLabelText(/repeat interval/i)).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /^repeat/i });
    await user.click(toggle);
    expect(screen.getByRole("button", { name: /^repeating/i })).toBeInTheDocument();

    const intervalInput = screen.getByLabelText(/repeat interval/i);
    await user.clear(intervalInput);
    await user.type(intervalInput, "37");
    await user.selectOptions(screen.getByLabelText(/^unit$/i), "MINUTELY");
    await user.click(screen.getByRole("button", { name: /add event/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const createCall = fetchMock.mock.calls[1];
    expect(createCall[0]).toBe("/api/events");
    // The envelope is encrypted, so we can't inspect the plaintext here directly,
    // but we can confirm no plaintext leaked into the request body.
    expect(createCall[1].body).not.toContain("Check the oven");
  }, 15_000);

  it("never shows a raw priority number to the user", async () => {
    const { encryptionKey } = await deriveAuthAndEncryptionKeys("pw");
    const session = { userId: "u1", username: "ada", token: "t", encryptionKey };
    const content = {
      title: "Important thing",
      startTime: "2026-08-01T09:00:00.000Z",
      endTime: "2026-08-01T09:15:00.000Z",
      priority: 7,
    };
    const envelope = encryptEnvelope(content, encryptionKey, "user-key-1");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ events: [{ id: "event-1", envelope }] }) })
    );

    render(<Calendar session={session} onLogout={() => {}} />);
    await waitFor(() => expect(screen.getByText("Important thing")).toBeInTheDocument());
    expect(screen.queryByText("7")).not.toBeInTheDocument();
    expect(screen.queryByText(/priority 7/i)).not.toBeInTheDocument();
  }, 15_000);

  it("raising priority (up arrow) updates only that event, incrementing its priority", async () => {
    const { encryptionKey } = await deriveAuthAndEncryptionKeys("pw");
    const session = { userId: "u1", username: "ada", token: "t", encryptionKey };
    const contentA = { title: "Event A", startTime: "2026-08-01T09:00:00.000Z", endTime: "2026-08-01T09:15:00.000Z", priority: 0 };
    const contentB = { title: "Event B", startTime: "2026-08-02T09:00:00.000Z", endTime: "2026-08-02T09:15:00.000Z", priority: 2 };
    const envelopeA = encryptEnvelope(contentA, encryptionKey, "user-key-1");
    const envelopeB = encryptEnvelope(contentB, encryptionKey, "user-key-1");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        events: [
          { id: "event-a", envelope: envelopeA },
          { id: "event-b", envelope: envelopeB },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<Calendar session={session} onLogout={() => {}} />);
    await waitFor(() => expect(screen.getByText("Event A")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /raise priority of event a/i }));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find((call) => call[1]?.method === "PUT");
      expect(putCall).toBeDefined();
    });
    const putCalls = fetchMock.mock.calls.filter((call) => call[1]?.method === "PUT");
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0][0]).toBe("/api/events/event-a");
  }, 15_000);

  it("lowering priority (down arrow) raises every OTHER event's priority, not the clicked one", async () => {
    const { encryptionKey } = await deriveAuthAndEncryptionKeys("pw");
    const session = { userId: "u1", username: "ada", token: "t", encryptionKey };
    const contentA = { title: "Event A", startTime: "2026-08-01T09:00:00.000Z", endTime: "2026-08-01T09:15:00.000Z", priority: 0 };
    const contentB = { title: "Event B", startTime: "2026-08-02T09:00:00.000Z", endTime: "2026-08-02T09:15:00.000Z", priority: 0 };
    const contentC = { title: "Event C", startTime: "2026-08-03T09:00:00.000Z", endTime: "2026-08-03T09:15:00.000Z", priority: 0 };
    const envelopeA = encryptEnvelope(contentA, encryptionKey, "user-key-1");
    const envelopeB = encryptEnvelope(contentB, encryptionKey, "user-key-1");
    const envelopeC = encryptEnvelope(contentC, encryptionKey, "user-key-1");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        events: [
          { id: "event-a", envelope: envelopeA },
          { id: "event-b", envelope: envelopeB },
          { id: "event-c", envelope: envelopeC },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<Calendar session={session} onLogout={() => {}} />);
    await waitFor(() => expect(screen.getByText("Event A")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /lower priority of event a/i }));

    await waitFor(() => {
      const putCalls = fetchMock.mock.calls.filter((call) => call[1]?.method === "PUT");
      expect(putCalls).toHaveLength(2);
    });
    const putUrls = fetchMock.mock.calls
      .filter((call) => call[1]?.method === "PUT")
      .map((call) => call[0]);
    expect(putUrls).toContain("/api/events/event-b");
    expect(putUrls).toContain("/api/events/event-c");
    expect(putUrls).not.toContain("/api/events/event-a");
  }, 15_000);

  it("falls back to cached events and shows an offline notice when the network fails", async () => {
    const { encryptionKey } = await deriveAuthAndEncryptionKeys("pw");
    const session = { userId: "offline-user", username: "ada", token: "t", encryptionKey };
    saveEventCache(session.userId, [
      {
        id: "cached-1",
        title: "Cached meeting",
        startTime: "2026-08-01T09:00:00.000Z",
        endTime: "2026-08-01T09:15:00.000Z",
        priority: 0,
      },
    ]);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    render(<Calendar session={session} onLogout={() => {}} />);

    await waitFor(() => expect(screen.getByText("Cached meeting")).toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent(/offline/i);
  }, 15_000);

  it("clicking the repeat toggle again hides the panel and reverts the button label", async () => {
    const { encryptionKey } = await deriveAuthAndEncryptionKeys("pw");
    const session = { userId: "u1", username: "ada", token: "t", encryptionKey };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ events: [] }) })
    );

    const user = userEvent.setup();
    render(<Calendar session={session} onLogout={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no events yet/i)).toBeInTheDocument());

    const toggle = screen.getByRole("button", { name: /^repeat/i });
    await user.click(toggle);
    expect(screen.getByRole("button", { name: /^repeating/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/repeat interval/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^repeating/i }));
    expect(screen.getByRole("button", { name: /^repeat\s/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/repeat interval/i)).not.toBeInTheDocument();
  }, 15_000);

  it("regression: an event whose start time has already passed by the time the list renders still shows up", async () => {
    // This reproduces the reported bug: the display window used to start
    // at exactly "new Date()" at render time, so an event created for a
    // moment that had already ticked past "now" (e.g. picked a couple of
    // minutes before hitting submit) was silently excluded.
    const { encryptionKey } = await deriveAuthAndEncryptionKeys("pw");
    const session = { userId: "u1", username: "ada", token: "t", encryptionKey };
    const justPassed = new Date(Date.now() - 5 * 60_000); // 5 minutes ago
    const content = {
      title: "Just missed it",
      startTime: justPassed.toISOString(),
      endTime: new Date(justPassed.getTime() + 30 * 60_000).toISOString(),
      priority: 0,
    };
    const envelope = encryptEnvelope(content, encryptionKey, "user-key-1");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ events: [{ id: "event-1", envelope }] }),
      })
    );

    render(<Calendar session={session} onLogout={() => {}} />);
    await waitFor(() => expect(screen.getByText("Just missed it")).toBeInTheDocument());
  }, 15_000);
});
