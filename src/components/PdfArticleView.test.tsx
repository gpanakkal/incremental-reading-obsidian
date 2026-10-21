// @vitest-environment jsdom
import * as PdfItemHighlights from '#/lib/extensions/PdfItemHighlights';
import type { PdfOpenResult, PdfViewer } from '#/lib/pdf/obsidian-pdf';
import * as ObsidianPdf from '#/lib/pdf/obsidian-pdf';
import { packPdfPosition, type PdfPosition } from '#/lib/pdf/position';
import { PositionStore } from '#/lib/position-store';
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
 * the test fires by hand, and a real position store over an item row holding
 * `saved` (`null`: `0`, nothing saved). `written` lists every position the
 * store writes to that row.
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
  // Where a link followed in the review tab put an item, until an editor
  // for it listens, as `ReviewView.onArrival` hands it over
  const arrivals = new Map<string, unknown>();
  const positioners = new Map<string, (eState: unknown) => void>();
  const reviewView = {
    containerEl: document.createElement('div'),
    attachPdfViewer: vi.fn(),
    detachPdfViewer: vi.fn(),
    onArrival: vi.fn((id: string, position: (eState: unknown) => void) => {
      if (arrivals.has(id)) {
        const eState = arrivals.get(id);
        arrivals.delete(id);
        position(eState);
      }
      positioners.set(id, position);
      return () => {
        positioners.delete(id);
      };
    }),
  };
  /** Follow a link to `id` at `eState`, as the review tab hands it on. */
  const arrive = (id: string, eState: unknown) => {
    const position = positioners.get(id);
    if (position) position(eState);
    else arrivals.set(id, eState);
  };
  const app = { vault };
  const rows = {
    read: vi.fn((_id: string) =>
      Promise.resolve({ position: saved ?? 0, updatedAt: 0, updatedBy: '' })
    ),
    write: vi.fn((_id: string, _position: number) => Promise.resolve()),
  };
  const positions = new PositionStore({
    storage: { load: () => null, save: () => {} },
    rows,
    deviceId: () => 'device',
  });
  const written = () => rows.write.mock.calls.map(([, position]) => position);
  const plugin = { app, positions };
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
    rows,
    written,
    handlers,
    modify,
    showHighlights,
    stopHighlights,
    arrive,
  };
}

/**
 * Stand in for the adapter's reading position: the viewer is at `at`, the
 * returned `move` reports a view change as pdf.js would, and `resize` one a
 * resize made, there. Putting the view somewhere works when `canSet` says.
 */
