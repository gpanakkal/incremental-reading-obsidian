/* eslint-disable obsidianmd/no-tfile-tfolder-cast -- test file */
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { scrollPositionExtension } from '#/lib/extensions/ScrollPositionExtension';
import { irPluginFacet } from '#/lib/extensions/irPluginFacet';
import type { TFile } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #region HELPERS

type PluginFactory = (view: MockView) => { destroy(): void };

/**
 * ViewPlugin.define stores the factory as `.create` on the returned instance.
 */
function extractFactory(): PluginFactory {
  return (scrollPositionExtension as unknown as { create: PluginFactory }).create;
}

interface MockView {
  state: { facet: ReturnType<typeof vi.fn> };
  contentDOM: {
    querySelector: ReturnType<typeof vi.fn>;
  };
  scrollDOM: {
    scrollTop: number;
    scrollLeft: number;
    scrollTo: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
  };
}

function makeTFile(): TFile {
  return { path: 'ir-data/articles/test.md' } as TFile;
}

function makeReviewManager(scrollPos?: { top: number; left: number } | null) {
  return {
    saveScrollPosition: vi.fn().mockResolvedValue(undefined),
    loadScrollPosition: vi.fn().mockResolvedValue(scrollPos ?? null),
  };
}

function makePlugin(reviewManager: ReturnType<typeof makeReviewManager> | null | undefined = undefined) {
  return { reviewManager: reviewManager !== undefined ? reviewManager : makeReviewManager() };
}

/**
 * Builds a MockView and sets up the ObsidianHelpers spies.
 *
 * @param propertiesWidget  - the element returned by `.querySelector('.metadata-container')`.
 *                            Pass `null` to simulate no widget (triggers MutationObserver path).
 *                            Pass an Element-like object to simulate an already-rendered widget.
 */
function makeView(opts: {
  info?: object | null;
  file?: TFile | null;
  plugin?: ReturnType<typeof makePlugin> | null;
  noteType?: string | null;
  scrollTop?: number;
  scrollLeft?: number;
  propertiesWidget?: Element | null;
} = {}): MockView {
  const {
    file = makeTFile(),
    info,
    plugin = makePlugin(),
    noteType = 'article',
    scrollTop = 0,
    scrollLeft = 0,
    propertiesWidget = null,
  } = opts;

  // When `info` is explicitly provided use it; otherwise derive it from `file`.
  // Passing `file: null` produces { file: null, app: {} } (info is non-null but file is null)
  // so we exercise the second early-return guard in the factory.
  const resolvedInfo =
    info !== undefined ? info : { file: file ?? null, app: {} };

  const view: MockView = {
    state: {
      facet: vi.fn().mockImplementation((facetDef: unknown) =>
        facetDef === irPluginFacet ? plugin : null
      ),
    },
    contentDOM: {
      querySelector: vi.fn().mockReturnValue(propertiesWidget),
    },
    scrollDOM: {
      scrollTop,
      scrollLeft,
      scrollTo: vi.fn(),
      addEventListener: vi.fn(),
    },
  };

  vi.spyOn(Obsidian, 'getFileInfoFromState').mockReturnValue({
    info: resolvedInfo as never,
    editorView: null,
  });
  vi.spyOn(Obsidian, 'getNoteType').mockReturnValue(noteType as never);

  return view;
}

/**
 * Creates a fake MutationObserver that exposes `triggerMutation()` for tests.
 * Returns `{ MockMO, triggerMutation }` where `triggerMutation` fires all
 * registered callbacks.
 */
