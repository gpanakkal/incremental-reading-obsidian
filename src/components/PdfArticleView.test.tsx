// @vitest-environment jsdom
import * as PdfItemHighlights from '#/lib/extensions/PdfItemHighlights';
import type { PdfOpenResult, PdfViewer } from '#/lib/pdf/obsidian-pdf';
import * as ObsidianPdf from '#/lib/pdf/obsidian-pdf';
import { packPdfPosition, type PdfPosition } from '#/lib/pdf/position';
import type { ReviewItem } from '#/lib/types';
import fc from 'fast-check';
import { Scope, type TFile } from 'obsidian';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PdfArticleView } from './PdfArticleView';
import * as ReviewContext from './ReviewContext';

// #region HELPERS

const file = { path: 'papers/a.pdf', extension: 'pdf' } as TFile;
const item = { data: { id: 'a1', type: 'article' }, file } as ReviewItem;

/** A viewer whose `open` settles as the test says, default `'loaded'`. */
function makeViewer(openResult: PdfOpenResult = 'loaded') {
  const containerEl = document.createElement('div');
  containerEl.className = 'ir-pdf-viewer';
  return {
    containerEl,
    scope: new Scope(),
    load: vi.fn(),
    unload: vi.fn(),
    open: vi.fn(() => Promise.resolve(openResult)),
    showSearch: vi.fn(),
    selectedText: vi.fn(() => ''),
    selection: vi.fn(() => null),
    clearSelection: vi.fn(),
    pdfDocument: vi.fn(() => null),
    visiblePages: vi.fn(() => []),
  } satisfies PdfViewer;
}

type ModifyHandler = (file: TFile) => void;

/**
 * The review context the view reads, over a vault whose `modify` listeners
 * the test fires by hand.
 */
function wireContext(saved: number | null = null) {
  const handlers = new Set<ModifyHandler>();
  const vault = {
    on: vi.fn((name: string, handler: ModifyHandler) => {
      expect(name).toBe('modify');
      handlers.add(handler);
      return handler;
    }),
    offref: vi.fn((ref: ModifyHandler) => handlers.delete(ref)),
  };
  const reviewView = {
    containerEl: document.createElement('div'),
    attachPdfViewer: vi.fn(),
    detachPdfViewer: vi.fn(),
  };
  const app = { vault };
  const reviewManager = {
    loadScrollPosition: vi.fn((_: TFile) => Promise.resolve(saved)),
    saveScrollPosition: vi.fn((_: TFile, __: number) => Promise.resolve()),
  };
  const plugin = { app, reviewManager };
  vi.spyOn(ReviewContext, 'useReviewContext').mockReturnValue({
    plugin,
    reviewView,
  } as never);
  const stopHighlights = vi.fn();
  const showHighlights = vi
    .spyOn(PdfItemHighlights, 'showPdfItemHighlights')
    .mockReturnValue(stopHighlights);
  const modify = (f: TFile) => {
    for (const handler of handlers) handler(f);
  };
  return {
    app,
    plugin,
    vault,
    reviewView,
    reviewManager,
    handlers,
    modify,
    showHighlights,
    stopHighlights,
  };
}

/**
 * Stand in for the adapter's reading position: the viewer is at `at`, and
 * the returned `move` reports a view change as pdf.js would.
 */
function wirePosition(at: PdfPosition | null = null) {
  const listeners = new Set<(position: PdfPosition) => void>();
  let current = at;
  vi.spyOn(ObsidianPdf, 'getPdfLocation').mockImplementation(() => current);
  const stop = vi.fn();
  vi.spyOn(ObsidianPdf, 'onPdfViewChange').mockImplementation((_, listener) => {
    listeners.add(listener);
    return () => {
      stop();
      listeners.delete(listener);
    };
  });
  const move = (position: PdfPosition) => {
    current = position;
    for (const listener of listeners) listener(position);
  };
  return { move, stop, listeners };
}

function mount(): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  void act(() => {
    render(
      <PdfArticleView
        item={item}
        fallback={<p className="fallback">Open in PDF tab</p>}
      />,
      container
    );
  });
  return {
    container,
    unmount: () => {
      void act(() => render(null, container));
    },
  };
}

/**
 * Let the effect's promises — the saved position, then `open` — settle and
 * re-render. Microtasks only, so it works under fake timers too.
 */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

