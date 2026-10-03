// @vitest-environment jsdom
import { ObsidianHelpers } from '#/lib/ObsidianHelpers';
import * as ActionBarExtension from '#/lib/extensions/ActionBarExtension';
import * as ObsidianPdf from '#/lib/pdf/obsidian-pdf';
import ReviewView from '#/views/ReviewView';
import fc from 'fast-check';
import {
  FileView,
  MarkdownView,
  type TFile,
  type WorkspaceLeaf,
} from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerReadingModeActionBar } from './ReadingModeActionBar';

// #region HELPERS

type FakeLeaf = {
  view: MarkdownView & {
    getMode: ReturnType<typeof vi.fn>;
    file: TFile | null;
    previewMode: { containerEl: HTMLElement };
    getViewType: ReturnType<typeof vi.fn>;
  };
};

function makeContainerEl(): HTMLElement {
  return document.createElement('div');
}

function makeMarkdownLeaf(overrides: {
  mode?: string;
  file?: TFile | null;
  containerEl?: HTMLElement;
}): FakeLeaf {
  const containerEl = overrides.containerEl ?? makeContainerEl();
  const view = Object.assign(new (MarkdownView as new () => MarkdownView)(), {
    getMode: vi.fn().mockReturnValue(overrides.mode ?? 'preview'),
    file:
      overrides.file !== undefined
        ? overrides.file
        : ({ path: 'test.md' } as TFile),
    previewMode: { containerEl },
    getViewType: vi.fn().mockReturnValue('markdown'),
  });
  return { view } as unknown as FakeLeaf;
}

type FakePdfLeaf = {
  view: FileView & {
    file: TFile | null;
    contentEl: HTMLElement;
    getViewType: () => string;
  };
};

/** A leaf showing Obsidian's own PDF view, which is a `FileView` of type `pdf`. */
function makePdfLeaf(
  overrides: {
    file?: TFile | null;
    contentEl?: HTMLElement;
    viewType?: string;
  } = {}
): FakePdfLeaf {
  // Abstract in Obsidian's typings, a plain class in the mock
  const view = Object.assign(
    new (FileView as unknown as new () => FileView)(),
    {
      file:
        overrides.file !== undefined
          ? overrides.file
          : ({ path: 'papers/Paper.pdf', extension: 'pdf' } as TFile),
      contentEl: overrides.contentEl ?? makeContainerEl(),
      getViewType: () => overrides.viewType ?? 'pdf',
    }
  );
  return { view } as unknown as FakePdfLeaf;
}

function makeNonMarkdownLeaf(viewType = 'other'): {
  view: { getViewType: ReturnType<typeof vi.fn> };
} {
  return {
    view: { getViewType: vi.fn().mockReturnValue(viewType) },
  };
}

function makePlugin(leaves: Array<FakeLeaf | FakePdfLeaf> = []) {
  const registeredCleanups: Array<() => void> = [];
  const handlers = new Map<string, () => void>();
  const dataChangeListeners = new Set<() => void>();

  const workspace = {
    iterateAllLeaves: vi.fn((cb: (leaf: WorkspaceLeaf) => void) => {
      for (const leaf of leaves) {
        cb(leaf as unknown as WorkspaceLeaf);
      }
    }),
    on: vi.fn((event: string, handler: () => void) => {
      handlers.set(event, handler);
      return Symbol('event-ref');
    }),
    trigger: (event: string) => handlers.get(event)?.(),
    triggerLayoutChange: () => handlers.get('layout-change')?.(),
  };

  const reviewManager = {
    articles: {
      getItemType: vi.fn(
        async (_file: TFile): Promise<string | null> => 'article'
      ),
    },
    repo: {
      onDataChange: vi.fn((listener: () => void) => {
        dataChangeListeners.add(listener);
        return () => dataChangeListeners.delete(listener);
      }),
    },
  };

  return {
    app: { workspace },
    reviewManager,
    registerEvent: vi.fn(),
    register: vi.fn((fn: () => void) => {
      registeredCleanups.push(fn);
    }),
    runCleanup: () => registeredCleanups.forEach((fn) => fn()),
    emitDataChange: () => dataChangeListeners.forEach((fn) => fn()),
    dataChangeListenerCount: () => dataChangeListeners.size,
    _leaves: leaves,
  };
}

