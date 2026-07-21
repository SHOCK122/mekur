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
});
