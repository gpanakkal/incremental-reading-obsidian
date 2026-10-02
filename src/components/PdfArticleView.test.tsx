// @vitest-environment jsdom
import type { PdfOpenResult, PdfViewer } from '#/lib/pdf/obsidian-pdf';
import * as ObsidianPdf from '#/lib/pdf/obsidian-pdf';
import type { ReviewItem } from '#/lib/types';
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
  } satisfies PdfViewer;
}

type ModifyHandler = (file: TFile) => void;

/**
 * The review context the view reads, over a vault whose `modify` listeners
 * the test fires by hand.
 */
function wireContext() {
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
  vi.spyOn(ReviewContext, 'useReviewContext').mockReturnValue({
    plugin: { app },
    reviewView,
  } as never);
  const modify = (f: TFile) => {
    for (const handler of handlers) handler(f);
  };
  return { app, vault, reviewView, handlers, modify };
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

/** Let the effect's `open` promise settle and re-render. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

// #endregion

afterEach(() => {
  document.body.innerHTML = '';
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
    expect(viewer.open.mock.calls).toEqual([[file]]);
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
    expect(viewer.open.mock.calls).toEqual([[file], [file]]);
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

  it('falls back, and tears the viewer down, when its internals turn out unsupported', async () => {
    const { reviewView, handlers } = wireContext();
    const viewer = makeViewer('unsupported');
    vi.spyOn(ObsidianPdf, 'createPdfViewer').mockReturnValue(viewer);

    const { container } = mount();
    await settle();

    expect(container.querySelector('.fallback')).not.toBeNull();
    expect(container.querySelector('.ir-pdf-article')).toBeNull();
    expect(viewer.unload).toHaveBeenCalledOnce();
    expect(reviewView.detachPdfViewer.mock.calls).toEqual([[viewer]]);
    expect(handlers.size).toBe(0);
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
    expect(viewer.open.mock.calls).toEqual([[file], [other]]);

    settleFirst('unsupported');
    await settle();

    expect(container.querySelector('.ir-pdf-article')).not.toBeNull();
    expect(viewer.unload).not.toHaveBeenCalled();
  });
});
