// @vitest-environment jsdom

import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_FADE_MS,
  CONTEXT_SCROLL_WAIT_MS,
  contextFlashEffect,
  contextFlashExtension,
  contextFlashField,
  flashRanges,
} from './ContextFlashExtension';

// #region HELPERS

/** Any offset a caller could hand over, past either end of the note too. */
const offsetArb = fc.integer({ min: -5, max: 50 });

/** One animation frame, as fake timers run them. */
const FRAME_MS = 16;

/**
 * Two frames: one to find the range on screen, one to find it still where it
 * was, the scroll done.
 */
const SETTLE_MS = FRAME_MS * 2;

/**
 * An editor on `doc` whose scroller shows rows 0–100px, with every position
 * drawn at 10–20px once `at.scrolled`, and at 500px, out of view, before, or
 * wherever `at.rect` says when set. jsdom lays nothing out, so where text is
 * drawn is stood in for.
 */
function makeView(doc: string, parent: HTMLElement = document.body) {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [contextFlashExtension] }),
    parent,
  });
  const at: {
    scrolled: boolean;
    rect?: (pos: number) => { top: number; bottom: number } | null;
  } = { scrolled: true };
  vi.spyOn(view.scrollDOM, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 100, 100)
  );
  vi.spyOn(view, 'coordsAtPos').mockImplementation((pos) => {
    const rect = at.rect
      ? at.rect(pos)
      : at.scrolled
        ? { top: 10, bottom: 20 }
        : { top: 500, bottom: 510 };
    return rect && { ...rect, left: 0, right: 0 };
  });
  return Object.assign(view, { at });
}

/** Where each flash mark is. */
function flashedRanges(view: EditorView) {
  const found: number[][] = [];
  view.state
    .field(contextFlashField)
    .marks.between(0, view.state.doc.length, (from, to) => {
      found.push([from, to]);
    });
  return found;
}

/** The text each flash mark covers, in order. */
function flashedText(view: EditorView) {
  return flashedRanges(view).map(([from, to]) =>
    view.state.doc.sliceString(from, to)
  );
}

/** Whether the marks are lit: the editor wears the class that lights them. */
const isLit = (view: EditorView) =>
  view.dom.classList.contains('ir-context-flashing');

/** The flash's phase, as the editor shows it. */
const phaseOf = (view: EditorView) =>
  flashedRanges(view).length === 0 ? 'none' : isLit(view) ? 'lit' : 'unlit';

/**
 * The plugin's stylesheet, read from the working directory: Vitest rewrites
 * module URLs under jsdom onto a scheme `readFileSync` rejects.
 */
const readStylesheet = () =>
  readFileSync(resolve(process.cwd(), 'styles.css'), 'utf8');

// #endregion

