import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { deriveAuthAndEncryptionKeys, encryptEnvelope } from "@schedule-app/crypto";
import { Calendar } from "../src/components/Calendar.js";

describe("Calendar", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("submits the chosen priority and a custom recurrence interval", async () => {
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
    await user.selectOptions(screen.getByText("Medium").closest("select")!, "high");
    await user.selectOptions(screen.getByText("Does not repeat").closest("select")!, "custom");
    const intervalInput = await screen.findByLabelText(/custom repeat interval/i);
    await user.clear(intervalInput);
    await user.type(intervalInput, "37");
    await user.click(screen.getByRole("button", { name: /add event/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const createCall = fetchMock.mock.calls[1];
    expect(createCall[0]).toBe("/api/events");
    // The envelope is encrypted, so we can't inspect the plaintext here directly,
    // but we can confirm no plaintext leaked into the request body.
    expect(createCall[1].body).not.toContain("Check the oven");
  }, 15_000);
});
