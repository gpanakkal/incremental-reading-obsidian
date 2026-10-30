import { makeWindow } from '#/test/fake-window';
import type { EditorView } from '@codemirror/view';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOLD_MS, holdLine } from './scroll-hold';

// #region HELPERS
type MeasureRequest = {
  read: (view: EditorView) => unknown;
  write: (measured: unknown, view: EditorView) => void;
};

/** What the user does to scroll, type, or move elsewhere. */
const USER_INPUT = [
  'wheel',
  'touchstart',
  'pointerdown',
  'mousedown',
  'keydown',
] as const;

/**
 * What `holdLine` reads of an `EditorView`: a document of lines `lengths`
 * long, each `heights` tall on screen (in CodeMirror's units, which are
 * `scaleY` times `scrollTop`'s), scrolled to `scrollTop`, in a window `win`
 * (none where `windowless`, as in a document not shown anywhere).
 *
 * Its measures run only when `measure` says, CodeMirror's own anchoring
 * moving the scroll by `shift` in them, as it does when lines change height.
 * `writes` counts the writes to `scrollTop`. As CodeMirror does, a measure of
 * a position past the end of the document throws.
 */
function makeView(
  lengths: number[],
  heights: number[],
  scrollTop: number,
  scaleY: number,
  windowless = false
) {
  const starts = lengths.map((_, i) =>
    lengths.slice(0, i).reduce((sum, length) => sum + length + 1, 0)
  );
  const lineOf = (pos: number) =>
    starts.reduce((line, start, i) => (start <= pos ? i : line), 0);
  const makeDoc = (length: number) => ({
    length,
    lineAt: (pos: number) => ({ from: starts[lineOf(pos)] }),
  });
  let top = scrollTop;
  const writes = { count: 0 };
  const win = makeWindow();
  const scrollDOM = Object.defineProperties(new EventTarget(), {
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        writes.count++;
        top = value;
      },
    },
    ownerDocument: { value: { defaultView: windowless ? null : win } },
  }) as EventTarget & { scrollTop: number };
  const addEventListener = vi.spyOn(win, 'addEventListener');
  const scrollListener = vi.spyOn(scrollDOM, 'addEventListener');
  let pending: MeasureRequest[] = [];
  const view = {
    state: {
      doc: makeDoc(lengths.reduce((sum, length) => sum + length + 1, -1)),
    },
    scrollDOM,
    scaleY,
    lineBlockAt: (pos: number) => {
      if (pos > view.state.doc.length) {
        throw new RangeError(`Invalid position ${pos}`);
      }
      return {
        top: heights.slice(0, lineOf(pos)).reduce((sum, h) => sum + h, 0),
      };
    },
    requestMeasure: (request: MeasureRequest) => {
      pending.push(request);
    },
  };
  return {
    view: view as unknown as EditorView,
    win,
    heights,
    writes,
    addEventListener,
    scrollListener,
    get pending() {
      return pending.length;
    },
    /** The top of `pos`'s line, in `scrollTop`'s units. */
    lineTop: (pos: number) => view.lineBlockAt(pos).top / scaleY,
    /** Give the view a new document `length` long, as another change does. */
    changeDoc: (length: number) => {
      view.state = { doc: makeDoc(length) };
    },
    /** Run the measures requested, and the microtasks they queue. */
    async measure(shift: number) {
      const run = pending;
      pending = [];
      top += shift;
      const asView = view as unknown as EditorView;
      for (const request of run) request.write(request.read(asView), asView);
      await Promise.resolve();
    },
  };
}

/** A document's lines, how tall each is, and a position in it. */
const layoutArb = fc
  .array(
    fc.record({
      length: fc.nat({ max: 200 }),
      height: fc.nat({ max: 3000 }),
    }),
    { minLength: 1, maxLength: 20 }
  )
  .chain((lines) => {
    const size = lines.reduce((sum, { length }) => sum + length + 1, -1);
    return fc.record({
      lengths: fc.constant(lines.map(({ length }) => length)),
      heights: fc.constant(lines.map(({ height }) => height)),
      pos: fc.nat({ max: size }),
      scrollTop: fc.nat({ max: 100_000 }),
      scaleY: fc.constantFrom(0.5, 1, 1.25, 2),
    });
  });

/** A measure: a line growing or shrinking, and CodeMirror's anchoring. */
const measureArb = fc.record({
  line: fc.nat(),
  growth: fc.integer({ min: -3000, max: 3000 }),
  shift: fc.integer({ min: -5000, max: 5000 }),
});

/** CodeMirror's anchoring moving the scroll by more than a pixel. */
const shiftArb = fc
  .integer({ min: -5000, max: 5000 })
  .filter((s) => Math.abs(s) > 1);

/** Start holding `pos`'s line in a view laid out as `layout` says. */
function startHold(
  {
    lengths,
    heights,
    pos,
    scrollTop,
    scaleY,
  }: {
    lengths: number[];
    heights: number[];
    pos: number;
    scrollTop: number;
    scaleY: number;
  },
  windowless = false
) {
  // Each case's own timer alone pending
  vi.clearAllTimers();
  const made = makeView(lengths, [...heights], scrollTop, scaleY, windowless);
  const offset = made.lineTop(pos) - scrollTop;
  holdLine(made.view, pos)();
  return Object.assign(made, { offset });
}

/** Whether every listener the hold added has been taken off again. */
const listenersRemoved = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.every(
    ([, , options]) =>
      (options as AddEventListenerOptions).signal?.aborted === true
  );