/** Page 3, 700 points up from its bottom edge, packed. */
const AT_PAGE_3 = packPdfPosition(3, 700);

/** The positions a packed `scroll_top` can hold, and a few more. */
const positionArb = () =>
  fc.record({
    page: fc.integer({ min: 1, max: 100000 }),
    top: fc.integer({ min: 0, max: 99999 }),
  });

// #endregion

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PdfArticleView', () => {
  it("shows the fallback when Obsidian's viewer can't be built", () => {
    const { reviewView, vault } = wireContext();
    const create = vi
      .spyOn(ObsidianPdf, 'createPdfViewer')
      .mockReturnValue(null);

    const { container } = mount();

    expect(create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ vault })
    );
    expect(container.querySelector('.fallback')).not.toBeNull();
    expect(container.querySelector('.ir-pdf-article')).toBeNull();
    expect(reviewView.attachPdfViewer).not.toHaveBeenCalled();
    expect(vault.on).not.toHaveBeenCalled();
  });

  it('mounts the viewer, loads the item into it, and hands it to the review tab', async () => {
    const { reviewView } = wireContext();
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);

    const { container } = mount();
    await settle();

    const host = container.querySelector('.ir-pdf-article');
    expect(host?.firstElementChild).toBe(viewer.containerEl);
    expect(viewer.load).toHaveBeenCalledOnce();
    expect(viewer.open.mock.calls).toEqual([[file, undefined]]);
    // Loaded before it is opened, and attached first so `open` can see it shown
    expect(viewer.load.mock.invocationCallOrder[0]).toBeLessThan(
      viewer.open.mock.invocationCallOrder[0]
    );
    expect(reviewView.attachPdfViewer.mock.calls).toEqual([[viewer]]);
    expect(container.querySelector('.fallback')).toBeNull();
  });

  it('reloads the file when it changes on disk, and only that file', async () => {
    const { modify } = wireContext();
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
    mount();
    await settle();

    modify({ path: 'papers/other.pdf', extension: 'pdf' } as TFile);
    expect(viewer.open).toHaveBeenCalledTimes(1);

    modify(file);
    expect(viewer.open.mock.calls).toEqual([
      [file, undefined],
      [file, undefined],
    ]);
  });

  it('leaves no viewer, scope, or listener behind when unmounted', async () => {
    const { reviewView, vault, handlers } = wireContext();
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
    const { container, unmount } = mount();
    await settle();

    unmount();

    expect(viewer.unload).toHaveBeenCalledOnce();
    expect(reviewView.detachPdfViewer.mock.calls).toEqual([[viewer]]);
    expect(vault.offref).toHaveBeenCalledOnce();
    expect(handlers.size).toBe(0);
    expect(viewer.containerEl.isConnected).toBe(false);
    expect(container.innerHTML).toBe('');
  });

  it("highlights its snippets' passages on the viewer's pages, until unmounted", async () => {
    const { plugin, showHighlights, stopHighlights } = wireContext();
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
    const { unmount } = mount();
    await settle();

    expect(showHighlights.mock.calls).toEqual([
      [plugin, file, viewer.containerEl],
    ]);
    expect(stopHighlights).not.toHaveBeenCalled();
    unmount();
    expect(stopHighlights).toHaveBeenCalledOnce();
  });

  it('highlights nothing when it falls back', async () => {
    const { showHighlights, stopHighlights } = wireContext();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(null);
    mount();
    await settle();

    expect(showHighlights).not.toHaveBeenCalled();
    expect(stopHighlights).not.toHaveBeenCalled();
  });

  it('falls back, and tears the viewer down, when its internals turn out unsupported', async () => {
    const { reviewView, handlers, stopHighlights } = wireContext();
    const viewer = makeViewer('unsupported');
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);

    const { container } = mount();
    await settle();

    expect(container.querySelector('.fallback')).not.toBeNull();
    expect(container.querySelector('.ir-pdf-article')).toBeNull();
    expect(viewer.unload).toHaveBeenCalledOnce();
    expect(reviewView.detachPdfViewer.mock.calls).toEqual([[viewer]]);
    expect(handlers.size).toBe(0);
    expect(stopHighlights).toHaveBeenCalledOnce();
  });

  it.each<PdfOpenResult>(['loaded', 'cancelled'])(
    'keeps the viewer when an open ends %s',
    async (result) => {
      wireContext();
      const viewer = makeViewer(result);
      vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);

      const { container } = mount();
      await settle();

      expect(container.querySelector('.ir-pdf-article')).not.toBeNull();
      expect(viewer.unload).not.toHaveBeenCalled();
    }
  );

  it('ignores how an open for a file it has moved on from ends', async () => {
    wireContext();
    const viewer = makeViewer();
    let settleFirst: (result: PdfOpenResult) => void = () => {};
    viewer.open.mockReturnValueOnce(
      new Promise((resolve) => {
        settleFirst = resolve;
      })
    );
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
    const { container } = mount();
    await settle();

    // The same item, its file now another: the viewer opens that one instead
    const other = { path: 'papers/b.pdf', extension: 'pdf' } as TFile;
    void act(() => {
      render(
        <PdfArticleView
          item={{ ...item, file: other }}
          fallback={<p className="fallback">Open in PDF tab</p>}
        />,
        container
      );
    });
    await settle();
    expect(viewer.open.mock.calls).toEqual([
      [file, undefined],
      [other, undefined],
    ]);

    settleFirst('unsupported');
    await settle();

    expect(container.querySelector('.ir-pdf-article')).not.toBeNull();
    expect(viewer.unload).not.toHaveBeenCalled();
  });
});

