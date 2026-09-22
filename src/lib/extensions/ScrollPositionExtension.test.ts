import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { scrollPositionExtension } from '#/lib/extensions/ScrollPositionExtension';
import { irPluginFacet } from '#/lib/extensions/irPluginFacet';
import type { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #region HELPERS

type PluginFactory = (view: MockView) => { destroy(): void };

/**
 * ViewPlugin.define stores the factory as `.create` on the returned instance.
 */
function extractFactory(): PluginFactory {
  return (scrollPositionExtension as unknown as { create: PluginFactory })
    .create;
}

interface MockLine {
  number: number;
  from: number;
  to: number;
  text: string;
}

interface MockDoc {
  length: number;
  lines: number;
  line: (number: number) => MockLine;
  lineAt: (pos: number) => MockLine;
}

interface MockView {
  state: {
    facet: ReturnType<typeof vi.fn>;
    doc: MockDoc;
  };
  contentDOM: {
    querySelector: ReturnType<typeof vi.fn>;
  };
  scrollDOM: {
    getBoundingClientRect: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
  };
  posAtCoords: ReturnType<typeof vi.fn>;
  coordsAtPos: ReturnType<typeof vi.fn>;
  moveVertically: ReturnType<typeof vi.fn>;
  dispatch: ReturnType<typeof vi.fn>;
}

/** Height of every row in the mock document, in pixels. */
const LINE_HEIGHT = 24;

/**
 * A document of one row per line, with the offsets CodeMirror would give it.
 *
 * Only the members the anchor walk reads are modelled. Lines are separated by
 * a single newline, so `to` is the position after the last character of a line
 * and `from` of the next line is one past it.
 */
function makeDoc(lines: string[]): MockDoc {
  const starts: number[] = [];
  let at = 0;
  for (const text of lines) {
    starts.push(at);
    at += text.length + 1;
  }
  const line = (number: number): MockLine => ({
    number,
    from: starts[number - 1] ?? 0,
    to: (starts[number - 1] ?? 0) + (lines[number - 1] ?? '').length,
    text: lines[number - 1] ?? '',
  });
  return {
    length: Math.max(0, at - 1),
    lines: lines.length,
    line,
    lineAt: (pos: number) => {
      const index = lines.findIndex(
        (text, i) => pos >= starts[i] && pos <= starts[i] + text.length
      );
      return line(index === -1 ? lines.length : index + 1);
    },
  };
}

/** A single-line document, for tests that only care about offsets. */
function makeSingleLineDoc(length: number): MockDoc {
  const only: MockLine = { number: 1, from: 0, to: length, text: '' };
  return { length, lines: 1, line: () => only, lineAt: () => only };
}

function makeTFile(): TFile {
  return { path: 'ir-data/articles/test.md' } as TFile;
}

/** A sentinel effect so we can assert exactly what was dispatched. */
const FAKE_EFFECT = {
  sentinel: 'scrollIntoView',
} as unknown as StateEffect<unknown>;

/**
 * Replace EditorView.scrollIntoView with a spy returning FAKE_EFFECT, so tests
 * can assert the clamped position passed to it without depending on the opaque
 * StateEffect it normally returns. Restored by vi.restoreAllMocks().
 */
function spyScrollIntoView() {
  return vi.spyOn(EditorView, 'scrollIntoView').mockReturnValue(FAKE_EFFECT);
}

function makeReviewManager(offset?: number | null) {
  return {
    saveScrollPosition: vi.fn().mockResolvedValue(undefined),
    loadScrollPosition: vi.fn().mockResolvedValue(offset ?? null),
  };
}

function makePlugin(
  reviewManager:
    | ReturnType<typeof makeReviewManager>
    | null
    | undefined = undefined
) {
  return {
    reviewManager:
      reviewManager !== undefined ? reviewManager : makeReviewManager(),
  };
}

/**
 * Builds a MockView and sets up the ObsidianHelpers spies.
 *
 * @param propertiesWidget  - the element returned by `.querySelector('.metadata-container')`.
 *                            Pass `null` to simulate no widget (triggers MutationObserver path).
 *                            Pass an Element-like object to simulate an already-rendered widget.
 * @param topOffset         - document character offset that posAtCoords resolves the
 *                            top-visible point to (drives what handleScroll saves).
 * @param docLength         - document length, used to exercise restore clamping.
 */
function makeView(
  opts: {
    info?: object | null;
    file?: TFile | null;
    plugin?: ReturnType<typeof makePlugin> | null;
    noteType?: string | null;
    topOffset?: number;
    docLength?: number;
    docLines?: string[];
    firstLineTop?: number;
    propertiesWidget?: Element | null;
  } = {}
): MockView {
  const {
    file = makeTFile(),
    info,
    plugin = makePlugin(),
    noteType = 'article',
    topOffset = 0,
    docLength = 100000,
    docLines,
    firstLineTop = 2,
    propertiesWidget = null,
  } = opts;

  const doc = docLines ? makeDoc(docLines) : makeSingleLineDoc(docLength);

  // When `info` is explicitly provided use it; otherwise derive it from `file`.
  // Passing `file: null` produces { file: null, app: {} } (info is non-null but file is null)
  // so we exercise the second early-return guard in the factory.
  const resolvedInfo =
    info !== undefined ? info : { file: file ?? null, app: {} };

  const view: MockView = {
    state: {
      facet: vi
        .fn()
        .mockImplementation((facetDef: unknown) =>
          facetDef === irPluginFacet ? plugin : null
        ),
      doc,
    },
    contentDOM: {
      querySelector: vi.fn().mockReturnValue(propertiesWidget),
    },
    scrollDOM: {
      getBoundingClientRect: vi.fn().mockReturnValue({ left: 0, top: 0 }),
      addEventListener: vi.fn(),
    },
    posAtCoords: vi.fn().mockReturnValue(topOffset),
    // Each line is one row, stacked from `firstLineTop` down. A negative
    // `firstLineTop` puts the first rows above the top edge of the viewport,
    // which is what the anchor walk exists to step over.
    coordsAtPos: vi.fn().mockImplementation((pos: number) => {
      const top = firstLineTop + (doc.lineAt(pos).number - 1) * LINE_HEIGHT;
      return { top, bottom: top + LINE_HEIGHT, left: 0, right: 10 };
    }),
    // Honours `forward`, so a walk that steps the wrong way stalls here the
    // way it would in the editor rather than quietly reading the same.
    moveVertically: vi
      .fn()
      .mockImplementation((range: { head: number }, forward: boolean) => {
        const line = doc.lineAt(range.head);
        const number = forward ? line.number + 1 : line.number - 1;
        const head =
          number >= 1 && number <= doc.lines
            ? doc.line(number).from
            : range.head;
        return { head, from: head, to: head };
      }),
    dispatch: vi.fn(),
  };

  vi.spyOn(Obsidian, 'getFileInfoFromState').mockReturnValue({
    info: resolvedInfo as never,
    editorView: null,
  });
  vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue(noteType as never);

  return view;
}

/**
 * Creates a fake MutationObserver that exposes `triggerMutation()` for tests.
 * Returns `{ MockMO, triggerMutation }` where `triggerMutation` fires all
 * registered callbacks.
 */
function makeFakeMutationObserver() {
  let callback: MutationCallback | null = null;
  let observerInstance: {
    observe: () => void;
    disconnect: ReturnType<typeof vi.fn>;
  } | null = null;

  const disconnect = vi.fn();
  const observe = vi.fn();

  function MockMO(cb: MutationCallback) {
    callback = cb;
    observerInstance = { observe, disconnect };
    return observerInstance;
  }

  function triggerMutation() {
    if (callback && observerInstance) {
      callback([], observerInstance as unknown as MutationObserver);
    }
  }

  return { MockMO, triggerMutation, disconnect, observe };
}

/** A widget stub whose presence drives the "already rendered" restore path. */
function makeWidgetElement(): Element {
  return {} as unknown as Element;
}

// #endregion

// ---------------------------------------------------------------------------
// Factory extraction
// ---------------------------------------------------------------------------

let factory: PluginFactory;

beforeEach(() => {
  vi.useFakeTimers();
  // The extension schedules everything through `window` — Obsidian's lint rules
  // require `window.setTimeout` / `window.requestAnimationFrame` so the browser
  // (number-returning) overloads win over Node's Timeout objects. `window` does
  // not exist in the node test environment, so stub the four members it uses.
  // The animation-frame shims fall back to setTimeout(0) so vi.runAllTimersAsync()
  // can drive them deterministically.
  vi.stubGlobal('window', {
    setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    requestAnimationFrame: (cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  });

  // MutationObserver is also a browser API. Provide a no-op stub by default so
  // the 300ms fallback timeout fires; individual tests override this.
  const { MockMO } = makeFakeMutationObserver();
  vi.stubGlobal('MutationObserver', MockMO);

  factory = extractFactory();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Early-return guard: no info from state
// ---------------------------------------------------------------------------
describe('early return — no file info from state', () => {
  it('returns a no-op destroy when info is null', () => {
    const view = makeView({ info: null });
    const instance = factory(view as never);
    expect(instance).toHaveProperty('destroy');
    expect(() => instance.destroy()).not.toThrow();
  });

  it('does not register a scroll listener when info is null', async () => {
    const view = makeView({ info: null });
    factory(view as never);
    await vi.runAllTimersAsync();
    expect(view.scrollDOM.addEventListener).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Early-return guard: info present but file is null
// ---------------------------------------------------------------------------
describe('early return — file is null', () => {
  it('returns a no-op destroy when info.file is null', () => {
    const view = makeView({ file: null });
    const instance = factory(view as never);
    expect(instance).toHaveProperty('destroy');
    expect(() => instance.destroy()).not.toThrow();
  });

  it('does not register a scroll listener when file is null', async () => {
    const view = makeView({ file: null });
    factory(view as never);
    await vi.runAllTimersAsync();
    expect(view.scrollDOM.addEventListener).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Early-return guard: plugin absent (null from facet)
// ---------------------------------------------------------------------------
describe('early return — plugin is null', () => {
  it('returns a no-op destroy when irPluginFacet returns null', () => {
    const view = makeView({ plugin: null });
    const instance = factory(view as never);
    expect(instance).toHaveProperty('destroy');
    expect(() => instance.destroy()).not.toThrow();
  });

  it('does not register a scroll listener when plugin is null', async () => {
    const view = makeView({ plugin: null });
    factory(view as never);
    await vi.runAllTimersAsync();
    expect(view.scrollDOM.addEventListener).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Early-return guard: note has no IR type
// ---------------------------------------------------------------------------
describe('early return — not an IR note', () => {
  it('returns a no-op destroy when getNoteType returns null', () => {
    const view = makeView({ noteType: null });
    const instance = factory(view as never);
    expect(instance).toHaveProperty('destroy');
    expect(() => instance.destroy()).not.toThrow();
  });

  it('does not register a scroll listener when getNoteType returns null', async () => {
    const view = makeView({ noteType: null });
    factory(view as never);
    await vi.runAllTimersAsync();
    expect(view.scrollDOM.addEventListener).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Early-return guard: reviewManager absent
// ---------------------------------------------------------------------------
describe('early return — no reviewManager', () => {
  it('returns a no-op destroy when reviewManager is null', () => {
    const view = makeView({ plugin: makePlugin(null) as never });
    const instance = factory(view as never);
    expect(instance).toHaveProperty('destroy');
    expect(() => instance.destroy()).not.toThrow();
  });

  it('does not register a scroll listener when reviewManager is null', async () => {
    const view = makeView({ plugin: makePlugin(null) as never });
    factory(view as never);
    await vi.runAllTimersAsync();
    expect(view.scrollDOM.addEventListener).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Restore — properties widget already rendered on mount
// ---------------------------------------------------------------------------
describe('restore on mount (properties widget present)', () => {
  function makeViewWithWidget(
    opts: Parameters<typeof makeView>[0] = {}
  ): MockView {
    const widget = makeWidgetElement();
    const view = makeView({ ...opts, propertiesWidget: null });
    view.contentDOM.querySelector.mockImplementation((selector: string) =>
      selector === '.metadata-container' ? widget : null
    );
    return view;
  }

  it('registers a scrollend listener after the rAF chain and restore', async () => {
    const view = makeViewWithWidget({
      plugin: makePlugin(makeReviewManager(null)),
    });
    factory(view as never);

    expect(view.scrollDOM.addEventListener).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();

    expect(view.scrollDOM.addEventListener).toHaveBeenCalledWith(
      'scrollend',
      expect.any(Function),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('calls loadScrollPosition once on mount', async () => {
    const reviewManager = makeReviewManager(null);
    const view = makeViewWithWidget({ plugin: makePlugin(reviewManager) });
    factory(view as never);
    await vi.runAllTimersAsync();

    expect(reviewManager.loadScrollPosition).toHaveBeenCalledTimes(1);
  });

  it('queries for .metadata-container by the exact selector string', async () => {
    const widget = makeWidgetElement();
    const reviewManager = makeReviewManager(null);
    const view = makeView({
      plugin: makePlugin(reviewManager),
      propertiesWidget: null,
    });
    view.contentDOM.querySelector.mockImplementation((selector: string) =>
      selector === '.metadata-container' ? widget : null
    );

    factory(view as never);
    await vi.runAllTimersAsync();

    // loadScrollPosition ran, which means the widget was found via the selector
    expect(reviewManager.loadScrollPosition).toHaveBeenCalled();
  });

  it('scrolls the stored offset to the top of the viewport', async () => {
    const spy = spyScrollIntoView();
    const view = makeViewWithWidget({
      plugin: makePlugin(makeReviewManager(200)),
    });
    factory(view as never);
    await vi.runAllTimersAsync();

    expect(spy).toHaveBeenCalledWith(200, { y: 'start' });
    expect(view.dispatch).toHaveBeenCalledWith({ effects: FAKE_EFFECT });
  });

  it('restores an offset of 0 (a note scrolled to the very top)', async () => {
    const spy = spyScrollIntoView();
    const view = makeViewWithWidget({
      plugin: makePlugin(makeReviewManager(0)),
    });
    factory(view as never);
    await vi.runAllTimersAsync();

    expect(spy).toHaveBeenCalledWith(0, { y: 'start' });
    expect(view.dispatch).toHaveBeenCalledTimes(1);
  });

  it('clamps a stored offset past the end of the document to doc length', async () => {
    const spy = spyScrollIntoView();
    const view = makeViewWithWidget({
      plugin: makePlugin(makeReviewManager(999999)),
      docLength: 500,
    });
    factory(view as never);
    await vi.runAllTimersAsync();

    expect(spy).toHaveBeenCalledWith(500, { y: 'start' });
  });

  it('does not dispatch a scroll when loadScrollPosition returns null', async () => {
    const spy = spyScrollIntoView();
    const view = makeViewWithWidget({
      plugin: makePlugin(makeReviewManager(null)),
    });
    factory(view as never);
    await vi.runAllTimersAsync();

    expect(spy).not.toHaveBeenCalled();
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it('restores via the 300ms fallback when no properties widget appears', async () => {
    const spy = spyScrollIntoView();
    const view = makeView({
      plugin: makePlugin(makeReviewManager(150)),
      propertiesWidget: null, // no widget ever (e.g. the IREditor)
    });
    factory(view as never);
    await vi.runAllTimersAsync();

    expect(spy).toHaveBeenCalledWith(150, { y: 'start' });
  });
});

// ---------------------------------------------------------------------------
// handleScroll — saves the top-visible character offset
// ---------------------------------------------------------------------------
describe('handleScroll', () => {
  async function getScrollHandler(view: MockView): Promise<() => void> {
    factory(view as never);
    await vi.runAllTimersAsync();
    const call = view.scrollDOM.addEventListener.mock.calls[0] as [
      string,
      () => void,
    ];
    return call[1];
  }

  it('saves the offset posAtCoords resolves for the top-left visible point', async () => {
    const reviewManager = makeReviewManager(null);
    const view = makeView({
      plugin: makePlugin(reviewManager),
      topOffset: 1234,
      propertiesWidget: makeWidgetElement(),
    });
    const scrollHandler = await getScrollHandler(view);
    scrollHandler();

    expect(view.posAtCoords).toHaveBeenLastCalledWith({ x: 1, y: 1 }, false);
    expect(reviewManager.saveScrollPosition).toHaveBeenCalledWith(
      expect.anything(),
      1234
    );
  });

  it('offsets the probe point by 1px inside the scroller rect', async () => {
    const reviewManager = makeReviewManager(null);
    const view = makeView({
      plugin: makePlugin(reviewManager),
      topOffset: 7,
      propertiesWidget: makeWidgetElement(),
    });
    // Scroller not at the viewport origin: probe must track its rect.
    view.scrollDOM.getBoundingClientRect.mockReturnValue({ left: 40, top: 90 });
    const scrollHandler = await getScrollHandler(view);
    scrollHandler();

    expect(view.posAtCoords).toHaveBeenLastCalledWith({ x: 41, y: 91 }, false);
  });

  it('does not save when info is unavailable on scroll (getFileInfoFromState returns null)', async () => {
    const reviewManager = makeReviewManager(null);
    const view = makeView({
      plugin: makePlugin(reviewManager),
      propertiesWidget: makeWidgetElement(),
    });

    const scrollHandler = await getScrollHandler(view);

    // After setup, make getFileInfoFromState return null (simulates file closed)
    vi.spyOn(Obsidian, 'getFileInfoFromState').mockReturnValue({
      info: null,
      editorView: null,
    });

    scrollHandler();

    expect(reviewManager.saveScrollPosition).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The anchor walk — a saved position has to be one the reader can see
// ---------------------------------------------------------------------------
describe('anchor walk', () => {
  /** Run one scroll and report the offset it saved. */
  async function scrollAndSave(
    opts: Parameters<typeof makeView>[0] & {
      reviewManager: ReturnType<typeof makeReviewManager>;
    }
  ): Promise<{ offset: number | undefined; view: MockView }> {
    const { reviewManager, ...viewOpts } = opts;
    const view = makeView({
      ...viewOpts,
      plugin: makePlugin(reviewManager),
      propertiesWidget: makeWidgetElement(),
    });
    factory(view as never);
    await vi.runAllTimersAsync();
    const [, handleScroll] = view.scrollDOM.addEventListener.mock.calls[0] as [
      string,
      () => void,
    ];
    handleScroll();
    const call = reviewManager.saveScrollPosition.mock.calls.at(-1) as
      | [unknown, number]
      | undefined;
    return { offset: call?.[1], view };
  }

  // 'first line' is line 1 (0-10), the empty line 2 is 11, 'second line' is
  // line 3 (12-23). The scroller's rect top is 0, so the probe point — and
  // the edge a row has to reach to count as visible — is y = 1.
  const LINES = ['first line', '', 'second line'];

  it('saves the hit-tested position when its row is on screen', async () => {
    const reviewManager = makeReviewManager(null);
    const { offset } = await scrollAndSave({
      reviewManager,
      docLines: LINES,
      firstLineTop: 2,
      topOffset: 3,
    });

    expect(offset).toBe(3);
  });

  it('steps past a position on a row the reader has already scrolled off', async () => {
    const reviewManager = makeReviewManager(null);
    // Chromium answers a point inside the empty line with the end of the line
    // above it, which owns the nearest text node: offset 10 is `first line`'s
    // end, and that row has just left the viewport.
    const { offset } = await scrollAndSave({
      reviewManager,
      docLines: LINES,
      firstLineTop: -23,
      topOffset: 10,
    });

    expect(offset).toBe(11);
  });

  it('keeps stepping while whole rows sit above the edge', async () => {
    const reviewManager = makeReviewManager(null);
    const { offset } = await scrollAndSave({
      reviewManager,
      docLines: LINES,
      firstLineTop: -47,
      topOffset: 0,
    });

    expect(offset).toBe(12);
  });

  it('steps off a row with only a sliver showing', async () => {
    const reviewManager = makeReviewManager(null);
    // Half a pixel of `first line` is left on screen: too little for the
    // reader to be reading it, and restore would pull the whole row back.
    const { offset } = await scrollAndSave({
      reviewManager,
      docLines: LINES,
      firstLineTop: -23.5,
      topOffset: 5,
    });

    expect(offset).toBe(11);
  });

  it('keeps a row with more than a pixel showing', async () => {
    const reviewManager = makeReviewManager(null);
    const { offset } = await scrollAndSave({
      reviewManager,
      docLines: LINES,
      firstLineTop: -20,
      topOffset: 5,
    });

    expect(offset).toBe(5);
  });

  it('stops at the last row instead of walking off the document', async () => {
    const reviewManager = makeReviewManager(null);
    const { offset } = await scrollAndSave({
      reviewManager,
      docLines: ['only line'],
      firstLineTop: -30,
      topOffset: 4,
    });

    expect(offset).toBe(4);
  });

  it('saves the hit-tested position when the row cannot be measured', async () => {
    const reviewManager = makeReviewManager(null);
    const view = makeView({
      plugin: makePlugin(reviewManager),
      propertiesWidget: makeWidgetElement(),
      docLines: LINES,
      firstLineTop: -23,
      topOffset: 10,
    });
    // An unrendered position has no coordinates; the hit test's answer is all
    // there is to go on.
    view.coordsAtPos.mockReturnValue(null);
    factory(view as never);
    await vi.runAllTimersAsync();
    const [, handleScroll] = view.scrollDOM.addEventListener.mock.calls[0] as [
      string,
      () => void,
    ];
    handleScroll();

    expect(reviewManager.saveScrollPosition).toHaveBeenCalledWith(
      expect.anything(),
      10
    );
  });

  it('never saves a position on a row above the edge, wherever the hit test lands', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: -140, max: 20 }),
        fc.integer({ min: 0, max: 5 }),
        async (lineCount, firstLineTop, hitLine) => {
          const docLines = Array.from({ length: lineCount }, (_, i) =>
            i % 2 === 0 ? `line ${i}` : ''
          );
          const doc = makeDoc(docLines);
          const line = doc.line(Math.min(hitLine + 1, doc.lines));
          const reviewManager = makeReviewManager(null);
          const { offset } = await scrollAndSave({
            reviewManager,
            docLines,
            firstLineTop,
            topOffset: line.from,
          });

          expect(offset).not.toBeUndefined();
          const saved = doc.lineAt(offset as number);
          const bottom = firstLineTop + saved.number * LINE_HEIGHT;
          // Either the saved row is on screen, or the walk ran out of document
          // and kept the last row it could reach.
          expect(bottom > 1 || saved.number === doc.lines).toBe(true);
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// isRestoring guard — the programmatic restore must not re-save
// ---------------------------------------------------------------------------
describe('isRestoring guard', () => {
  function makeRestoringView(): MockView {
    return makeView({
      plugin: makePlugin(makeReviewManager(100)),
      topOffset: 42,
      propertiesWidget: makeWidgetElement(),
    });
  }

  it('dispatches the restore and then registers the scroll listener', async () => {
    spyScrollIntoView();
    const view = makeRestoringView();
    factory(view as never);
    await vi.runAllTimersAsync();

    expect(view.dispatch).toHaveBeenCalled();
    expect(view.scrollDOM.addEventListener).toHaveBeenCalled();
  });

  it('allows saving after isRestoring resets (200ms elapsed)', async () => {
    spyScrollIntoView();
    const reviewManager = makeReviewManager(100);
    const view = makeView({
      plugin: makePlugin(reviewManager),
      topOffset: 42,
      propertiesWidget: makeWidgetElement(),
    });
    factory(view as never);
    await vi.runAllTimersAsync();

    const scrollHandler = (
      view.scrollDOM.addEventListener.mock.calls[0] as [string, () => void]
    )[1];
    scrollHandler();

    expect(reviewManager.saveScrollPosition).toHaveBeenCalledTimes(1);
  });

  it('does not save while isRestoring is true (within the 200ms window)', async () => {
    spyScrollIntoView();
    const reviewManager = makeReviewManager(100);
    const view = makeView({
      plugin: makePlugin(reviewManager),
      topOffset: 42,
      propertiesWidget: makeWidgetElement(),
    });
    factory(view as never);

    // Advance through both rAFs + async load + dispatch + addEventListener,
    // but stop before the 200ms isRestoring guard clears.
    await vi.advanceTimersByTimeAsync(5); // rAF 1
    await vi.advanceTimersByTimeAsync(5); // rAF 2
    await Promise.resolve();
    await Promise.resolve();

    const calls = view.scrollDOM.addEventListener.mock.calls;
    if (calls.length > 0) {
      const scrollHandler = (calls[0] as [string, () => void])[1];
      scrollHandler();
      expect(reviewManager.saveScrollPosition).not.toHaveBeenCalled();
    }
    await vi.runAllTimersAsync();
  });
});

// ---------------------------------------------------------------------------
// waitForPropertiesAndRestore — MutationObserver path
// ---------------------------------------------------------------------------
describe('waitForPropertiesAndRestore — MutationObserver path', () => {
  it('sets up MutationObserver when .metadata-container is not present initially', async () => {
    const { MockMO, observe } = makeFakeMutationObserver();
    vi.stubGlobal('MutationObserver', MockMO);

    const view = makeView({ propertiesWidget: null });
    factory(view as never);
    await vi.runAllTimersAsync();

    expect(observe).toHaveBeenCalledWith(
      view.contentDOM,
      expect.objectContaining({ childList: true, subtree: true })
    );
  });

  it('restores when the observer fires and the widget appears', async () => {
    const spy = spyScrollIntoView();
    const reviewManager = makeReviewManager(50);
    const fakeWidget = makeWidgetElement();

    const { MockMO, triggerMutation } = makeFakeMutationObserver();
    vi.stubGlobal('MutationObserver', MockMO);

    const view = makeView({
      plugin: makePlugin(reviewManager),
      propertiesWidget: null,
    });

    factory(view as never);
    await vi.advanceTimersByTimeAsync(10); // through rAFs → observer created

    view.contentDOM.querySelector.mockReturnValue(fakeWidget);
    triggerMutation();
    await vi.runAllTimersAsync();

    expect(reviewManager.loadScrollPosition).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(50, { y: 'start' });
  });

  it('disconnects observer when widget appears via mutation', async () => {
    const { MockMO, triggerMutation, disconnect } = makeFakeMutationObserver();
    vi.stubGlobal('MutationObserver', MockMO);

    const fakeWidget = makeWidgetElement();
    const view = makeView({
      plugin: makePlugin(makeReviewManager(null)),
      propertiesWidget: null,
    });

    factory(view as never);
    await vi.advanceTimersByTimeAsync(10);

    view.contentDOM.querySelector.mockReturnValue(fakeWidget);
    triggerMutation();
    await vi.runAllTimersAsync();

    expect(disconnect).toHaveBeenCalled();
  });

  it('falls back to restoring after 300ms if no widget ever appears', async () => {
    const reviewManager = makeReviewManager(50);
    const { MockMO } = makeFakeMutationObserver();
    vi.stubGlobal('MutationObserver', MockMO);

    const view = makeView({
      plugin: makePlugin(reviewManager),
      propertiesWidget: null,
    });

    factory(view as never);
    await vi.runAllTimersAsync();

    expect(reviewManager.loadScrollPosition).toHaveBeenCalled();
  });

  it('queries for .metadata-container by the exact selector inside the observer callback', async () => {
    const { MockMO, triggerMutation } = makeFakeMutationObserver();
    vi.stubGlobal('MutationObserver', MockMO);

    const fakeWidget = makeWidgetElement();
    const view = makeView({
      plugin: makePlugin(makeReviewManager(null)),
      propertiesWidget: null,
    });

    factory(view as never);
    await vi.advanceTimersByTimeAsync(10);

    view.contentDOM.querySelector.mockReturnValue(fakeWidget);
    triggerMutation();
    await vi.runAllTimersAsync();

    const calls = view.contentDOM.querySelector.mock.calls;
    expect(
      calls.every((call) => (call as [string])[0] === '.metadata-container')
    ).toBe(true);
  });

  it('does nothing when observer fires but widget is still not present', async () => {
    const reviewManager = makeReviewManager(null);
    const { MockMO, triggerMutation } = makeFakeMutationObserver();
    vi.stubGlobal('MutationObserver', MockMO);

    const view = makeView({
      plugin: makePlugin(reviewManager),
      propertiesWidget: null, // widget never appears
    });

    factory(view as never);
    await vi.advanceTimersByTimeAsync(10);

    triggerMutation();
    await vi.advanceTimersByTimeAsync(10);

    // restore not yet reached (the if(widget) branch was false)
    expect(reviewManager.loadScrollPosition).not.toHaveBeenCalled();

    // 300ms fallback still runs and calls restore
    await vi.runAllTimersAsync();
    expect(reviewManager.loadScrollPosition).toHaveBeenCalledTimes(1);
  });

  it('clears the 300ms fallback timeout when observer fires first', async () => {
    const { MockMO, triggerMutation, disconnect } = makeFakeMutationObserver();
    vi.stubGlobal('MutationObserver', MockMO);

    const reviewManager = makeReviewManager(null);
    const fakeWidget = makeWidgetElement();
    const view = makeView({
      plugin: makePlugin(reviewManager),
      propertiesWidget: null,
    });

    factory(view as never);
    await vi.advanceTimersByTimeAsync(10);

    view.contentDOM.querySelector.mockReturnValue(fakeWidget);
    triggerMutation();
    await vi.runAllTimersAsync();

    // loadScrollPosition called exactly once (fallback didn't fire separately)
    expect(reviewManager.loadScrollPosition).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// destroy() — cleans up resources
// ---------------------------------------------------------------------------
describe('destroy()', () => {
  it('aborts the AbortController (prevents further scroll listener firing)', async () => {
    const view = makeView({
      plugin: makePlugin(makeReviewManager(null)),
      propertiesWidget: makeWidgetElement(),
    });
    const instance = factory(view as never);
    await vi.runAllTimersAsync();

    instance.destroy();

    const [, , options] = view.scrollDOM.addEventListener.mock.calls[0] as [
      string,
      EventListener,
      AddEventListenerOptions,
    ];
    expect(options.signal!.aborted).toBe(true);
  });

  it('does not throw when destroyed before rAF chain completes', () => {
    const view = makeView({
      plugin: makePlugin(makeReviewManager(null)),
      propertiesWidget: makeWidgetElement(),
    });
    const instance = factory(view as never);
    // Destroy immediately — AbortController and MutationObserver not yet created
    expect(() => instance.destroy()).not.toThrow();
  });

  it('does not throw on any early-return no-op destroy path', () => {
    const cases = [
      makeView({ info: null }),
      makeView({ file: null }),
      makeView({ plugin: null }),
      makeView({ noteType: null }),
      makeView({ plugin: makePlugin(null) as never }),
    ];
    for (const view of cases) {
      const instance = factory(view as never);
      expect(() => instance.destroy()).not.toThrow();
    }
  });

  it('disconnects MutationObserver when destroy is called mid-wait', async () => {
    const { MockMO, disconnect } = makeFakeMutationObserver();
    vi.stubGlobal('MutationObserver', MockMO);

    const view = makeView({
      plugin: makePlugin(makeReviewManager(null)),
      propertiesWidget: null,
    });

    const instance = factory(view as never);
    // Advance through rAFs so MutationObserver is set up, but don't fire it or timeout
    await vi.advanceTimersByTimeAsync(10);

    instance.destroy();

    expect(disconnect).toHaveBeenCalled();
  });

  it('clears the isRestoring timeout on destroy so it does not fire after teardown', async () => {
    spyScrollIntoView();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const view = makeView({
      plugin: makePlugin(makeReviewManager(100)),
      propertiesWidget: makeWidgetElement(),
    });
    const instance = factory(view as never);

    // Let the restore happen (sets scrollTimeout) but don't clear the 200ms guard yet
    await vi.advanceTimersByTimeAsync(10); // through rAFs
    await Promise.resolve(); // flush loadScrollPosition
    await Promise.resolve(); // flush dispatch + setTimeout

    instance.destroy();

    expect(clearTimeoutSpy).toHaveBeenCalled();

    await vi.runAllTimersAsync();
  });

  it('does not call clearTimeout when no restore occurred (scrollTimeout is undefined)', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const view = makeView({
      plugin: makePlugin(makeReviewManager(null)), // null = no stored position → no scrollTimeout
      propertiesWidget: makeWidgetElement(),
    });
    const instance = factory(view as never);
    await vi.runAllTimersAsync();

    const beforeCount = clearTimeoutSpy.mock.calls.length;
    instance.destroy();
    const afterCount = clearTimeoutSpy.mock.calls.length;
    expect(afterCount - beforeCount).toBe(0);
  });

  it('does not call observer.disconnect if no MutationObserver was created (widget present on mount)', async () => {
    const { MockMO, disconnect } = makeFakeMutationObserver();
    vi.stubGlobal('MutationObserver', MockMO);

    const widget = makeWidgetElement();
    const view = makeView({
      plugin: makePlugin(makeReviewManager(null)),
      propertiesWidget: null,
    });
    view.contentDOM.querySelector.mockImplementation((selector: string) =>
      selector === '.metadata-container' ? widget : null
    );
    const instance = factory(view as never);
    await vi.runAllTimersAsync();

    // Widget was present on mount — MutationObserver was never created
    expect(() => instance.destroy()).not.toThrow();
    expect(disconnect).not.toHaveBeenCalled();
  });
});