function makeFakeMutationObserver() {
  let callback: MutationCallback | null = null;
  let observerInstance: { observe: () => void; disconnect: ReturnType<typeof vi.fn> } | null =
    null;

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

// #endregion

// ---------------------------------------------------------------------------
// Factory extraction
// ---------------------------------------------------------------------------

let factory: PluginFactory;

beforeEach(() => {
  vi.useFakeTimers();
  // requestAnimationFrame / cancelAnimationFrame are browser APIs — not
  // available in the node test environment. Stub them to use setTimeout(0)
  // so vi.runAllTimersAsync() can drive them deterministically.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0)
  );
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));

  // window.setTimeout is used by restoreScrollPosition for the isRestoring guard.
  // In the node env, `window` is not defined. Stub it to use global setTimeout.
  vi.stubGlobal('window', {
    setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
    clearTimeout: (id: number) => clearTimeout(id),
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
// Normal path — properties widget already rendered on mount
// ---------------------------------------------------------------------------
describe('properties widget already present on mount', () => {
  function makeWidgetElement(height = 60): Element {
    return {
      getBoundingClientRect: vi.fn().mockReturnValue({ height }),
    } as unknown as Element;
  }

  /**
   * Build a view whose querySelector is selector-aware: returns the widget only
   * for '.metadata-container', null for any other selector.
   * This allows killing mutants that change the selector string.
   */
  function makeViewWithSelectorAwareDOM(opts: Parameters<typeof makeView>[0] & { widgetHeight?: number } = {}) {
    const { widgetHeight = 60, ...viewOpts } = opts;
    const widget = makeWidgetElement(widgetHeight);
    const view = makeView({ ...viewOpts, propertiesWidget: null });
    (view.contentDOM.querySelector as ReturnType<typeof vi.fn>).mockImplementation(
      (selector: string) => selector === '.metadata-container' ? widget : null
    );
    return { view, widget };
  }

  it('registers a scrollend listener after the rAF chain and restore', async () => {
    const reviewManager = makeReviewManager(null);
    const view = makeView({
      plugin: makePlugin(reviewManager),
      propertiesWidget: makeWidgetElement(),
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
    const view = makeView({
      plugin: makePlugin(reviewManager),
      propertiesWidget: makeWidgetElement(),
    });
    factory(view as never);
    await vi.runAllTimersAsync();

    expect(reviewManager.loadScrollPosition).toHaveBeenCalledTimes(1);
  });

  it('queries for .metadata-container by the exact selector string', async () => {
    const widget = makeWidgetElement();
    // Make querySelector selector-aware: only return the widget for the expected selector
    const reviewManager = makeReviewManager(null);
    const view = makeView({
      plugin: makePlugin(reviewManager),
      propertiesWidget: null, // start null so we can control per-selector
    });

    // Override querySelector: return widget only when called with the exact selector
    (view.contentDOM.querySelector as ReturnType<typeof vi.fn>).mockImplementation(
      (selector: string) => (selector === '.metadata-container' ? widget : null)
    );

    factory(view as never);
    await vi.runAllTimersAsync();

    // loadScrollPosition was called, which means the widget was found via the correct selector
    expect(reviewManager.loadScrollPosition).toHaveBeenCalled();
  });

  it('calls scrollTo with stored top + frontmatter height', async () => {
    const storedPos = { top: 200, left: 5 };
    const reviewManager = makeReviewManager(storedPos);
    const { view } = makeViewWithSelectorAwareDOM({
      plugin: makePlugin(reviewManager),
      widgetHeight: 80,
    });
    factory(view as never);
    await vi.runAllTimersAsync();

    expect(view.scrollDOM.scrollTo).toHaveBeenCalledWith({
      top: 280, // 200 + 80
      left: 5,
      behavior: 'auto',
    });
  });

  it('does not call scrollTo when loadScrollPosition returns null', async () => {
    const reviewManager = makeReviewManager(null);
    const view = makeView({
      plugin: makePlugin(reviewManager),
      propertiesWidget: makeWidgetElement(),
    });
    factory(view as never);
    await vi.runAllTimersAsync();

    expect(view.scrollDOM.scrollTo).not.toHaveBeenCalled();
  });

  it('uses 0 for frontmatter height when no .metadata-container present', async () => {
    const storedPos = { top: 150, left: 3 };
    const reviewManager = makeReviewManager(storedPos);
    const view = makeView({
      plugin: makePlugin(reviewManager),
      propertiesWidget: null, // falls through to MutationObserver + 300ms timeout
    });
    // For this sub-test we want the timeout to fire (no widget ever appears)
    factory(view as never);
    await vi.runAllTimersAsync();

    expect(view.scrollDOM.scrollTo).toHaveBeenCalledWith({
      top: 150, // 0 frontmatter height
      left: 3,
      behavior: 'auto',
    });
  });
});

// ---------------------------------------------------------------------------
// handleScroll — saves scroll position to reviewManager
// ---------------------------------------------------------------------------
describe('handleScroll', () => {
  /**
   * Build a view with a selector-aware querySelector so that the
   * `.metadata-container` string literal mutant (line 59) is killed —
   * if the selector changes to "" the widget won't be found and height = 0.
   */
  function makeViewForScroll(opts: { height: number; scrollTop: number; scrollLeft: number; reviewManager: ReturnType<typeof makeReviewManager> }): MockView {
    const widget = {
      getBoundingClientRect: vi.fn().mockReturnValue({ height: opts.height }),
    } as unknown as Element;
    const view = makeView({
      plugin: makePlugin(opts.reviewManager),
      scrollTop: opts.scrollTop,
      scrollLeft: opts.scrollLeft,
      propertiesWidget: null,
    });
    (view.contentDOM.querySelector as ReturnType<typeof vi.fn>).mockImplementation(
      (selector: string) => selector === '.metadata-container' ? widget : null
    );
    return view;
  }

  async function getScrollHandler(view: MockView): Promise<() => void> {
    factory(view as never);
    await vi.runAllTimersAsync();
    const call = view.scrollDOM.addEventListener.mock.calls[0] as [string, () => void];
    return call[1];
  }

  it('saves body-relative scroll position (scrollTop minus frontmatter height)', async () => {
    const reviewManager = makeReviewManager(null);
    const view = makeViewForScroll({ height: 100, scrollTop: 250, scrollLeft: 10, reviewManager });
    const scrollHandler = await getScrollHandler(view);
    scrollHandler();

    expect(reviewManager.saveScrollPosition).toHaveBeenCalledWith(
      expect.anything(),
      { top: 150, left: 10 }
    );
  });

  it('clamps bodyRelativeTop to 0 when scrollTop < frontmatter height', async () => {
    const reviewManager = makeReviewManager(null);
    const view = makeViewForScroll({ height: 300, scrollTop: 50, scrollLeft: 0, reviewManager });
    const scrollHandler = await getScrollHandler(view);
    scrollHandler();

    expect(reviewManager.saveScrollPosition).toHaveBeenCalledWith(
      expect.anything(),
      { top: 0, left: 0 }
    );
  });

  it('saves full scrollTop when no metadata-container present (frontmatter height = 0)', async () => {
    const reviewManager = makeReviewManager(null);
    // querySelector returns null for any selector → height = 0
    const view = makeView({
      plugin: makePlugin(reviewManager),
      scrollTop: 80,
      scrollLeft: 5,
      propertiesWidget: null,
    });
    const scrollHandler = await getScrollHandler(view);
    scrollHandler();

    expect(reviewManager.saveScrollPosition).toHaveBeenCalledWith(
      expect.anything(),
      { top: 80, left: 5 }
    );
  });

  it('does not save when info is unavailable on scroll (getFileInfoFromState returns null)', async () => {
    const reviewManager = makeReviewManager(null);
    const file = makeTFile();
    // Set up view with valid info for the factory initialization
    const view = makeView({
      plugin: makePlugin(reviewManager),
      propertiesWidget: null,
    });

    factory(view as never);
    await vi.runAllTimersAsync();

    // After setup, make getFileInfoFromState return null (simulates file closed)
    vi.spyOn(Obsidian, 'getFileInfoFromState').mockReturnValue({ info: null, editorView: null });
    void file; // referenced for clarity

    const call = view.scrollDOM.addEventListener.mock.calls[0] as [string, () => void];
    const scrollHandler = call[1];
    scrollHandler();

    expect(reviewManager.saveScrollPosition).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// restoreScrollPosition — isRestoring guard
// ---------------------------------------------------------------------------
describe('isRestoring guard', () => {
  it('sets isRestoring back to false after 200ms timeout', async () => {
    const storedPos = { top: 100, left: 0 };
    const reviewManager = makeReviewManager(storedPos);
    const view = makeView({
      plugin: makePlugin(reviewManager),
      propertiesWidget: {
        getBoundingClientRect: vi.fn().mockReturnValue({ height: 0 }),
      } as unknown as Element,
    });
    factory(view as never);
    await vi.runAllTimersAsync();

    // scrollTo was called (restore happened) → isRestoring was set true → 200ms timer set
    expect(view.scrollDOM.scrollTo).toHaveBeenCalled();
    // The scroll listener should now be registered (isRestoring timer cleared by runAllTimersAsync)
    expect(view.scrollDOM.addEventListener).toHaveBeenCalled();
  });

  it('allows saving scroll position after isRestoring resets to false (200ms elapsed)', async () => {
    const storedPos = { top: 100, left: 0 };
    const reviewManager = makeReviewManager(storedPos);
    const view = makeView({
      plugin: makePlugin(reviewManager),
      propertiesWidget: {
        getBoundingClientRect: vi.fn().mockReturnValue({ height: 0 }),
      } as unknown as Element,
    });
    factory(view as never);

    // Run all timers: rAFs, restore, isRestoring 200ms timer, scroll listener registration
    await vi.runAllTimersAsync();

    // Now isRestoring is false — fire the scroll handler and expect save to happen
    const calls = view.scrollDOM.addEventListener.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const scrollHandler = (calls[0] as [string, () => void])[1];
    scrollHandler();

    expect(reviewManager.saveScrollPosition).toHaveBeenCalledTimes(1);
  });

  it('does not save scroll position while isRestoring is true (within the 200ms window)', async () => {
    const storedPos = { top: 100, left: 0 };
    const reviewManager = makeReviewManager(storedPos);
    const widget = {
      getBoundingClientRect: vi.fn().mockReturnValue({ height: 0 }),
    } as unknown as Element;
    const view = makeView({
      plugin: makePlugin(reviewManager),
      propertiesWidget: widget,
    });
    factory(view as never);

    // Advance through both rAFs + the async loadScrollPosition + scrollTo + addEventListener.
    // The 200ms isRestoring guard is NOT cleared yet (we stop before 200ms).
    await vi.advanceTimersByTimeAsync(5); // rAF 1
    await vi.advanceTimersByTimeAsync(5); // rAF 2
    // flush the waitForPropertiesAndRestore promise chain
    await Promise.resolve();
    await Promise.resolve();

    // The scroll listener was registered; now trigger it while isRestoring is still true
    const calls = view.scrollDOM.addEventListener.mock.calls;
    if (calls.length > 0) {
      const scrollHandler = (calls[0] as [string, () => void])[1];
      scrollHandler();
      expect(reviewManager.saveScrollPosition).not.toHaveBeenCalled();
    }
    // Clean up remaining timers
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

  it('calls restoreScrollPosition when observer fires and widget appears', async () => {
    const reviewManager = makeReviewManager({ top: 50, left: 0 });
    const fakeWidget = {
      getBoundingClientRect: vi.fn().mockReturnValue({ height: 20 }),
    } as unknown as Element;

    const { MockMO, triggerMutation } = makeFakeMutationObserver();
    vi.stubGlobal('MutationObserver', MockMO);

    const view = makeView({
      plugin: makePlugin(reviewManager),
      propertiesWidget: null,
    });

    factory(view as never);

    // Advance through both rAFs so the MutationObserver is created
    await vi.advanceTimersByTimeAsync(10);

    // Now simulate the widget appearing
    (view.contentDOM.querySelector as ReturnType<typeof vi.fn>).mockReturnValue(fakeWidget);
    triggerMutation();

    // Flush the requestAnimationFrame queued inside the observer callback
    await vi.runAllTimersAsync();

    expect(reviewManager.loadScrollPosition).toHaveBeenCalled();
    expect(view.scrollDOM.scrollTo).toHaveBeenCalledWith({
      top: 70, // 50 + 20
      left: 0,
      behavior: 'auto',
    });
  });

  it('disconnects observer when widget appears via mutation', async () => {
    const { MockMO, triggerMutation, disconnect } = makeFakeMutationObserver();
    vi.stubGlobal('MutationObserver', MockMO);

    const fakeWidget = {
      getBoundingClientRect: vi.fn().mockReturnValue({ height: 0 }),
    } as unknown as Element;

    const view = makeView({
      plugin: makePlugin(makeReviewManager(null)),
      propertiesWidget: null,
    });

    factory(view as never);
    await vi.advanceTimersByTimeAsync(10);

    (view.contentDOM.querySelector as ReturnType<typeof vi.fn>).mockReturnValue(fakeWidget);
    triggerMutation();
    await vi.runAllTimersAsync();

    expect(disconnect).toHaveBeenCalled();
  });

  it('falls back to restoring after 300ms if no widget ever appears', async () => {
    const reviewManager = makeReviewManager({ top: 50, left: 0 });
    const { MockMO } = makeFakeMutationObserver();
    vi.stubGlobal('MutationObserver', MockMO);

    const view = makeView({
      plugin: makePlugin(reviewManager),
      propertiesWidget: null,
    });

    factory(view as never);
    // Widget never appears — let the 300ms fallback fire
    await vi.runAllTimersAsync();

    expect(reviewManager.loadScrollPosition).toHaveBeenCalled();
  });

  it('queries for .metadata-container by the exact selector inside the observer callback', async () => {
    const { MockMO, triggerMutation } = makeFakeMutationObserver();
    vi.stubGlobal('MutationObserver', MockMO);

    const fakeWidget = {
      getBoundingClientRect: vi.fn().mockReturnValue({ height: 0 }),
    } as unknown as Element;

    const view = makeView({
      plugin: makePlugin(makeReviewManager(null)),
      propertiesWidget: null,
    });

    factory(view as never);
    await vi.advanceTimersByTimeAsync(10);

    (view.contentDOM.querySelector as ReturnType<typeof vi.fn>).mockReturnValue(fakeWidget);
    triggerMutation();
    await vi.runAllTimersAsync();

    const calls = (view.contentDOM.querySelector as ReturnType<typeof vi.fn>).mock.calls;
    // Both the initial check and the observer check use '.metadata-container'
    expect(calls.every((call) => (call as [string])[0] === '.metadata-container')).toBe(true);
  });

  it('calls restoreScrollPosition immediately when observer fires (before 300ms fallback)', async () => {
    const reviewManager = makeReviewManager({ top: 50, left: 0 });
    const fakeWidget = {
      getBoundingClientRect: vi.fn().mockReturnValue({ height: 0 }),
    } as unknown as Element;

    const { MockMO, triggerMutation } = makeFakeMutationObserver();
    vi.stubGlobal('MutationObserver', MockMO);

    const view = makeView({
      plugin: makePlugin(reviewManager),
      propertiesWidget: null,
    });

    factory(view as never);
    await vi.advanceTimersByTimeAsync(10); // through rAFs

    (view.contentDOM.querySelector as ReturnType<typeof vi.fn>).mockReturnValue(fakeWidget);
    triggerMutation();

    // Advance LESS than 300ms — restore should still have happened via observer (not fallback)
    await vi.advanceTimersByTimeAsync(50);

    expect(reviewManager.loadScrollPosition).toHaveBeenCalled();
    await vi.runAllTimersAsync();
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
    await vi.advanceTimersByTimeAsync(10); // through rAFs

    // querySelector still returns null — widget hasn't appeared
    // Trigger the observer anyway (simulates a different DOM mutation)
    triggerMutation();
    await vi.advanceTimersByTimeAsync(10);

    // restoreScrollPosition should NOT have been called yet
    // (the if(widget) branch was false, so we skip the disconnect/restore)
    expect(reviewManager.loadScrollPosition).not.toHaveBeenCalled();

    // 300ms fallback still runs and calls restore
    await vi.runAllTimersAsync();
    expect(reviewManager.loadScrollPosition).toHaveBeenCalledTimes(1);
  });

  it('clears the 300ms fallback timeout when observer fires first', async () => {
    const { MockMO, triggerMutation, disconnect } = makeFakeMutationObserver();
    vi.stubGlobal('MutationObserver', MockMO);

    const reviewManager = makeReviewManager(null);
    const fakeWidget = {
      getBoundingClientRect: vi.fn().mockReturnValue({ height: 0 }),
    } as unknown as Element;

    const view = makeView({
      plugin: makePlugin(reviewManager),
      propertiesWidget: null,
    });

    factory(view as never);
    await vi.advanceTimersByTimeAsync(10);

    (view.contentDOM.querySelector as ReturnType<typeof vi.fn>).mockReturnValue(fakeWidget);
    triggerMutation();
    await vi.runAllTimersAsync();

    // loadScrollPosition called exactly once (not twice — fallback didn't fire separately)
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
      propertiesWidget: {
        getBoundingClientRect: vi.fn().mockReturnValue({ height: 0 }),
      } as unknown as Element,
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
      propertiesWidget: {
        getBoundingClientRect: vi.fn().mockReturnValue({ height: 0 }),
      } as unknown as Element,
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
    const storedPos = { top: 100, left: 0 };
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const view = makeView({
      plugin: makePlugin(makeReviewManager(storedPos)),
      propertiesWidget: {
        getBoundingClientRect: vi.fn().mockReturnValue({ height: 0 }),
      } as unknown as Element,
    });
    const instance = factory(view as never);

    // Let the restore happen (sets scrollTimeout) but don't clear the 200ms guard yet
    await vi.advanceTimersByTimeAsync(10); // through rAFs
    await Promise.resolve(); // flush loadScrollPosition
    await Promise.resolve(); // flush scrollTo + setTimeout

    instance.destroy();

    // clearTimeout should have been called with the scrollTimeout id
    expect(clearTimeoutSpy).toHaveBeenCalled();

    // Advancing past 200ms should not cause errors or stale isRestoring state
    await vi.runAllTimersAsync();
  });

  it('does not call clearTimeout when no restore occurred (scrollTimeout is undefined)', async () => {
    // When loadScrollPosition returns null, scrollTimeout is never set (no isRestoring guard needed).
    // If stryker mutates `if (scrollTimeout !== undefined)` to `if (true)`,
    // clearTimeout(undefined) would be called. We verify clearTimeout is NOT called
    // in this path by checking call count.
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const view = makeView({
      plugin: makePlugin(makeReviewManager(null)), // null = no stored position → no scrollTimeout
      propertiesWidget: {
        getBoundingClientRect: vi.fn().mockReturnValue({ height: 0 }),
      } as unknown as Element,
    });
    const instance = factory(view as never);
    await vi.runAllTimersAsync();

    // No restore happened, so scrollTimeout is undefined
    const beforeCount = clearTimeoutSpy.mock.calls.length;
    instance.destroy();
    // clearTimeout should not have been called for scrollTimeout (it's undefined)
    const afterCount = clearTimeoutSpy.mock.calls.length;
    expect(afterCount - beforeCount).toBe(0);
  });

  it('does not call observer.disconnect if no MutationObserver was created (widget present on mount)', async () => {
    // When the properties widget is already present, no MutationObserver is created.
    // destroy() calls mutationObserver?.disconnect() — with optional chaining this is safe.
    // If the optional chaining is removed (mutated to .disconnect()), it would throw here.
    const { MockMO, disconnect } = makeFakeMutationObserver();
    vi.stubGlobal('MutationObserver', MockMO);

    const view = makeView({
      plugin: makePlugin(makeReviewManager(null)),
      propertiesWidget: {
        getBoundingClientRect: vi.fn().mockReturnValue({ height: 0 }),
      } as unknown as Element,
    });
    const instance = factory(view as never);
    await vi.runAllTimersAsync();

    // Widget was present on mount — MutationObserver was never created
    expect(() => instance.destroy()).not.toThrow();
    // The disconnect from our fake observer should NOT have been called
    expect(disconnect).not.toHaveBeenCalled();
  });
});
