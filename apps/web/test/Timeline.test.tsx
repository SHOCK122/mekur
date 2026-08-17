import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Timeline } from "../src/components/Timeline.js";
import type { DecryptedEvent } from "../src/lib/events.js";

function makeEvent(overrides: Partial<DecryptedEvent> = {}): DecryptedEvent {
  const start = new Date(Date.now() + 60 * 60 * 1000);
  return {
    id: "e1",
    title: "Standup",
    startTime: start.toISOString(),
    endTime: new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
    priority: 0,
    canEdit: true,
    ...overrides,
  } as DecryptedEvent;
}

describe("Timeline", () => {
  it("renders an event inside the current view", () => {
    render(<Timeline events={[makeEvent()]} onEditEvent={() => {}} />);
    expect(screen.getByTestId("event-modal-e1")).toBeInTheDocument();
    expect(screen.getByText("Standup")).toBeInTheDocument();
  });

  it("defaults to a one-day scale", () => {
    render(<Timeline events={[]} onEditEvent={() => {}} />);
    expect(screen.getByText("1 day")).toBeInTheDocument();
  });

  it("zooms to human-significant scales rather than arbitrary spans", async () => {
    const user = userEvent.setup();
    render(<Timeline events={[]} onEditEvent={() => {}} />);
    // Zooming out doubles the span to 2 days, whose nearest
    // human-significant scale is 3 days -- not an arbitrary "2 days".
    await user.click(screen.getByRole("button", { name: /zoom out/i }));
    expect(screen.getByText("3 days")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /zoom in/i }));
    expect(screen.getByText("1 day")).toBeInTheDocument();
  });

  it("clicking the event name opens editing", async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    render(<Timeline events={[makeEvent()]} onEditEvent={onEdit} />);
    await user.click(screen.getByText("Standup"));
    expect(onEdit).toHaveBeenCalled();
    expect(onEdit.mock.calls[0]![0]).toBe("e1");
  });

  it("gives an untitled event a clickable square instead of an unhittable label", async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    render(<Timeline events={[makeEvent({ title: "" })]} onEditEvent={onEdit} />);
    // The resize handles also mention "untitled event", so target the
    // square specifically rather than by loose text match.
    const square = screen.getByLabelText("Untitled event");
    expect(square).toBeInTheDocument();
    await user.click(square);
    expect(onEdit).toHaveBeenCalled();
    expect(onEdit.mock.calls[0]![0]).toBe("e1");
  });

  it("marks an important event with more than colour alone", () => {
    render(<Timeline events={[makeEvent({ important: true })]} onEditEvent={() => {}} />);
    const modal = screen.getByTestId("event-modal-e1");
    // WCAG 1.4.1: colour cannot be the only signal. There must be text for
    // screen readers and a non-colour visual marker.
    expect(within(modal).getByText(/important:/i)).toBeInTheDocument();
    expect(modal.className).toContain("event-modal-important");
  });

  it("keeps the label out of the fading background so it stays readable", () => {
    render(<Timeline events={[makeEvent()]} onEditEvent={() => {}} />);
    const modal = screen.getByTestId("event-modal-e1");
    // The gradient lives on a separate, aria-hidden fill element; the
    // label is a sibling at full opacity rather than inside it.
    const fill = modal.querySelector(".event-modal-fill");
    expect(fill).toBeTruthy();
    expect(fill!.getAttribute("aria-hidden")).toBe("true");
    expect(fill!.contains(screen.getByText("Standup"))).toBe(false);
  });

  it("offers all four layouts and keeps the base perpendicular to time", async () => {
    const user = userEvent.setup();
    render(<Timeline events={[makeEvent()]} onEditEvent={() => {}} />);
    // Layout controls are behind a disclosure to keep the toolbar quiet.
    await user.click(screen.getByRole("button", { name: /layout options/i }));

    const layout = screen.getByLabelText(/^layout$/i);
    const base = screen.getByLabelText(/^base$/i);
    // Horizontal offers bottom/top only.
    expect(within(base).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "bottom",
      "top",
    ]);

    await user.selectOptions(layout, "vertical:forward");
    // Switching axis must switch the valid bases too, or events would
    // stack along the time axis itself.
    expect(within(screen.getByLabelText(/^base$/i)).getAllByRole("option").map((o) => o.textContent))
      .toEqual(["left", "right"]);
  });

  it("stacks overlapping events into separate lanes", () => {
    const start = new Date(Date.now() + 60 * 60 * 1000);
    const overlapping = [
      makeEvent({ id: "a", title: "A", rank: "A", startTime: start.toISOString() }),
      makeEvent({ id: "b", title: "B", rank: "B", startTime: start.toISOString() }),
      makeEvent({ id: "c", title: "C", rank: "C", startTime: start.toISOString() }),
    ];
    render(<Timeline events={overlapping} onEditEvent={() => {}} />);
    const lanes = ["a", "b", "c"].map((id) =>
      screen.getByTestId(`event-modal-${id}`).getAttribute("data-lane")
    );
    expect(new Set(lanes).size).toBe(3);
  });

  it("puts the higher-ranked event further from the base", () => {
    const start = new Date(Date.now() + 60 * 60 * 1000);
    render(
      <Timeline
        events={[
          makeEvent({ id: "low", title: "Low", rank: "A", startTime: start.toISOString() }),
          makeEvent({ id: "high", title: "High", rank: "Z", startTime: start.toISOString() }),
        ]}
        onEditEvent={() => {}}
      />
    );
    const lowLane = Number(screen.getByTestId("event-modal-low").getAttribute("data-lane"));
    const highLane = Number(screen.getByTestId("event-modal-high").getAttribute("data-lane"));
    expect(highLane).toBeGreaterThan(lowLane);
  });

  it("renders an open-ended event with a future-fading treatment", () => {
    render(<Timeline events={[makeEvent({ endTime: undefined })]} onEditEvent={() => {}} />);
    const modal = screen.getByTestId("event-modal-e1");
    expect(modal.className).toContain("event-modal-open-ended");
    expect(modal.querySelector(".fade-open-ended")).toBeTruthy();
  });

  it("announces when events are stacked beyond the visible edge", () => {
    // A bare scrollbar is easy to miss and unreliable on touch, so the
    // overflow is stated in text as well.
    const start = new Date(Date.now() + 60 * 60 * 1000);
    const many = Array.from({ length: 40 }, (_, i) =>
      makeEvent({
        id: `e${i}`,
        title: `Event ${i}`,
        rank: `r${String(i).padStart(3, "0")}`,
        startTime: start.toISOString(),
      })
    );
    render(<Timeline events={many} onEditEvent={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent(/more events stacked beyond the edge/i);
  });

  it("lets a long name extend beyond a short event rather than truncating it", () => {
    const start = new Date(Date.now() + 60 * 60 * 1000);
    render(
      <Timeline
        events={[
          makeEvent({
            title: "A considerably longer event name than the block is wide",
            startTime: start.toISOString(),
            // Two minutes: far narrower than the label.
            endTime: new Date(start.getTime() + 2 * 60 * 1000).toISOString(),
          }),
        ]}
        onEditEvent={() => {}}
      />
    );
    // The full name is rendered rather than truncated in markup; the
    // overflow behaviour itself is CSS, which jsdom does not evaluate.
    expect(screen.getByText(/considerably longer event name than the block is wide/i)).toBeInTheDocument();
  });

  it("keeps a minimum em-square hit area on a very narrow event", () => {
    const start = new Date(Date.now() + 60 * 60 * 1000);
    render(
      <Timeline
        events={[
          makeEvent({
            title: "X",
            startTime: start.toISOString(),
            endTime: new Date(start.getTime() + 1000).toISOString(),
          }),
        ]}
        onEditEvent={() => {}}
      />
    );
    // A one-second event is a sliver, but the label is a real button
    // rendered outside the clipped fill, so it stays hittable. The
    // em-square minimum is enforced in CSS, which jsdom does not evaluate
    // -- asserting on computed style here would test nothing.
    const label = screen.getByText("X").closest("button")!;
    expect(label).toBeInTheDocument();
    expect(label.className).toContain("event-modal-label");
    const fill = screen.getByTestId("event-modal-e1").querySelector(".event-modal-fill")!;
    expect(fill.contains(label)).toBe(false);
  });

  it("keeps layout options behind a disclosure so the toolbar stays quiet", async () => {
    const user = userEvent.setup();
    render(<Timeline events={[]} onEditEvent={() => {}} />);
    expect(screen.queryByLabelText(/^layout$/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /layout options/i }));
    expect(screen.getByLabelText(/^layout$/i)).toBeInTheDocument();
  });

  it("keeps every repeat of a series in one row rather than stacking them", () => {
    const start = new Date(Date.now() + 60 * 60 * 1000);
    render(
      <Timeline
        events={[
          makeEvent({
            id: "daily",
            title: "Standup",
            startTime: start.toISOString(),
            endTime: new Date(start.getTime() + 15 * 60 * 1000).toISOString(),
            recurrence: { freq: "HOURLY", interval: 1 },
          }),
        ]}
        onEditEvent={() => {}}
      />
    );
    const series = screen.getByTestId("event-series-daily");
    // Many occurrences within a day view...
    expect(Number(series.getAttribute("data-occurrences"))).toBeGreaterThan(1);
    // ...all sharing a single lane, because a repeating event is one row.
    const lanes = new Set(
      Array.from(series.querySelectorAll(".event-modal")).map((el) => el.getAttribute("data-lane"))
    );
    expect(lanes.size).toBe(1);
  });

  it("shows a repeating event's name only once", () => {
    const start = new Date(Date.now() + 60 * 60 * 1000);
    render(
      <Timeline
        events={[
          makeEvent({
            id: "daily",
            title: "Standup",
            startTime: start.toISOString(),
            endTime: new Date(start.getTime() + 15 * 60 * 1000).toISOString(),
            recurrence: { freq: "HOURLY", interval: 1 },
          }),
        ]}
        onEditEvent={() => {}}
      />
    );
    // Repeating the label on every occurrence would be noise, and would
    // also collide with itself at tight zoom levels.
    expect(screen.getAllByText("Standup")).toHaveLength(1);
  });

  it("wraps a non-repeating event in its own single-occurrence series", () => {
    render(<Timeline events={[makeEvent()]} onEditEvent={() => {}} />);
    const series = screen.getByTestId("event-series-e1");
    expect(series.getAttribute("data-occurrences")).toBe("1");
  });

  it("does not let another event occupy the gaps between repeats", () => {
    const start = new Date(Date.now() + 60 * 60 * 1000);
    render(
      <Timeline
        events={[
          makeEvent({
            id: "daily",
            title: "Standup",
            rank: "A",
            startTime: start.toISOString(),
            endTime: new Date(start.getTime() + 15 * 60 * 1000).toISOString(),
            recurrence: { freq: "HOURLY", interval: 1 },
          }),
          makeEvent({
            id: "other",
            title: "Other",
            rank: "B",
            // Lands in a gap between two repeats.
            startTime: new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
            endTime: new Date(start.getTime() + 40 * 60 * 1000).toISOString(),
          }),
        ]}
        onEditEvent={() => {}}
      />
    );
    const seriesLane = screen.getByTestId("event-series-daily").getAttribute("data-lane");
    const otherLane = screen.getByTestId("event-series-other").getAttribute("data-lane");
    // The series holds its row across the whole span it covers.
    expect(otherLane).not.toBe(seriesLane);
  });

  it("zooms continuously on the wheel: up zooms in, down zooms out", () => {
    render(<Timeline events={[]} onEditEvent={() => {}} />);
    const viewport = screen.getByLabelText("Timeline events");
    expect(screen.getByText("1 day")).toBeInTheDocument();

    // Scrolling down (positive deltaY) zooms out.
    fireEvent.wheel(viewport, { deltaY: 400 });
    expect(screen.queryByText("1 day")).not.toBeInTheDocument();

    // Scrolling up brings it back in.
    fireEvent.wheel(viewport, { deltaY: -400 });
    expect(screen.getByText("1 day")).toBeInTheDocument();
  });

  it("zooms by small amounts for small scrolls, so a trackpad feels smooth", () => {
    render(<Timeline events={[]} onEditEvent={() => {}} />);
    const viewport = screen.getByLabelText("Timeline events");
    // A tiny scroll should not jump a whole scale step.
    fireEvent.wheel(viewport, { deltaY: 5 });
    expect(screen.getByText("1 day")).toBeInTheDocument();
  });
});
