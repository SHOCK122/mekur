import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EventEditPanel } from "../src/components/EventEditPanel.js";
import type { DecryptedEvent } from "../src/lib/events.js";

function makeEvent(overrides: Partial<DecryptedEvent> = {}): DecryptedEvent {
  return {
    id: "e1",
    title: "Standup",
    startTime: "2026-08-01T09:00:00.000Z",
    endTime: "2026-08-01T09:30:00.000Z",
    canEdit: true,
    ...overrides,
  } as DecryptedEvent;
}

function handlers() {
  return {
    onSave: vi.fn().mockResolvedValue(true),
    onDelete: vi.fn(),
    onLeave: vi.fn(),
    onShare: vi.fn(),
    onClose: vi.fn(),
  };
}

describe("EventEditPanel", () => {
  it("opens as a labelled dialog with the event's current values", async () => {
    render(
      <EventEditPanel {...handlers()} event={makeEvent()} onSave={vi.fn().mockResolvedValue(true)} onDelete={vi.fn()} onClose={vi.fn()} />
    );
    const dialog = screen.getByRole("dialog", { name: /edit standup/i });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText(/title/i)).toHaveValue("Standup");
  });

  it("saves edited values", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(
      <EventEditPanel {...handlers()} event={makeEvent()} onSave={onSave} onDelete={vi.fn()} onClose={vi.fn()} />
    );

    const title = screen.getByLabelText(/title/i);
    await user.clear(title);
    await user.type(title, "Renamed");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0].title).toBe("Renamed");
  }, 15_000);

  it("lets an end time be cleared, making the event open-ended", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(
      <EventEditPanel {...handlers()} event={makeEvent()} onSave={onSave} onDelete={vi.fn()} onClose={vi.fn()} />
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
      <EventEditPanel {...handlers()} event={makeEvent()} onSave={onSave} onDelete={vi.fn()} onClose={vi.fn()} />
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
      <EventEditPanel {...handlers()} event={makeEvent()} onSave={onSave} onDelete={vi.fn()} onClose={vi.fn()} />
    );
    await user.clear(screen.getByLabelText(/title/i));
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  }, 15_000);

  it("toggles importance", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(
      <EventEditPanel {...handlers()} event={makeEvent()} onSave={onSave} onDelete={vi.fn()} onClose={vi.fn()} />
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
      <EventEditPanel {...handlers()} event={makeEvent()} onSave={vi.fn().mockResolvedValue(true)} onDelete={vi.fn()} onClose={onClose} />
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
        {...handlers()}
      />
    );
    // The transform origin points at the event's centre, so the growth
    // visibly indicates which modal is being expanded.
    const dialog = screen.getByRole("dialog");
    expect(dialog.style.getPropertyValue("--origin-x")).toBe("120px");
    expect(dialog.style.getPropertyValue("--origin-y")).toBe("60px");
  });

  it("edits the repeat rule, including an end date", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<EventEditPanel {...handlers()} event={makeEvent()} onSave={onSave} />);

    await user.click(screen.getByRole("button", { name: /repeat/i }));
    await user.clear(screen.getByLabelText(/repeat interval/i));
    await user.type(screen.getByLabelText(/repeat interval/i), "2");
    await user.selectOptions(screen.getByLabelText(/repeat unit/i), "WEEKLY");
    // Set the value in one go, as a date picker does: typing into a date
    // input character by character is timing-sensitive in jsdom, which
    // sanitises each partial date to "".
    fireEvent.change(screen.getByLabelText(/repeat until/i), { target: { value: "2026-12-31" } });
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const { recurrence } = onSave.mock.calls[0]![0];
    expect(recurrence.freq).toBe("WEEKLY");
    expect(recurrence.interval).toBe(2);
    expect(new Date(recurrence.until).getFullYear()).toBe(2026);
  });

  it("keeps weekdays it doesn't expose when the interval changes", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    const event = makeEvent({ recurrence: { freq: "WEEKLY", interval: 1, byDay: ["MO", "WE"] } });
    render(<EventEditPanel {...handlers()} event={event} onSave={onSave} />);
    await user.clear(screen.getByLabelText(/repeat interval/i));
    await user.type(screen.getByLabelText(/repeat interval/i), "3");
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0].recurrence).toEqual({ freq: "WEEKLY", interval: 3, byDay: ["MO", "WE"] });
  });

  it("lists skipped occurrences and restores one", async () => {
    // Restoring used to live only in the (since removed) list view.
    const onSave = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    const skipped = ["2026-08-02T09:00:00.000Z", "2026-08-03T09:00:00.000Z"];
    const event = makeEvent({ recurrence: { freq: "DAILY", interval: 1 }, skippedOccurrences: skipped });
    render(<EventEditPanel {...handlers()} event={event} onSave={onSave} />);

    const restoreButtons = screen.getAllByRole("button", { name: /^restore/i });
    expect(restoreButtons).toHaveLength(2);
    await user.click(restoreButtons[0]!);
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0]).toEqual({ skippedOccurrences: [skipped[1]] });
  });

  it("offers sharing for an editable event", async () => {
    const h = handlers();
    const user = userEvent.setup();
    render(<EventEditPanel {...h} event={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /^share$/i }));
    expect(h.onShare).toHaveBeenCalled();
  });

  it("is read-only for a view-only event, offering removal instead of delete", async () => {
    const h = handlers();
    const user = userEvent.setup();
    render(<EventEditPanel {...h} event={makeEvent({ canEdit: false })} />);

    expect(screen.getByRole("dialog", { name: /view standup/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/title/i)).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^save$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^delete$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^share$/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /remove from my schedule/i }));
    expect(h.onLeave).toHaveBeenCalled();
  });

  it("shows a save failure reported by the owner", () => {
    render(<EventEditPanel {...handlers()} event={makeEvent()} saveError="Network down" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Network down");
  });
});