/** Lets every pending lookup and the syncs chained on it settle. */
async function flush(): Promise<void> {
  // A macrotask runs only once every queued microtask has, however deep
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A promise with its settle functions, for lookups a test resolves by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function pdfBars(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll('.ir-pdf-leaf-bar'));
}

// #endregion

describe('registerReadingModeActionBar', () => {
  beforeEach(() => {
    vi.spyOn(
      ActionBarExtension,
      'renderStandaloneActionBarDOM'
    ).mockImplementation(() => () => {});
    vi.spyOn(ObsidianHelpers, 'getNoteType').mockResolvedValue('article');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initial syncAll on registration', () => {
    it('calls iterateAllLeaves immediately on registration', () => {
      const plugin = makePlugin([]);
      registerReadingModeActionBar(plugin as never);
      expect(plugin.app.workspace.iterateAllLeaves).toHaveBeenCalledTimes(1);
    });

    it('hands every workspace listener to the plugin to release on unload', () => {
      const plugin = makePlugin([]);
      registerReadingModeActionBar(plugin as never);
      const refs = plugin.app.workspace.on.mock.results.map(
        (r): unknown => r.value
      );
      expect(refs.length).toBeGreaterThan(0);
      expect(
        plugin.registerEvent.mock.calls.map(([ref]): unknown => ref)
      ).toEqual(refs);
    });

    it('stops listening for database changes when the plugin cleanup runs', () => {
      const plugin = makePlugin([]);
      registerReadingModeActionBar(plugin as never);
      expect(plugin.dataChangeListenerCount()).toBe(1);
      plugin.runCleanup();
      expect(plugin.dataChangeListenerCount()).toBe(0);
    });

    it('registers a cleanup callback', () => {
      const plugin = makePlugin([]);
      registerReadingModeActionBar(plugin as never);
      expect(plugin.register).toHaveBeenCalledTimes(1);
    });
  });

  describe('sync() — view is not a MarkdownView instance', () => {
    it('does not mount a bar when the leaf has a non-MarkdownView', () => {
      const leaf = makeNonMarkdownLeaf();
      const plugin = makePlugin([leaf as unknown as FakeLeaf]);
      registerReadingModeActionBar(plugin as never);
      expect(
        ActionBarExtension.renderStandaloneActionBarDOM
      ).not.toHaveBeenCalled();
    });

    it('skips ReviewView leaves entirely (no controller created)', () => {
      const reviewLeaf = makeNonMarkdownLeaf(ReviewView.viewType);
      const plugin = makePlugin([reviewLeaf as unknown as FakeLeaf]);
      registerReadingModeActionBar(plugin as never);
      expect(
        ActionBarExtension.renderStandaloneActionBarDOM
      ).not.toHaveBeenCalled();
    });
  });

  describe('sync() — MarkdownView, wrong mode', () => {
    it('does not mount when view mode is "source" (edit mode)', () => {
      const leaf = makeMarkdownLeaf({ mode: 'source' });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);
      expect(
        ActionBarExtension.renderStandaloneActionBarDOM
      ).not.toHaveBeenCalled();
    });

    it('does not mount when view mode is "live" (live preview)', () => {
      const leaf = makeMarkdownLeaf({ mode: 'live' });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);
      expect(
        ActionBarExtension.renderStandaloneActionBarDOM
      ).not.toHaveBeenCalled();
    });

    it.each(['source', 'live', '', 'other'])(
      'does not mount for mode %j (not "preview")',
      (mode) => {
        vi.spyOn(
          ActionBarExtension,
          'renderStandaloneActionBarDOM'
        ).mockImplementation(() => () => {});
        vi.spyOn(ObsidianHelpers, 'getNoteType').mockResolvedValue('article');
        const leaf = makeMarkdownLeaf({ mode });
        const plugin = makePlugin([leaf]);
        registerReadingModeActionBar(plugin as never);
        expect(
          ActionBarExtension.renderStandaloneActionBarDOM
        ).not.toHaveBeenCalled();
      }
    );
  });

  describe('sync() — MarkdownView in preview, file is null', () => {
    it('does not mount when view.file is null', () => {
      const leaf = makeMarkdownLeaf({ file: null });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);
      expect(
        ActionBarExtension.renderStandaloneActionBarDOM
      ).not.toHaveBeenCalled();
    });
  });

  describe('sync() — MarkdownView in preview, file present, noteType is null', () => {
    it('does not mount when getNoteType returns null', async () => {
      vi.spyOn(ObsidianHelpers, 'getNoteType').mockResolvedValue(null);
      const leaf = makeMarkdownLeaf({});
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);
      await flush();
      expect(
        ActionBarExtension.renderStandaloneActionBarDOM
      ).not.toHaveBeenCalled();
    });
  });

  describe('sync() — happy path: mount', () => {
    it('mounts a bar with correct class names for a valid preview leaf', async () => {
      const containerEl = makeContainerEl();
      const leaf = makeMarkdownLeaf({ containerEl });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);
      await flush();

      expect(
        ActionBarExtension.renderStandaloneActionBarDOM
      ).toHaveBeenCalledOnce();
      const [calledFile, calledPlugin, calledBar] = (
        ActionBarExtension.renderStandaloneActionBarDOM as ReturnType<
          typeof vi.fn
        >
      ).mock.calls[0] as [TFile, unknown, unknown];
      expect(calledFile).toBe(leaf.view.file);
      expect(calledPlugin).toBe(plugin);
      expect(calledBar).toBeInstanceOf(HTMLElement);
      expect((calledBar as HTMLElement).className).toBe(
        'ir-action-bar ir-action-bar-panel ir-reading-mode-bar'
      );
    });

    it('prepends the bar element to the container', async () => {
      const containerEl = makeContainerEl();
      const leaf = makeMarkdownLeaf({ containerEl });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);
      await flush();

      expect(containerEl.firstElementChild?.className).toContain(
        'ir-reading-mode-bar'
      );
    });

    it.each(['article', 'snippet', 'card'] as const)(
      'mounts for NoteType %j',
      async (noteType) => {
        vi.spyOn(
          ActionBarExtension,
          'renderStandaloneActionBarDOM'
        ).mockImplementation(() => () => {});
        vi.spyOn(ObsidianHelpers, 'getNoteType').mockResolvedValue(noteType);
        const containerEl = makeContainerEl();
        const leaf = makeMarkdownLeaf({ containerEl });
        const plugin = makePlugin([leaf]);
        registerReadingModeActionBar(plugin as never);
        await flush();
        expect(
          ActionBarExtension.renderStandaloneActionBarDOM
        ).toHaveBeenCalledOnce();
      }
    );
  });

  describe('mount() — idempotency', () => {
    it('does not mount a second bar if the bar is already in the container', async () => {
      const containerEl = makeContainerEl();
      const leaf = makeMarkdownLeaf({ containerEl });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);
      await flush();

      plugin.app.workspace.triggerLayoutChange();
      await flush();

      // renderStandaloneActionBarDOM should only have been called once (first mount)
      expect(
        ActionBarExtension.renderStandaloneActionBarDOM
      ).toHaveBeenCalledOnce();
    });

    it('re-mounts the bar if it was removed from the container', async () => {
      const containerEl = makeContainerEl();
      const leaf = makeMarkdownLeaf({ containerEl });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);
      await flush();

      // Detach the bar from the DOM to simulate it being removed
      containerEl.innerHTML = '';

      plugin.app.workspace.triggerLayoutChange();
      await flush();

      expect(
        ActionBarExtension.renderStandaloneActionBarDOM
      ).toHaveBeenCalledTimes(2);
    });
  });

  describe('unmount() — bar removal', () => {
    it('removes the bar element from the DOM when unmount is triggered via mode change', async () => {
      const containerEl = makeContainerEl();
      const leaf = makeMarkdownLeaf({ containerEl });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);
      await flush();

      expect(containerEl.children.length).toBe(1);

      leaf.view.getMode.mockReturnValue('source');
      plugin.app.workspace.triggerLayoutChange();
      await flush();

      expect(containerEl.children.length).toBe(0);
    });

    it('removes the bar when view.file becomes null', async () => {
      const containerEl = makeContainerEl();
      const leaf = makeMarkdownLeaf({ containerEl });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);
      await flush();
      expect(containerEl.children.length).toBe(1);

      leaf.view.file = null;
      plugin.app.workspace.triggerLayoutChange();
      await flush();

      expect(containerEl.children.length).toBe(0);
    });

    it('removes the bar when getNoteType changes to null', async () => {
      const containerEl = makeContainerEl();
      const leaf = makeMarkdownLeaf({ containerEl });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);
      await flush();

      vi.spyOn(ObsidianHelpers, 'getNoteType').mockResolvedValue(null);
      plugin.app.workspace.triggerLayoutChange();
      await flush();

      expect(containerEl.children.length).toBe(0);
    });
  });

  describe('layout-change — controller lifecycle', () => {
    it('creates a new controller for a leaf that appears after initial registration', async () => {
      const plugin = makePlugin([]);
      registerReadingModeActionBar(plugin as never);
      await flush();

      const containerEl = makeContainerEl();
      const newLeaf = makeMarkdownLeaf({ containerEl });
      plugin._leaves.push(newLeaf);
      plugin.app.workspace.iterateAllLeaves.mockImplementation(
        (cb: (leaf: WorkspaceLeaf) => void) => {
          for (const l of plugin._leaves) cb(l as unknown as WorkspaceLeaf);
        }
      );
      plugin.app.workspace.triggerLayoutChange();
      await flush();

      expect(
        ActionBarExtension.renderStandaloneActionBarDOM
      ).toHaveBeenCalledOnce();
    });

    it('unmounts and removes controllers for leaves that disappear', async () => {
      const containerEl = makeContainerEl();
      const leaf = makeMarkdownLeaf({ containerEl });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);
      await flush();

      expect(containerEl.children.length).toBe(1);

      plugin._leaves.length = 0;
      plugin.app.workspace.iterateAllLeaves.mockImplementation(
        (cb: (leaf: WorkspaceLeaf) => void) => {
          for (const l of plugin._leaves) cb(l as unknown as WorkspaceLeaf);
        }
      );
      plugin.app.workspace.triggerLayoutChange();
      await flush();

      expect(containerEl.children.length).toBe(0);
    });
  });

  describe('cleanup callback', () => {
    it('mounts nothing for a sweep queued before the cleanup ran', async () => {
      const containerEl = makeContainerEl();
      const plugin = makePlugin([makeMarkdownLeaf({ containerEl })]);
      registerReadingModeActionBar(plugin as never);
      await flush();

      plugin.app.workspace.trigger('file-open');
      plugin.runCleanup();
      await flush();

      expect(containerEl.children).toHaveLength(0);
    });

    it('mounts nothing when asked to re-check after the cleanup ran', async () => {
      const containerEl = makeContainerEl();
      const plugin = makePlugin([makeMarkdownLeaf({ containerEl })]);
      const resync = registerReadingModeActionBar(plugin as never);
      await flush();

      plugin.runCleanup();
      resync();
      await flush();

      expect(containerEl.children).toHaveLength(0);
    });

    it('unmounts all bars when the plugin cleanup runs', async () => {
      const containers = [makeContainerEl(), makeContainerEl()];
      const leaves = containers.map((c) =>
        makeMarkdownLeaf({ containerEl: c })
      );
      const plugin = makePlugin(leaves);
      registerReadingModeActionBar(plugin as never);
      await flush();

      expect(containers[0].children.length).toBe(1);
      expect(containers[1].children.length).toBe(1);

      plugin.runCleanup();

      expect(containers[0].children.length).toBe(0);
      expect(containers[1].children.length).toBe(0);
    });
  });
  describe('which leaves get a bar', () => {
    type ViewKind =
      | 'markdown-preview'
      | 'markdown-source'
      | 'markdown-live'
      | 'pdf'
      | 'other-file-view';
    const itemTypes = ['article', 'snippet', 'card', null] as const;

    it('mounts one bar exactly on reading-mode notes that are items and on PDFs with an article row', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom<ViewKind>(
            'markdown-preview',
            'markdown-source',
            'markdown-live',
            'pdf',
            'other-file-view'
          ),
          fc.boolean(),
          fc.constantFrom(...itemTypes),
          fc.constantFrom(...itemTypes),
          async (kind, hasFile, noteType, itemType) => {
            const render = vi
              .spyOn(ActionBarExtension, 'renderStandaloneActionBarDOM')
              .mockImplementation(() => () => {});
            render.mockClear();
            vi.spyOn(ObsidianHelpers, 'getNoteType').mockResolvedValue(
              noteType
            );
            const container = makeContainerEl();
            const file = hasFile ? ({ path: 'x' } as TFile) : null;
            const leaf = kind.startsWith('markdown')
              ? makeMarkdownLeaf({
                  mode: kind.slice('markdown-'.length),
                  file,
                  containerEl: container,
                })
              : makePdfLeaf({
                  file,
                  contentEl: container,
                  viewType: kind === 'pdf' ? 'pdf' : 'image',
                });
            const plugin = makePlugin([leaf]);
            plugin.reviewManager.articles.getItemType.mockResolvedValue(
              itemType
            );

            registerReadingModeActionBar(plugin as never);
            await flush();

            // A PDF has no frontmatter, so it's only ever typed by its row
            const expected =
              hasFile &&
              ((kind === 'markdown-preview' && noteType !== null) ||
                (kind === 'pdf' && itemType === 'article'));
            expect(container.children.length).toBe(expected ? 1 : 0);
            expect(render).toHaveBeenCalledTimes(expected ? 1 : 0);
            if (expected) {
              expect(render.mock.calls[0][0]).toBe(file);
              expect(render.mock.calls[0][1]).toBe(plugin);
              expect(render.mock.calls[0][2]).toBe(container.firstElementChild);
            }
            plugin.runCleanup();
          }
        )
      );
    });
  });

  describe('PDF leaves', () => {
    it('asks the PDF adapter which views are PDFs', async () => {
      // `obsidian-pdf` is the one place that knows Obsidian's PDF internals,
      // its view type included; whatever it answers is what counts here
      await fc.assert(
        fc.asyncProperty(fc.boolean(), async (isPdf) => {
          const isPdfView = vi
            .spyOn(ObsidianPdf, 'isPdfView')
            .mockReturnValue(isPdf);
          const contentEl = makeContainerEl();
          const leaf = makePdfLeaf({ contentEl });
          const plugin = makePlugin([leaf]);
          plugin.reviewManager.articles.getItemType.mockResolvedValue(
            'article'
          );

          registerReadingModeActionBar(plugin as never);
          await flush();

          expect(isPdfView).toHaveBeenCalledWith(leaf.view);
          expect(pdfBars(contentEl)).toHaveLength(isPdf ? 1 : 0);
          plugin.runCleanup();
          isPdfView.mockRestore();
        })
      );
    });

    it("puts the bar above Obsidian's PDF toolbar and viewer, in the view's content element", async () => {
      const contentEl = makeContainerEl();
      for (const cls of ['pdf-toolbar', 'pdf-container']) {
        const el = document.createElement('div');
        el.className = cls;
        contentEl.append(el);
      }
      const leaf = makePdfLeaf({ contentEl });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);
      await flush();

      expect(Array.from(contentEl.children).map((el) => el.className)).toEqual([
        'ir-action-bar ir-action-bar-panel ir-pdf-leaf-bar',
        'pdf-toolbar',
        'pdf-container',
      ]);
    });

    it("follows the selection in a PDF article's tab from when its bar goes up, and in no other tab", async () => {
      // A button press or the command palette can move the browser's
      // selection out of the PDF before the snippet or card is made of it
      const tabSelection = vi
        .spyOn(ObsidianPdf, 'pdfTabSelection')
        .mockReturnValue(null);
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('article', 'snippet', 'card', null),
          async (type) => {
            tabSelection.mockClear();
            const pdfLeaf = makePdfLeaf();
            // A note in reading mode that is an item, which gets a bar too
            const noteLeaf = makeMarkdownLeaf({});
            const plugin = makePlugin([pdfLeaf, noteLeaf]);
            plugin.reviewManager.articles.getItemType.mockResolvedValue(type);

            registerReadingModeActionBar(plugin as never);
            await flush();

            expect(tabSelection.mock.calls).toEqual(
              type === 'article' ? [[pdfLeaf.view]] : []
            );
            plugin.runCleanup();
          }
        )
      );
    });

    it('looks the file up in the item layer, not by frontmatter', async () => {
      const getNoteType = vi.spyOn(ObsidianHelpers, 'getNoteType');
      const leaf = makePdfLeaf();
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);
      await flush();

      expect(plugin.reviewManager.articles.getItemType).toHaveBeenCalledWith(
        leaf.view.file
      );
      expect(getNoteType).not.toHaveBeenCalled();
    });

    it('drops the bar when the leaf swaps to a PDF that is not an article', async () => {
      const teardown = vi.fn();
      vi.spyOn(
        ActionBarExtension,
        'renderStandaloneActionBarDOM'
      ).mockImplementation(() => teardown);
      const leaf = makePdfLeaf();
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);
      await flush();
      expect(pdfBars(leaf.view.contentEl)).toHaveLength(1);

      leaf.view.file = { path: 'papers/Other.pdf', extension: 'pdf' } as TFile;
      plugin.reviewManager.articles.getItemType.mockResolvedValue(null);
      plugin.app.workspace.trigger('file-open');
      await flush();

      expect(pdfBars(leaf.view.contentEl)).toHaveLength(0);
      expect(teardown).toHaveBeenCalledOnce();
    });

    it('rebuilds the bar for the new file when the leaf swaps to another article', async () => {
      const teardown = vi.fn();
      const render = vi
        .spyOn(ActionBarExtension, 'renderStandaloneActionBarDOM')
        .mockImplementation(() => teardown);
      const leaf = makePdfLeaf();
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);
      await flush();

      const next = { path: 'papers/Next.pdf', extension: 'pdf' } as TFile;
      leaf.view.file = next;
      plugin.app.workspace.trigger('file-open');
      await flush();

      expect(teardown).toHaveBeenCalledOnce();
      expect(render).toHaveBeenCalledTimes(2);
      expect(render.mock.calls[1][0]).toBe(next);
      expect(pdfBars(leaf.view.contentEl)).toHaveLength(1);
    });

    it('adds the bar when a leaf swaps from a plain PDF to an article', async () => {
      const leaf = makePdfLeaf();
      const plugin = makePlugin([leaf]);
      plugin.reviewManager.articles.getItemType.mockResolvedValue(null);
      registerReadingModeActionBar(plugin as never);
      await flush();
      expect(pdfBars(leaf.view.contentEl)).toHaveLength(0);

      leaf.view.file = {
        path: 'papers/Article.pdf',
        extension: 'pdf',
      } as TFile;
      plugin.reviewManager.articles.getItemType.mockResolvedValue('article');
      plugin.app.workspace.trigger('active-leaf-change');
      await flush();

      expect(pdfBars(leaf.view.contentEl)).toHaveLength(1);
    });

    it('catches up with the database once a write makes the open PDF an article', async () => {
      // A rename or an import settles its row after the workspace events for
      // it have fired, so those alone would leave the leaf as it was
      const leaf = makePdfLeaf();
      const plugin = makePlugin([leaf]);
      plugin.reviewManager.articles.getItemType.mockResolvedValue(null);
      registerReadingModeActionBar(plugin as never);
      await flush();

      plugin.reviewManager.articles.getItemType.mockResolvedValue('article');
      plugin.emitDataChange();
      await flush();

      expect(pdfBars(leaf.view.contentEl)).toHaveLength(1);
    });

    it('keeps the one bar across repeated syncs of the same file', async () => {
      const leaf = makePdfLeaf();
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);
      await flush();

      for (const event of [
        'layout-change',
        'file-open',
        'active-leaf-change',
      ]) {
        plugin.app.workspace.trigger(event);
      }
      plugin.emitDataChange();
      await flush();

      expect(pdfBars(leaf.view.contentEl)).toHaveLength(1);
      expect(
        ActionBarExtension.renderStandaloneActionBarDOM
      ).toHaveBeenCalledOnce();
    });
  });

  describe('lookups that settle out of order', () => {
    it('lets the latest sync decide, whatever order the lookups answer in', async () => {
      const stale = deferred<string | null>();
      const leaf = makePdfLeaf();
      const plugin = makePlugin([leaf]);
      plugin.reviewManager.articles.getItemType
        .mockReturnValueOnce(stale.promise)
        .mockResolvedValueOnce(null);
      registerReadingModeActionBar(plugin as never);
      plugin.app.workspace.trigger('file-open');
      await flush();

      stale.resolve('article');
      await flush();

      expect(pdfBars(leaf.view.contentEl)).toHaveLength(0);
    });

    it('mounts nothing for a leaf that closed while its lookup was pending', async () => {
      const pending = deferred<string | null>();
      const leaf = makePdfLeaf();
      const plugin = makePlugin([leaf]);
      plugin.reviewManager.articles.getItemType.mockReturnValueOnce(
        pending.promise
      );
      registerReadingModeActionBar(plugin as never);

      plugin._leaves.length = 0;
      plugin.app.workspace.triggerLayoutChange();
      pending.resolve('article');
      await flush();

      expect(pdfBars(leaf.view.contentEl)).toHaveLength(0);
    });
  });

  describe('markdown file swaps', () => {
    it('rebuilds the reading-mode bar for the new note when the leaf opens another item', async () => {
      const teardown = vi.fn();
      const render = vi
        .spyOn(ActionBarExtension, 'renderStandaloneActionBarDOM')
        .mockImplementation(() => teardown);
      const containerEl = makeContainerEl();
      const leaf = makeMarkdownLeaf({ containerEl });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);
      await flush();

      const next = { path: 'next.md' } as TFile;
      leaf.view.file = next;
      plugin.app.workspace.trigger('file-open');
      await flush();

      expect(teardown).toHaveBeenCalledOnce();
      expect(render.mock.calls.at(-1)?.[0]).toBe(next);
      expect(containerEl.children).toHaveLength(1);
    });
  });
  describe('how often leaves are re-checked', () => {
    it('re-checks each leaf once for events that fire back to back', async () => {
      const getNoteType = vi
        .spyOn(ObsidianHelpers, 'getNoteType')
        .mockResolvedValue('article');
      const pdf = makePdfLeaf();
      const plugin = makePlugin([makeMarkdownLeaf({}), pdf]);
      registerReadingModeActionBar(plugin as never);
      await flush();
      getNoteType.mockClear();
      plugin.reviewManager.articles.getItemType.mockClear();

      for (const event of [
        'active-leaf-change',
        'file-open',
        'layout-change',
      ]) {
        plugin.app.workspace.trigger(event);
      }
      await flush();

      expect(getNoteType).toHaveBeenCalledOnce();
      expect(plugin.reviewManager.articles.getItemType).toHaveBeenCalledOnce();
    });

    it('re-checks again for events that come after a sweep has run', async () => {
      const plugin = makePlugin([makePdfLeaf()]);
      registerReadingModeActionBar(plugin as never);
      await flush();
      plugin.reviewManager.articles.getItemType.mockClear();

      plugin.app.workspace.trigger('file-open');
      await flush();
      plugin.app.workspace.trigger('file-open');
      await flush();

      expect(plugin.reviewManager.articles.getItemType).toHaveBeenCalledTimes(
        2
      );
    });

    it('re-checks only PDF leaves when the database changes', async () => {
      const getNoteType = vi
        .spyOn(ObsidianHelpers, 'getNoteType')
        .mockResolvedValue('article');
      const plugin = makePlugin([makeMarkdownLeaf({}), makePdfLeaf()]);
      registerReadingModeActionBar(plugin as never);
      await flush();
      getNoteType.mockClear();
      plugin.reviewManager.articles.getItemType.mockClear();

      plugin.emitDataChange();
      await flush();

      expect(getNoteType).not.toHaveBeenCalled();
      expect(plugin.reviewManager.articles.getItemType).toHaveBeenCalledOnce();
    });

    it('drops the controller of a leaf that closed, even on a PDF-only re-check', async () => {
      const teardown = vi.fn();
      vi.spyOn(
        ActionBarExtension,
        'renderStandaloneActionBarDOM'
      ).mockImplementation(() => teardown);
      const containerEl = makeContainerEl();
      const plugin = makePlugin([makeMarkdownLeaf({ containerEl })]);
      registerReadingModeActionBar(plugin as never);
      await flush();

      plugin._leaves.length = 0;
      plugin.emitDataChange();

      expect(teardown).toHaveBeenCalledOnce();
      expect(containerEl.children).toHaveLength(0);
    });

    it('re-checks every leaf through the function it returns', async () => {
      const getNoteType = vi
        .spyOn(ObsidianHelpers, 'getNoteType')
        .mockResolvedValue('article');
      const plugin = makePlugin([makeMarkdownLeaf({}), makePdfLeaf()]);
      const resync = registerReadingModeActionBar(plugin as never);
      await flush();
      getNoteType.mockClear();
      plugin.reviewManager.articles.getItemType.mockClear();

      resync();

      expect(getNoteType).toHaveBeenCalledOnce();
      expect(plugin.reviewManager.articles.getItemType).toHaveBeenCalledOnce();
    });
  });

  describe('lookups that fail', () => {
    it('takes the bar down and reports the error when the type lookup throws', async () => {
      const error = new Error('bad frontmatter');
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const containerEl = makeContainerEl();
      const plugin = makePlugin([makeMarkdownLeaf({ containerEl })]);
      registerReadingModeActionBar(plugin as never);
      await flush();
      expect(containerEl.children).toHaveLength(1);

      vi.spyOn(ObsidianHelpers, 'getNoteType').mockRejectedValue(error);
      plugin.app.workspace.trigger('file-open');
      await flush();

      expect(containerEl.children).toHaveLength(0);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('item type'),
        error
      );
    });
  });
});
