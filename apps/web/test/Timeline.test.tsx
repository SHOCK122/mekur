import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent, waitFor, act } from "@testing-library/react";
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

  it("pans through time when the background is dragged", () => {
    const start = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    render(
      <Timeline
        events={[
          makeEvent({
            title: "Ten days out",
            startTime: start.toISOString(),
            endTime: new Date(start.getTime() + 60 * 60 * 1000).toISOString(),
          }),
        ]}
        onEditEvent={() => {}}
      />
    );
    // Ten days ahead is outside the default one-day view.
    expect(screen.queryByText("Ten days out")).not.toBeInTheDocument();

    const viewport = screen.getByLabelText("Timeline events");
    const canvas = viewport.querySelector(".timeline-canvas")!;
    // Drag leftwards to travel forward in time, the way dragging a map
    // moves the surface rather than the viewpoint.
    fireEvent.pointerDown(canvas, { clientX: 500, clientY: 100 });
    for (let i = 0; i < 12; i++) {
      fireEvent.pointerMove(viewport, { clientX: 500 - (i + 1) * 800, clientY: 100 });
    }
    fireEvent.pointerUp(viewport);

    expect(screen.getByText("Ten days out")).toBeInTheDocument();
  });

  it("renders a live present indicator", () => {
    render(<Timeline events={[]} onEditEvent={() => {}} />);
    expect(screen.getByTestId("present-indicator")).toBeInTheDocument();
  });
  describe("keyboard alternatives to dragging", () => {
    const MINUTE = 60_000;
    // A day view steps by 15 minutes per press.
    const STEP = 15 * MINUTE;

    function label(name: string) {
      return screen.getByRole("button", { name: new RegExp(name) });
    }

    it("moves a focused event with the arrow keys, saving the presses as one write", async () => {
      const event = makeEvent();
      const onChange = vi.fn();
      render(<Timeline events={[event]} onEditEvent={() => {}} onChangeEvent={onChange} />);
      const button = label("Standup");
      button.focus();
      fireEvent.keyDown(button, { key: "ArrowRight" });
      fireEvent.keyDown(button, { key: "ArrowRight" });
      fireEvent.keyDown(button, { key: "ArrowLeft" });
      fireEvent.keyDown(button, { key: "ArrowRight" });

      await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
      const [id, changes] = onChange.mock.calls[0]!;
      expect(id).toBe("e1");
      expect(new Date(changes.startTime).getTime()).toBe(
        new Date(event.startTime).getTime() + 2 * STEP
      );
      expect(new Date(changes.endTime).getTime()).toBe(
        new Date(event.endTime!).getTime() + 2 * STEP
      );
    });

    it("pans to keep a keyboard-moved event on screen instead of dropping focus", async () => {
      // Starts an hour from now on a day view centred on now, so 60 presses
      // (15 hours) would carry it well past the view's end at +12h.
      const event = makeEvent();
      const onChange = vi.fn();
      render(<Timeline events={[event]} onEditEvent={() => {}} onChangeEvent={onChange} />);
      const button = label("Standup");
      button.focus();
      for (let i = 0; i < 60; i++) fireEvent.keyDown(button, { key: "ArrowRight" });

      expect(screen.getByTestId("event-modal-e1")).toBeInTheDocument();
      expect(label("Standup")).toHaveFocus();
      // The same element: it was never unmounted along the way.
      expect(label("Standup")).toBe(button);

      // Further presses still work, and the edits are one write.
      fireEvent.keyDown(button, { key: "ArrowRight" });
      await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
      expect(new Date(onChange.mock.calls[0]![1].startTime).getTime()).toBe(
        new Date(event.startTime).getTime() + 61 * STEP
      );
    });

    it("follows a keyboard-moved event back into the past as well", () => {
      const event = makeEvent();
      render(<Timeline events={[event]} onEditEvent={() => {}} onChangeEvent={vi.fn()} />);
      const button = label("Standup");
      button.focus();
      // 80 presses earlier is 20 hours: the event ends ~19h ago, beyond -12h.
      for (let i = 0; i < 80; i++) fireEvent.keyDown(button, { key: "ArrowLeft" });
      expect(label("Standup")).toBe(button);
      expect(button).toHaveFocus();
    });

    it("keeps an event's end in view while Shift+arrow extends it", () => {
      const event = makeEvent();
      render(<Timeline events={[event]} onEditEvent={() => {}} onChangeEvent={vi.fn()} />);
      const button = label("Standup");
      button.focus();
      const modal = screen.getByTestId("event-modal-e1");
      for (let i = 0; i < 60; i++) fireEvent.keyDown(button, { key: "ArrowRight", shiftKey: true });
      // The event's right edge stays inside the 800px-wide viewport.
      const left = parseFloat(modal.style.left);
      const width = parseFloat(modal.style.width);
      expect(left + width).toBeLessThan(800);
      expect(button).toHaveFocus();
    });

    it("moves the end with Shift and the start with Alt+Shift", async () => {
      const event = makeEvent();
      const onChange = vi.fn();
      render(<Timeline events={[event]} onEditEvent={() => {}} onChangeEvent={onChange} />);
      const button = label("Standup");
      button.focus();
      fireEvent.keyDown(button, { key: "ArrowRight", shiftKey: true });
      fireEvent.keyDown(button, { key: "ArrowLeft", shiftKey: true, altKey: true });

      await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
      const changes = onChange.mock.calls[0]![1];
      expect(new Date(changes.startTime).getTime()).toBe(new Date(event.startTime).getTime() - STEP);
      expect(new Date(changes.endTime).getTime()).toBe(new Date(event.endTime!).getTime() + STEP);
    });

    it("saves straight away when focus leaves the event", async () => {
      const onChange = vi.fn();
      render(<Timeline events={[makeEvent()]} onEditEvent={() => {}} onChangeEvent={onChange} />);
      const button = label("Standup");
      button.focus();
      fireEvent.keyDown(button, { key: "ArrowRight" });
      fireEvent.blur(button);
      // Long before the 500ms quiet period would have elapsed.
      await act(async () => {});
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    /** A save the test resolves by hand, to hold it "in flight". */
    function deferredSaves() {
      const resolvers: Array<(ok: boolean) => void> = [];
      const onChange = vi.fn(
        () => new Promise<boolean>((resolve) => resolvers.push(resolve))
      );
      return { onChange, resolvers };
    }

    function overlapping() {
      const start = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      return [
        makeEvent({ id: "low", title: "Low", rank: "A", startTime: start }),
        makeEvent({ id: "high", title: "High", rank: "Z", startTime: start }),
      ];
    }

    it("starts a different event from its own times while another's save is in flight", async () => {
      // Regression: the in-flight change to one event was reused as the
      // starting point for the next event pressed, and sent again.
      const [low, high] = overlapping();
      const { onChange } = deferredSaves();
      render(<Timeline events={[low!, high!]} onEditEvent={() => {}} onChangeEvent={onChange} />);
      fireEvent.keyDown(label("Low"), { key: "ArrowRight" });
      fireEvent.blur(label("Low"));
      fireEvent.keyDown(label("High"), { key: "ArrowRight" });
      fireEvent.blur(label("High"));
      await act(async () => {});

      // Low's save is still pending, so High's is queued behind it.
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange.mock.calls[0]![0]).toBe("low");
    });

    it("saves one change at a time, carrying an in-flight rank into the next save", async () => {
      const [low, high] = overlapping();
      const { onChange, resolvers } = deferredSaves();
      render(<Timeline events={[low!, high!]} onEditEvent={() => {}} onChangeEvent={onChange} />);
      fireEvent.keyDown(label("Low"), { key: "ArrowUp" });
      fireEvent.blur(label("Low"));
      fireEvent.keyDown(label("Low"), { key: "ArrowRight" });
      fireEvent.blur(label("Low"));
      await act(async () => {});
      expect(onChange).toHaveBeenCalledTimes(1);
      const rank = (onChange.mock.calls[0] as unknown[])[1] as { rank: string };

      await act(async () => resolvers[0]!(true));
      expect(onChange).toHaveBeenCalledTimes(2);
      const second = (onChange.mock.calls[1] as unknown[])[1] as { rank: string; startTime: string };
      expect(second.rank).toBe(rank.rank);
      expect(new Date(second.startTime).getTime()).toBe(new Date(low!.startTime).getTime() + STEP);
    });

    it("keeps keyboard focus on an event after raising it", () => {
      // Regression: the series were rendered in rank order, so raising one
      // moved its DOM node and the browser dropped focus.
      render(<Timeline events={overlapping()} onEditEvent={() => {}} onChangeEvent={() => {}} />);
      const button = label("Low");
      button.focus();
      fireEvent.keyDown(button, { key: "ArrowUp" });
      expect(document.activeElement).toBe(label("Low"));
      const series = screen.getByTestId("event-series-low");
      expect(series.compareDocumentPosition(screen.getByTestId("event-series-high"))).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );
    });

    it("announces when a keyboard change couldn't be saved", async () => {
      const onChange = vi.fn(async () => false);
      render(<Timeline events={[makeEvent()]} onEditEvent={() => {}} onChangeEvent={onChange} />);
      fireEvent.keyDown(label("Standup"), { key: "ArrowRight" });
      fireEvent.blur(label("Standup"));
      await waitFor(() =>
        expect(screen.getByTestId("timeline-announcer").textContent).toMatch(/Couldn't save/)
      );
    });

    it("opens the editor only once a pending keyboard change has been saved", async () => {
      const { onChange, resolvers } = deferredSaves();
      const onEdit = vi.fn();
      render(<Timeline events={[makeEvent()]} onEditEvent={onEdit} onChangeEvent={onChange} />);
      fireEvent.keyDown(label("Standup"), { key: "ArrowRight" });
      fireEvent.click(label("Standup"));
      await act(async () => {});
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onEdit).not.toHaveBeenCalled();

      await act(async () => resolvers[0]!(true));
      expect(onEdit).toHaveBeenCalledTimes(1);
    });

    it("raises priority past an overlapping event, away from the base", async () => {
      const start = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const onChange = vi.fn();
      render(
        <Timeline
          events={[
            makeEvent({ id: "low", title: "Low", rank: "A", startTime: start }),
            makeEvent({ id: "high", title: "High", rank: "Z", startTime: start }),
          ]}
          onEditEvent={() => {}}
          onChangeEvent={onChange}
        />
      );
      const button = label("Low");
      button.focus();
      // Base is at the bottom by default, so Up is away from it.
      fireEvent.keyDown(button, { key: "ArrowUp" });

      // Shown immediately, before the save.
      const lowLane = Number(screen.getByTestId("event-modal-low").getAttribute("data-lane"));
      const highLane = Number(screen.getByTestId("event-modal-high").getAttribute("data-lane"));
      expect(lowLane).toBeGreaterThan(highLane);

      await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
      expect(onChange.mock.calls[0]![0]).toBe("low");
      expect(onChange.mock.calls[0]![1].rank > "Z").toBe(true);
    });

    it("announces each change in a live region", () => {
      const start = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      render(
        <Timeline
          events={[
            makeEvent({ id: "low", title: "Low", rank: "A", startTime: start }),
            makeEvent({ id: "high", title: "High", rank: "Z", startTime: start }),
          ]}
          onEditEvent={() => {}}
          onChangeEvent={() => {}}
        />
      );
      const announcer = screen.getByTestId("timeline-announcer");
      expect(announcer.getAttribute("aria-live")).toBe("polite");

      const button = label("Low");
      button.focus();
      fireEvent.keyDown(button, { key: "ArrowRight" });
      expect(announcer.textContent).toMatch(/Low moved/);
      fireEvent.keyDown(button, { key: "ArrowRight", shiftKey: true });
      expect(announcer.textContent).toMatch(/Low ends/);
      fireEvent.keyDown(button, { key: "ArrowUp" });
      expect(announcer.textContent).toMatch(/Low raised above High/);
      fireEvent.keyDown(button, { key: "ArrowUp" });
      // Nothing left to pass: say so rather than staying silent.
      expect(announcer.textContent).toMatch(/already/i);
    });

    it("describes the keys on every editable event", () => {
      render(<Timeline events={[makeEvent()]} onEditEvent={() => {}} onChangeEvent={() => {}} />);
      expect(label("Standup")).toHaveAccessibleDescription(/arrow/i);
    });

    it("leaves arrow keys alone on a view-only event", () => {
      const onChange = vi.fn();
      render(
        <Timeline
          events={[makeEvent({ canEdit: false })]}
          onEditEvent={() => {}}
          onChangeEvent={onChange}
        />
      );
      const button = label("Standup");
      expect(button).not.toHaveAccessibleDescription(/arrow/i);
      button.focus();
      // fireEvent returns false when the default was prevented.
      expect(fireEvent.keyDown(button, { key: "ArrowRight" })).toBe(true);
      fireEvent.blur(button);
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});