// #endregion

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('holdLine', () => {
  it("puts the line back where it was on screen after every measure, however the lines' heights change and the view is anchored", async () => {
    await fc.assert(
      fc.asyncProperty(
        layoutArb,
        fc.array(measureArb, { minLength: 1, maxLength: 10 }),
        async (layout, measures) => {
          const held = startHold(layout);
          for (const { line, growth, shift } of measures) {
            const at = line % held.heights.length;
            held.heights[at] = Math.max(held.heights[at] + growth, 0);
            await held.measure(shift);
            expect(
              Math.abs(
                held.view.scrollDOM.scrollTop -
                  (held.lineTop(layout.pos) - held.offset)
              )
            ).toBeLessThanOrEqual(1);
          }
        }
      )
    );
  });

  it('leaves the scroll alone where the line is within a pixel of its place', async () => {
    await fc.assert(
      fc.asyncProperty(
        layoutArb,
        fc.integer({ min: -1, max: 1 }),
        async (layout, shift) => {
          const held = startHold(layout);
          await held.measure(shift);
          expect(held.writes.count).toBe(0);
          expect(held.pending).toBe(1);
        }
      )
    );
  });

  it('lets go of the line once the user scrolls, types or clicks anywhere in the window, and stops listening and timing', async () => {
    await fc.assert(
      fc.asyncProperty(
        layoutArb,
        fc.array(measureArb, { maxLength: 5 }),
        fc.constantFrom(...USER_INPUT),
        shiftArb,
        async (layout, before, type, shift) => {
          const held = startHold(layout);
          for (const measure of before) await held.measure(measure.shift);
          held.win.dispatchEvent(new Event(type));
          const scrollTop = held.view.scrollDOM.scrollTop;

          await held.measure(shift);

          expect(held.view.scrollDOM.scrollTop).toBe(scrollTop + shift);
          expect(held.pending).toBe(0);
          expect(listenersRemoved(held.addEventListener)).toBe(true);
          expect(vi.getTimerCount()).toBe(0);
        }
      )
    );
  });

  it('hears user input before anything in the window can stop it, without blocking scrolling', () => {
    fc.assert(
      fc.property(layoutArb, (layout) => {
        const held = startHold(layout);
        const heard = held.addEventListener.mock.calls.map(([type]) => type);
        expect(heard).toEqual(expect.arrayContaining([...USER_INPUT]));
        for (const [, , options] of held.addEventListener.mock.calls) {
          expect(options).toMatchObject({ capture: true, passive: true });
        }
        expect(held.scrollListener).not.toHaveBeenCalled();
      })
    );
  });

  it("listens in the global window where the editor's document has none", async () => {
    await fc.assert(
      fc.asyncProperty(
        layoutArb,
        fc.constantFrom(...USER_INPUT),
        shiftArb,
        async (layout, type, shift) => {
          const global = makeWindow();
          vi.stubGlobal('window', global);
          const held = startHold(layout, true);
          global.dispatchEvent(new Event(type));
          const scrollTop = held.view.scrollDOM.scrollTop;

          await held.measure(shift);

          expect(held.view.scrollDOM.scrollTop).toBe(scrollTop + shift);
          expect(held.pending).toBe(0);
        }
      )
    );
  });

  it('lets go of the line once the document changes again, without measuring it in the new one', async () => {
    await fc.assert(
      fc.asyncProperty(
        layoutArb,
        fc.nat({ max: 4000 }),
        shiftArb,
        async (layout, length, shift) => {
          const held = startHold(layout);
          held.changeDoc(length);
          const scrollTop = held.view.scrollDOM.scrollTop;

          await held.measure(shift);

          expect(held.view.scrollDOM.scrollTop).toBe(scrollTop + shift);
          expect(held.pending).toBe(0);
          expect(listenersRemoved(held.addEventListener)).toBe(true);
          expect(vi.getTimerCount()).toBe(0);
        }
      )
    );
  });

  it('lets go of the line once the document changes between a measure and its scroll', async () => {
    await fc.assert(
      fc.asyncProperty(layoutArb, shiftArb, async (layout, shift) => {
        const held = startHold(layout);
        const measured = held.measure(shift);
        // The measure's own scroll is still to come, in a microtask
        held.changeDoc(held.view.state.doc.length);
        const scrollTop = held.view.scrollDOM.scrollTop;

        await measured;

        expect(held.view.scrollDOM.scrollTop).toBe(scrollTop);
        expect(held.pending).toBe(0);
        expect(listenersRemoved(held.addEventListener)).toBe(true);
      })
    );
  });

  it(`holds the line for ${HOLD_MS}ms after the change, and no longer`, async () => {
    await fc.assert(
      fc.asyncProperty(
        layoutArb,
        fc.oneof(
          fc.constantFrom(HOLD_MS - 1, HOLD_MS),
          fc.integer({ min: 0, max: 3 * HOLD_MS })
        ),
        shiftArb,
        async (layout, elapsed, shift) => {
          const held = startHold(layout);
          const scrollTop = held.view.scrollDOM.scrollTop;
          vi.advanceTimersByTime(elapsed);

          await held.measure(shift);

          expect(held.view.scrollDOM.scrollTop).toBe(
            elapsed < HOLD_MS ? scrollTop : scrollTop + shift
          );
          expect(held.pending).toBe(elapsed < HOLD_MS ? 1 : 0);
        }
      )
    );
  });

  it(`stops listening ${HOLD_MS}ms after the change though the view never measures again`, () => {
    fc.assert(
      fc.property(
        layoutArb,
        fc.integer({ min: 0, max: 3 * HOLD_MS }),
        (layout, elapsed) => {
          const held = startHold(layout);
          vi.advanceTimersByTime(elapsed);
          expect(listenersRemoved(held.addEventListener)).toBe(
            elapsed >= HOLD_MS
          );
        }
      )
    );
  });
});
