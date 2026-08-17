import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EventEditPanel } from "../src/components/EventEditPanel.js";
import type { DecryptedEvent } from "../src/lib/events.js";

function makeEvent(overrides: Partial<DecryptedEvent> = {}): DecryptedEvent {
  return {
    id: "e1",
    title: "Standup",
    startTime: "2026-08-01T09:00:00.000Z",
    endTime: "2026-08-01T09:30:00.000Z",
    priority: 0,
    canEdit: true,
    ...overrides,
  } as DecryptedEvent;
}

describe("EventEditPanel", () => {
  it("opens as a labelled dialog with the event's current values", async () => {
    render(
      <EventEditPanel event={makeEvent()} onSave={vi.fn()} onDelete={vi.fn()} onClose={vi.fn()} />
    );
    const dialog = screen.getByRole("dialog", { name: /edit standup/i });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText(/title/i)).toHaveValue("Standup");
  });

  it("saves edited values", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <EventEditPanel event={makeEvent()} onSave={onSave} onDelete={vi.fn()} onClose={vi.fn()} />
    );

    const title = screen.getByLabelText(/title/i);
    await user.clear(title);
    await user.type(title, "Renamed");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0].title).toBe("Renamed");
  }, 15_000);

  it("lets an end time be cleared, making the event open-ended", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <EventEditPanel event={makeEvent()} onSave={onSave} onDelete={vi.fn()} onClose={vi.fn()} />
    );

    await user.clear(screen.getByLabelText(/ends/i));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    // Clearing is a legitimate way to make an event open-ended, not an error.
    expect(onSave.mock.calls[0]![0].endTime).toBeUndefined();
  }, 15_000);

  it("refuses an end before the start rather than saving it", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <EventEditPanel event={makeEvent()} onSave={onSave} onDelete={vi.fn()} onClose={vi.fn()} />
    );

    await user.clear(screen.getByLabelText(/ends/i));
    await user.type(screen.getByLabelText(/ends/i), "2026-08-01T08:00");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/must be after/i);
    expect(onSave).not.toHaveBeenCalled();
  }, 15_000);

  it("requires a title", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <EventEditPanel event={makeEvent()} onSave={onSave} onDelete={vi.fn()} onClose={vi.fn()} />
    );
    await user.clear(screen.getByLabelText(/title/i));
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  }, 15_000);

  it("toggles importance", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <EventEditPanel event={makeEvent()} onSave={onSave} onDelete={vi.fn()} onClose={vi.fn()} />
    );
    await user.click(screen.getByLabelText(/mark as important/i));
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0].important).toBe(true);
  }, 15_000);

  it("closes on Escape, so it is dismissible from the keyboard", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <EventEditPanel event={makeEvent()} onSave={vi.fn()} onDelete={vi.fn()} onClose={onClose} />
    );
    await user.keyboard("{Escape}");
    // Closing waits for the collapse animation before unmounting.
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 2000 });
  }, 15_000);

  it("animates outward from the event that was clicked", () => {
    render(
      <EventEditPanel
        event={makeEvent()}
        origin={{ left: 100, top: 50, width: 40, height: 20 }}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />
    );
    // The transform origin points at the event's centre, so the growth
    // visibly indicates which modal is being expanded.
    const dialog = screen.getByRole("dialog");
    expect(dialog.style.getPropertyValue("--origin-x")).toBe("120px");
    expect(dialog.style.getPropertyValue("--origin-y")).toBe("60px");
  });
});