function wirePosition(at: PdfPosition | null = null, canSet = true) {
  const watchers = new Set<ObsidianPdf.PdfViewMoves>();
  let current = at;
  vi.spyOn(ObsidianPdf, 'getPdfLocation').mockImplementation(() => current);
  const setPosition = vi
    .spyOn(ObsidianPdf, 'setPdfPosition')
    .mockImplementation((_, position) => {
      if (canSet) current = position;
      return canSet;
    });
  const stop = vi.fn();
  vi.spyOn(ObsidianPdf, 'onPdfViewMove').mockImplementation((_, moves) => {
    watchers.add(moves);
    return () => {
      stop();
      watchers.delete(moves);
    };
  });
  const move = (position: PdfPosition) => {
    current = position;
    for (const moves of watchers) moves.moved(position);
  };
  const resize = (to: PdfPosition | null = current) => {
    current = to;
    for (const moves of watchers) moves.resized();
  };
  return { move, resize, stop, watchers, setPosition };
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
    for (let i = 0; i < 20; i++) await Promise.resolve();
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

/** A PDF link's subpath, in Obsidian's grammar or not. */
const subpathArb = fc.oneof(
  fc
    .tuple(fc.integer({ min: 1, max: 500 }), fc.nat(), fc.nat())
    .map(([page, a, b]) => `#page=${page}&selection=${a},0,${b},4`),
  fc.integer({ min: 1, max: 500 }).map((page) => `#page=${page}`),
  fc.string({ minLength: 1 })
);

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
        const { rows } = wireContext(packPdfPosition(page, top));
        const viewer = makeViewer();
        vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);

        const { unmount } = mount();
        await settle();

        expect(rows.read.mock.calls).toEqual([[item.data.id]]);
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
    const { rows } = wireContext();
    rows.read.mockRejectedValue(new Error('no db'));
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);

    mount();
    await settle();

    expect(viewer.open.mock.calls).toEqual([[file, undefined]]);
  });

  it('opens it at its start when the store fails to answer', async () => {
    const { plugin } = wireContext(AT_PAGE_3);
    vi.spyOn(plugin.positions, 'open').mockReturnValue({
      restore: () => Promise.reject(new Error('broken')),
      set: () => {},
      close: () => {},
    });
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);

    mount();
    await settle();

    expect(viewer.open.mock.calls).toEqual([[file, undefined]]);
  });

  it('never opens it once unmounted before the saved position is read', async () => {
    const { rows } = wireContext();
    let resolveSaved: (value: {
      position: number;
      updatedAt: number;
      updatedBy: string;
    }) => void = () => {};
    rows.read.mockReturnValue(
      new Promise((resolve) => {
        resolveSaved = resolve;
      })
    );
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
    const { unmount } = mount();
    await settle();

    unmount();
    resolveSaved({ position: AT_PAGE_3, updatedAt: 0, updatedBy: '' });
    await settle();

    expect(viewer.open).not.toHaveBeenCalled();
  });

  it('writes nothing to the database as the view moves, and where it rests once it is left', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(positionArb(), { minLength: 1, maxLength: 20 }),
        async (moves) => {
          vi.restoreAllMocks();
          vi.useFakeTimers();
          const { written } = wireContext();
          const { move, stop } = wirePosition();
          const viewer = makeViewer();
          vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
          const { unmount } = mount();
          await settle();

          // A scroll: one report per frame
          for (const position of moves) {
            move(position);
            vi.advanceTimersByTime(16);
          }
          vi.advanceTimersByTime(1000);
          await settle();
          expect(written()).toEqual([]);

          unmount();
          await settle();
          const last = moves[moves.length - 1];
          expect(written()).toEqual([packPdfPosition(last.page, last.top)]);
          expect(stop).toHaveBeenCalledOnce();
          vi.useRealTimers();
        }
      )
    );
  });

  it('writes nothing when the view never moved', async () => {
    const { written } = wireContext(AT_PAGE_3);
    wirePosition();
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
    const { unmount } = mount();
    await settle();

    unmount();
    await settle();

    expect(written()).toEqual([]);
  });

  it('writes nothing when the view comes to rest where it was saved', async () => {
    const { written } = wireContext(AT_PAGE_3);
    const { move } = wirePosition();
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
    const { unmount } = mount();
    await settle();

    // Opened there, pdf.js reports it straight back; and a move that rounds
    // to it is no move either
    move({ page: 3, top: 700 });
    move({ page: 4, top: 10 });
    move({ page: 3, top: 700.4 });
    unmount();
    await settle();

    expect(written()).toEqual([]);
  });

  it('puts the view back where it opened after a resize moves it, and writes nothing for it', async () => {
    await fc.assert(
      fc.asyncProperty(positionArb(), positionArb(), async (stopped, moved) => {
        vi.restoreAllMocks();
        const saved = packPdfPosition(stopped.page, stopped.top);
        const { written } = wireContext(saved);
        const { move, resize, setPosition } = wirePosition();
        const viewer = makeViewer();
        vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
        const { unmount } = mount();
        await settle();
        // Opened there, pdf.js reports it straight back
        move(stopped);

        resize(moved);
        unmount();
        await settle();

        expect(setPosition.mock.calls).toEqual([[viewer, stopped]]);
        expect(written()).toEqual([]);
      })
    );
  });

  it('puts the view back where it opened after a resize before pdf.js reported it there', async () => {
    await fc.assert(
      fc.asyncProperty(positionArb(), positionArb(), async (stopped, moved) => {
        vi.restoreAllMocks();
        const { written } = wireContext(
          packPdfPosition(stopped.page, stopped.top)
        );
        const { resize, setPosition } = wirePosition();
        const viewer = makeViewer();
        vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
        const { unmount } = mount();
        await settle();

        resize(moved);
        unmount();
        await settle();

        expect(setPosition.mock.calls).toEqual([[viewer, stopped]]);
        expect(written()).toEqual([]);
      })
    );
  });

  it("puts the view back at the reader's last move after a resize, and keeps that move", async () => {
    const { written } = wireContext(AT_PAGE_3);
    const { move, resize, setPosition } = wirePosition();
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
    const { unmount } = mount();
    await settle();

    move({ page: 4, top: 10 });
    resize({ page: 4, top: 30 });
    resize({ page: 4, top: 35 });
    unmount();
    await settle();

    expect(setPosition.mock.calls).toEqual([
      [viewer, { page: 4, top: 10 }],
      [viewer, { page: 4, top: 10 }],
    ]);
    expect(written()).toEqual([packPdfPosition(4, 10)]);
  });

  it('keeps where a resize left the view, as a move, when it cannot put it back', async () => {
    const { written } = wireContext(AT_PAGE_3);
    const { move, resize, setPosition } = wirePosition(null, false);
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
    const { unmount } = mount();
    await settle();
    move({ page: 3, top: 700 });

    resize({ page: 3, top: 723 });
    unmount();
    await settle();

    expect(setPosition.mock.calls).toEqual([[viewer, { page: 3, top: 700 }]]);
    expect(written()).toEqual([packPdfPosition(3, 723)]);
  });

  it('keeps where a resize left a view it has no place for yet, as a move', async () => {
    const { written } = wireContext();
    const { resize, setPosition } = wirePosition();
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
    const { unmount } = mount();
    await settle();

    resize({ page: 2, top: 15 });
    unmount();
    await settle();

    expect(setPosition).not.toHaveBeenCalled();
    expect(written()).toEqual([packPdfPosition(2, 15)]);
  });

  it('writes nothing for a resize it can neither undo nor find the view after', async () => {
    const { written } = wireContext();
    const { resize } = wirePosition(null, false);
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
    const { unmount } = mount();
    await settle();

    resize(null);
    unmount();
    await settle();

    expect(written()).toEqual([]);
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
    wireContext(AT_PAGE_3);
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
  });
});