describe('PdfArticleView reading position', () => {
  it('opens the item where its reader stopped', async () => {
    await fc.assert(
      fc.asyncProperty(positionArb(), async ({ page, top }) => {
        vi.restoreAllMocks();
        const { reviewManager } = wireContext(packPdfPosition(page, top));
        const viewer = makeViewer();
        vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);

        const { unmount } = mount();
        await settle();

        expect(reviewManager.loadScrollPosition.mock.calls).toEqual([[file]]);
        expect(viewer.open.mock.calls).toEqual([
          [file, `#page=${page}&offset=0,${top}`],
        ]);
        unmount();
      })
    );
  });

  it.each([null, 0, 99999])(
    'opens it at its start when %s is saved',
    async (saved) => {
      wireContext(saved);
      const viewer = makeViewer();
      vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);

      mount();
      await settle();

      expect(viewer.open.mock.calls).toEqual([[file, undefined]]);
    }
  );

  it('opens it at its start when the saved position cannot be read', async () => {
    const { reviewManager } = wireContext();
    reviewManager.loadScrollPosition.mockRejectedValue(new Error('no db'));
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);

    mount();
    await settle();

    expect(viewer.open.mock.calls).toEqual([[file, undefined]]);
  });

  it('never opens it once unmounted before the saved position is read', async () => {
    const { reviewManager } = wireContext();
    let resolveSaved: (value: number | null) => void = () => {};
    reviewManager.loadScrollPosition.mockReturnValue(
      new Promise((resolve) => {
        resolveSaved = resolve;
      })
    );
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
    const { unmount } = mount();
    await settle();

    unmount();
    resolveSaved(AT_PAGE_3);
    await settle();

    expect(viewer.open).not.toHaveBeenCalled();
  });

  it('saves where the view comes to rest, once it has rested a while', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(positionArb(), { minLength: 1, maxLength: 20 }),
        async (moves) => {
          vi.restoreAllMocks();
          vi.useFakeTimers();
          const { reviewManager } = wireContext();
          const { move } = wirePosition();
          const viewer = makeViewer();
          vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
          const { unmount } = mount();
          await settle();

          // A scroll: one report per frame, never a long enough pause
          for (const position of moves) {
            move(position);
            vi.advanceTimersByTime(499);
          }
          expect(reviewManager.saveScrollPosition).not.toHaveBeenCalled();

          vi.advanceTimersByTime(1);
          const last = moves[moves.length - 1];
          expect(reviewManager.saveScrollPosition.mock.calls).toEqual([
            [file, packPdfPosition(last.page, last.top)],
          ]);

          // Leaving it at rest saves nothing more
          unmount();
          expect(reviewManager.saveScrollPosition).toHaveBeenCalledOnce();
          vi.useRealTimers();
        }
      )
    );
  });

  it('saves a position not yet saved when the item is left', async () => {
    vi.useFakeTimers();
    const { reviewManager } = wireContext();
    const { move, stop } = wirePosition();
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
    const { unmount } = mount();
    await settle();

    move({ page: 3, top: 700 });
    unmount();

    expect(reviewManager.saveScrollPosition.mock.calls).toEqual([
      [file, AT_PAGE_3],
    ]);
    expect(stop).toHaveBeenCalledOnce();
    // and not again once the delay is up
    vi.advanceTimersByTime(1000);
    expect(reviewManager.saveScrollPosition).toHaveBeenCalledOnce();
  });

  it('saves nothing when the view never moved', async () => {
    vi.useFakeTimers();
    const { reviewManager } = wireContext(AT_PAGE_3);
    wirePosition();
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
    const { unmount } = mount();
    await settle();

    vi.advanceTimersByTime(1000);
    unmount();

    expect(reviewManager.saveScrollPosition).not.toHaveBeenCalled();
  });

  it('saves nothing when the view comes to rest where it was saved', async () => {
    vi.useFakeTimers();
    const { reviewManager } = wireContext(AT_PAGE_3);
    const { move } = wirePosition();
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
    const { unmount } = mount();
    await settle();

    // Opened there, pdf.js reports it straight back; a resize does too
    move({ page: 3, top: 700 });
    vi.advanceTimersByTime(1000);
    move({ page: 3, top: 700.4 });
    unmount();

    expect(reviewManager.saveScrollPosition).not.toHaveBeenCalled();
  });

  it('saves a position again only once it differs from the last one saved', async () => {
    vi.useFakeTimers();
    const { reviewManager } = wireContext();
    const { move } = wirePosition();
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
    const { unmount } = mount();
    await settle();

    for (const position of [
      { page: 3, top: 700 },
      { page: 3, top: 700 },
      { page: 4, top: 10 },
      { page: 3, top: 700 },
    ]) {
      move(position);
      vi.advanceTimersByTime(500);
    }
    unmount();

    expect(reviewManager.saveScrollPosition.mock.calls).toEqual([
      [file, AT_PAGE_3],
      [file, packPdfPosition(4, 10)],
      [file, AT_PAGE_3],
    ]);
  });

  it('warns, rather than failing, when a position cannot be saved', async () => {
    const { reviewManager } = wireContext();
    const error = new Error('database closed');
    reviewManager.saveScrollPosition.mockRejectedValue(error);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { move } = wirePosition();
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
    const { unmount } = mount();
    await settle();

    move({ page: 3, top: 700 });
    unmount();
    await settle();

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Incremental Reading: PDF position not saved',
      error
    );
  });

  it('reloads a file changed on disk where its reader is', async () => {
    const { modify } = wireContext(AT_PAGE_3);
    const { move } = wirePosition();
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
    mount();
    await settle();

    move({ page: 5, top: 120 });
    modify(file);

    expect(viewer.open.mock.calls).toEqual([
      [file, '#page=3&offset=0,700'],
      [file, '#page=5&offset=0,120'],
    ]);
  });

  it('reloads a file changed before its view moved where it first opened', async () => {
    const { modify } = wireContext(AT_PAGE_3);
    wirePosition();
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
    mount();
    await settle();

    modify(file);

    expect(viewer.open.mock.calls).toEqual([
      [file, '#page=3&offset=0,700'],
      [file, '#page=3&offset=0,700'],
    ]);
  });

  it('keeps its place, rather than the saved one, when its file is swapped under it', async () => {
    const { reviewManager } = wireContext(AT_PAGE_3);
    const { move } = wirePosition();
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
    const { container } = mount();
    await settle();
    move({ page: 5, top: 120 });

    const renamed = { path: 'papers/b.pdf', extension: 'pdf' } as TFile;
    void act(() => {
      render(
        <PdfArticleView
          item={{ ...item, file: renamed }}
          fallback={<p className="fallback">Open in PDF tab</p>}
        />,
        container
      );
    });
    await settle();

    expect(viewer.open.mock.calls).toEqual([
      [file, '#page=3&offset=0,700'],
      [renamed, '#page=5&offset=0,120'],
    ]);
    expect(reviewManager.loadScrollPosition).toHaveBeenCalledOnce();
  });
});
