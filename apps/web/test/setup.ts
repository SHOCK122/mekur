import "@testing-library/jest-dom/vitest";

// jsdom has no PointerEvent, so `fireEvent.pointerMove(el, { clientX })`
// dispatched a plain Event and the coordinates were silently dropped:
// handlers read `undefined`, and drag/pan tests computed with NaN. A
// MouseEvent carries the coordinates; that is all the handlers read.
if (typeof globalThis.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  globalThis.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}