describe('contextFlashExtension', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('marks the range unlit, lights it once it is on screen, fades it out and then drops it', () => {
    const view = makeView('Some text with a passage in it');
    expect(phaseOf(view)).toBe('none');

    flashRanges(view, [{ from: 17, to: 24 }]);

    // Drawn unlit first, for the light to ease in on
    expect(flashedText(view)).toEqual(['passage']);
    expect(phaseOf(view)).toBe('unlit');
    expect(
      view.contentDOM.querySelector('.ir-context-flash')?.textContent
    ).toBe('passage');

    vi.advanceTimersByTime(SETTLE_MS);
    expect(phaseOf(view)).toBe('lit');
    vi.advanceTimersByTime(CONTEXT_FADE_MS - 1);
    expect(phaseOf(view)).toBe('lit');
    vi.advanceTimersByTime(1);
    // Unlit, the mark is still there for its colors to ease out on
    expect(phaseOf(view)).toBe('unlit');
    vi.advanceTimersByTime(CONTEXT_FADE_MS - 1);
    expect(phaseOf(view)).toBe('unlit');
    vi.advanceTimersByTime(1);
    expect(phaseOf(view)).toBe('none');
    expect(view.contentDOM.querySelector('.ir-context-flash')).toBeNull();

    view.destroy();
  });

  it('lights nothing until the range has been scrolled on screen, however long that takes within the wait', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: CONTEXT_SCROLL_WAIT_MS - SETTLE_MS * 2 }),
        (scrollsAfter) => {
          const view = makeView('Some passage here');
          view.at.scrolled = false;
          flashRanges(view, [{ from: 5, to: 12 }]);

          vi.advanceTimersByTime(scrollsAfter);
          expect(phaseOf(view)).toBe('unlit');
          view.at.scrolled = true;
          vi.advanceTimersByTime(SETTLE_MS);

          expect(phaseOf(view)).toBe('lit');
          vi.advanceTimersByTime(CONTEXT_FADE_MS * 2);
          expect(phaseOf(view)).toBe('none');
          view.destroy();
        }
      ),
      // Each run builds an editor
      { numRuns: 40 }
    );
  });

  it('lights nothing while the range is still moving on screen, and lights it once it stays put', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (movingFrames) => {
        const view = makeView('Some passage here');
        let top = 0;
        view.at.rect = () => ({ top, bottom: top + 10 });
        flashRanges(view, [{ from: 5, to: 12 }]);

        // Scrolling: on screen, but somewhere else each frame
        for (let i = 0; i < movingFrames; i++) {
          top += 3;
          vi.advanceTimersByTime(FRAME_MS);
          expect(phaseOf(view)).toBe('unlit');
        }
        vi.advanceTimersByTime(FRAME_MS);

        expect(phaseOf(view)).toBe('lit');
        view.destroy();
      }),
      // Each run builds an editor
      { numRuns: 40 }
    );
  });

  it('waits on the range handed over first, the one the editor scrolls to', () => {
    fc.assert(
      fc.property(fc.boolean(), (firstOnScreen) => {
        const view = makeView('first second third');
        // Handed over out of order: the first lies after the second
        const [first, second] = [
          { from: 13, to: 18 },
          { from: 0, to: 5 },
        ];
        view.at.rect = (pos) =>
          (pos >= first.from && pos <= first.to) === firstOnScreen
            ? { top: 10, bottom: 20 }
            : { top: 500, bottom: 510 };
        flashRanges(view, [first, second]);

        vi.advanceTimersByTime(SETTLE_MS);

        expect(phaseOf(view)).toBe(firstOnScreen ? 'lit' : 'unlit');
        view.destroy();
      })
    );
  });

  it('keeps the light where the editor has it through a redraw of the mark, and ends on time', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: CONTEXT_FADE_MS * 2 - SETTLE_MS }),
        (redrawnAfter) => {
          const view = makeView('Some passage here');
          flashRanges(view, [{ from: 5, to: 12 }]);
          vi.advanceTimersByTime(SETTLE_MS);
          const phase = () => phaseOf(view);
          expect(phase()).toBe('lit');

          vi.advanceTimersByTime(redrawnAfter);
          const before = phase();
          // Typing in the passage's line draws the line, mark and all, anew
          view.dispatch({ changes: { from: 0, insert: 'x' } });

          expect(phase()).toBe(before);
          expect(
            view.contentDOM.querySelectorAll('.ir-context-flash')
          ).toHaveLength(1);
          vi.advanceTimersByTime(CONTEXT_FADE_MS * 2 - redrawnAfter);
          expect(phase()).toBe('none');
          view.destroy();
        }
      ),
      // Each run builds an editor
      { numRuns: 40 }
    );
  });

  it('waits on nothing for ranges with no text in them', () => {
    const view = makeView('Some passage here');

    flashRanges(view, [{ from: 3, to: 3 }]);
    const coords = vi.spyOn(view, 'coordsAtPos');
    const dispatch = vi.spyOn(view, 'dispatch');
    vi.advanceTimersByTime(CONTEXT_SCROLL_WAIT_MS + FRAME_MS * 4);

    expect(coords).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(phaseOf(view)).toBe('none');
    view.destroy();
  });

  it('waits on the range where edits made meanwhile have moved it', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 10 }), (typed) => {
        const view = makeView('Some passage here');
        // On screen only at the passage's place in the note as it is
        let shift = 0;
        view.at.rect = (pos) =>
          pos === 5 + shift || pos === 12 + shift
            ? { top: 10, bottom: 20 }
            : { top: 500, bottom: 510 };
        flashRanges(view, [{ from: 5, to: 12 }]);

        view.dispatch({ changes: { from: 0, insert: typed } });
        shift = typed.length;
        vi.advanceTimersByTime(SETTLE_MS);

        expect(phaseOf(view)).toBe('lit');
        view.destroy();
      })
    );
  });

  it('drops a flash whose range never comes on screen, never lighting it', () => {
    const view = makeView('Some passage here');
    view.at.scrolled = false;
    flashRanges(view, [{ from: 5, to: 12 }]);

    for (let t = 0; t < CONTEXT_SCROLL_WAIT_MS + FRAME_MS; t += FRAME_MS) {
      vi.advanceTimersByTime(FRAME_MS);
      expect(isLit(view)).toBe(false);
    }

    expect(phaseOf(view)).toBe('none');
    view.destroy();
  });

  it('lights nothing for ranges with no text in them, and leaves nothing behind', () => {
    const view = makeView('Some passage here');

    flashRanges(view, [
      { from: 3, to: 3 },
      { from: 40, to: 50 },
    ]);
    for (let t = 0; t < CONTEXT_SCROLL_WAIT_MS + FRAME_MS; t += FRAME_MS) {
      vi.advanceTimersByTime(FRAME_MS);
      expect(isLit(view)).toBe(false);
    }

    expect(phaseOf(view)).toBe('none');
    view.destroy();
  });

  it('counts a range as on screen when either end is, and not when it only touches the edge', () => {
    const view = makeView('Some passage here');
    const coords = vi.spyOn(view, 'coordsAtPos');
    for (const [start, end, lit] of [
      [{ top: -20, bottom: 0 }, { top: 40, bottom: 50 }, true],
      [{ top: 90, bottom: 100 }, null, true],
      [null, { top: 100, bottom: 110 }, false],
      [{ top: -20, bottom: 0 }, null, false],
      [null, null, false],
    ] as const) {
      coords.mockImplementation((pos) => {
        const at = pos === 5 ? start : end;
        return at && { ...at, left: 0, right: 0 };
      });
      flashRanges(view, [{ from: 5, to: 12 }]);
      vi.advanceTimersByTime(SETTLE_MS);
      expect(isLit(view)).toBe(lit);
    }
    view.destroy();
  });

  it('marks each range with text in it, kept inside the note, whatever offsets it is handed', () => {
    fc.assert(
      fc.property(
        // Passages run across lines as often as not
        fc.string({
          unit: fc.constantFrom('a', 'b', ' ', '\n'),
          maxLength: 40,
        }),
        fc.array(fc.tuple(offsetArb, offsetArb), { maxLength: 4 }),
        (doc, pairs) => {
          const view = makeView(doc);

          flashRanges(
            view,
            pairs.map(([from, to]) => ({ from, to }))
          );

          const inside = (n: number) => Math.min(Math.max(n, 0), doc.length);
          const byPosition = (a: number[], b: number[]) =>
            a[0] - b[0] || a[1] - b[1];
          const expected = pairs
            .map(([a, b]) => [inside(a), inside(b)].sort((x, y) => x - y))
            .filter(([from, to]) => from < to)
            .sort(byPosition);
          expect(flashedRanges(view).sort(byPosition)).toEqual(expected);
          view.destroy();
        }
      ),
      // Each run builds an editor
      { numRuns: 40 }
    );
  });

  it('marks ranges handed over in any order', () => {
    const view = makeView('first second');

    flashRanges(view, [
      { from: 6, to: 12 },
      { from: 0, to: 5 },
    ]);

    expect(flashedText(view)).toEqual(['first', 'second']);
    view.destroy();
  });

  it('flashes a second place in place of the first, for a full flash of its own, at any point in the first', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: SETTLE_MS + CONTEXT_FADE_MS * 2 - 1 }),
        (into) => {
          const view = makeView('first second');
          flashRanges(view, [{ from: 0, to: 5 }]);
          vi.advanceTimersByTime(into);

          flashRanges(view, [{ from: 6, to: 12 }]);

          expect(flashedText(view)).toEqual(['second']);
          expect(phaseOf(view)).toBe('unlit');
          // Lit at the next frame, wherever the clock is between frames
          vi.advanceTimersByTime(SETTLE_MS);
          expect(phaseOf(view)).toBe('lit');
          vi.advanceTimersByTime(CONTEXT_FADE_MS - SETTLE_MS);
          expect(phaseOf(view)).toBe('lit');
          vi.advanceTimersByTime(SETTLE_MS);
          expect(phaseOf(view)).toBe('unlit');
          expect(flashedText(view)).toEqual(['second']);
          vi.advanceTimersByTime(CONTEXT_FADE_MS);
          expect(phaseOf(view)).toBe('none');
          view.destroy();
        }
      ),
      // Each run builds an editor
      { numRuns: 40 }
    );
  });

  it('keeps the marks on their text through edits made while they show', () => {
    const view = makeView('Some passage here');
    flashRanges(view, [{ from: 5, to: 12 }]);

    view.dispatch({ changes: { from: 0, insert: 'More. ' } });
    expect(flashedText(view)).toEqual(['passage']);
    vi.advanceTimersByTime(SETTLE_MS + CONTEXT_FADE_MS);
    // Fading out, as well as waiting
    view.dispatch({ changes: { from: 0, to: 2 } });

    expect(flashedText(view)).toEqual(['passage']);
    view.destroy();
  });

  it('is not held lit, nor put out early, by transactions that are no flash', () => {
    const view = makeView('Some passage here');
    flashRanges(view, [{ from: 5, to: 12 }]);

    vi.advanceTimersByTime(SETTLE_MS + CONTEXT_FADE_MS - 1);
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    view.dispatch({ selection: { anchor: 2 } });
    view.dispatch({ effects: StateEffect.define<null>().of(null) });
    expect(phaseOf(view)).toBe('lit');
    vi.advanceTimersByTime(1);
    expect(phaseOf(view)).toBe('unlit');
    vi.advanceTimersByTime(CONTEXT_FADE_MS);

    expect(phaseOf(view)).toBe('none');
    view.destroy();
  });

  it('times a flash that arrives alongside other transactions', () => {
    const view = makeView('Some passage here');

    // Two transactions in one update, only the second a flash: the shape
    // CodeMirror produces for a transaction dispatched while another applies
    const edit = view.state.update({ changes: { from: 0, insert: 'x' } });
    view.dispatch([
      edit,
      edit.state.update({
        effects: contextFlashEffect.of([{ from: 6, to: 13 }]),
      }),
    ]);
    expect(flashedText(view)).toEqual(['passage']);

    vi.advanceTimersByTime(SETTLE_MS);
    expect(phaseOf(view)).toBe('lit');
    vi.advanceTimersByTime(CONTEXT_FADE_MS * 2);
    expect(phaseOf(view)).toBe('none');
    view.destroy();
  });

  it('does not reach an editor that has gone, at any point in the flash', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.integer({ min: 0, max: SETTLE_MS + CONTEXT_FADE_MS * 2 - 1 }),
        (scrolled, into) => {
          const view = makeView('Some passage here');
          view.at.scrolled = scrolled;
          flashRanges(view, [{ from: 5, to: 12 }]);
          vi.advanceTimersByTime(into);

          view.destroy();
          const dispatch = vi.spyOn(view, 'dispatch');

          vi.advanceTimersByTime(CONTEXT_SCROLL_WAIT_MS + CONTEXT_FADE_MS * 2);
          expect(dispatch).not.toHaveBeenCalled();
          dispatch.mockRestore();
        }
      ),
      // Each run builds an editor
      { numRuns: 40 }
    );
  });

  it('still lights, fades and drops itself in a document that has no window of its own', () => {
    // A document built this way has a null `defaultView`
    const detached = document.implementation.createHTMLDocument();
    const view = makeView('Some passage here', detached.body);
    flashRanges(view, [{ from: 5, to: 12 }]);

    vi.advanceTimersByTime(SETTLE_MS);
    expect(phaseOf(view)).toBe('lit');
    vi.advanceTimersByTime(CONTEXT_FADE_MS);
    expect(phaseOf(view)).toBe('unlit');
    vi.advanceTimersByTime(CONTEXT_FADE_MS);

    expect(phaseOf(view)).toBe('none');
    view.destroy();
  });
});

describe('the flash stylesheet', () => {
  it('eases the light in and out over the fade', () => {
    const rule = readStylesheet().match(/\.ir-context-flash\s*\{([^}]*)\}/);

    expect(rule).not.toBeNull();
    const ms = `${CONTEXT_FADE_MS / 1000}s`;
    expect(rule![1]).toMatch(
      new RegExp(
        `transition:\\s*color ${ms} ease,\\s*background-color ${ms} ease;`
      )
    );
  });

  it('lights the marks under a lit editor', () => {
    const css = readStylesheet();

    expect(css).toMatch(
      /\.ir-context-flashing \.ir-context-flash[^{]*\{[^}]*background-color: var\(--text-highlight-bg\);/
    );
  });
});