describe('PdfArticleView places a link names', () => {
  it('opens the article at the place a link followed in review names, not where its reader stopped', async () => {
    await fc.assert(
      fc.asyncProperty(
        subpathArb,
        fc.option(positionArb(), { nil: null }),
        async (subpath, saved) => {
          vi.restoreAllMocks();
          const { arrive } = wireContext(
            saved && packPdfPosition(saved.page, saved.top)
          );
          const viewer = makeViewer();
          vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
          arrive(item.data.id, { subpath });

          const { unmount } = mount();
          await settle();

          expect(viewer.open.mock.calls).toEqual([[file, subpath]]);
          unmount();
        }
      )
    );
  });

  it('moves the open article to the place a later link names', async () => {
    await fc.assert(
      fc.asyncProperty(subpathArb, async (subpath) => {
        vi.restoreAllMocks();
        const { arrive } = wireContext(AT_PAGE_3);
        const viewer = makeViewer();
        vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
        const { unmount } = mount();
        await settle();

        arrive(item.data.id, { subpath });
        await settle();

        expect(viewer.open.mock.calls).toEqual([
          [file, '#page=3&offset=0,700'],
          [file, subpath],
        ]);
        unmount();
      })
    );
  });

  it('opens where its reader stopped for a link that names no page', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant(undefined),
          fc.record({ subpath: fc.constant('') }),
          fc.record({ match: fc.anything() }),
          fc.record({ subpath: fc.nat() })
        ),
        async (eState) => {
          vi.restoreAllMocks();
          const { arrive } = wireContext(AT_PAGE_3);
          const viewer = makeViewer();
          vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
          arrive(item.data.id, eState);
          const { unmount } = mount();
          await settle();

          arrive(item.data.id, eState);
          await settle();

          expect(viewer.open.mock.calls).toEqual([
            [file, '#page=3&offset=0,700'],
          ]);
          unmount();
        }
      )
    );
  });

  it('leaves the viewer alone for a link followed once unmounted', async () => {
    const { arrive } = wireContext();
    const viewer = makeViewer();
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);
    const { unmount } = mount();
    await settle();

    unmount();
    arrive(item.data.id, { subpath: '#page=2' });
    await settle();

    expect(viewer.open.mock.calls).toEqual([[file, undefined]]);
  });
});
