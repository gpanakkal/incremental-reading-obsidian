// @vitest-environment jsdom
import { ObsidianHelpers } from '#/lib/ObsidianHelpers';
import { ARTICLE_TAG } from '#/lib/constants';
import * as ActionBarExtension from '#/lib/extensions/ActionBarExtension';
import { ItemManager } from '#/lib/items/ItemManager';
import * as ObsidianPdf from '#/lib/pdf/obsidian-pdf';
import { insertItemAt, makeItemVault, TestRepository } from '#/test/item-vault';
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

  const cacheHandlers = new Map<string, (file: TFile) => void>();
  const metadataCache = {
    on: vi.fn((event: string, handler: (file: TFile) => void) => {
      cacheHandlers.set(event, handler);
      return Symbol('cache-event-ref');
    }),
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
    app: { workspace, metadataCache },
    reviewManager,
    registerEvent: vi.fn(),
    register: vi.fn((fn: () => void) => {
      registeredCleanups.push(fn);
    }),
    runCleanup: () => registeredCleanups.forEach((fn) => fn()),
    emitDataChange: () => dataChangeListeners.forEach((fn) => fn()),
    /** What the cache fires once it has re-indexed `file`. */
    emitMetadataChanged: (file: TFile) => cacheHandlers.get('changed')?.(file),
    dataChangeListenerCount: () => dataChangeListeners.size,
    _leaves: leaves,
  };
}

/** The paths of the files the item layer was asked to type, sorted. */
function lookedUp(plugin: ReturnType<typeof makePlugin>): string[] {
  return plugin.reviewManager.articles.getItemType.mock.calls
    .map(([file]) => file.path)
    .sort();
}

/** The paths of the files `leaves` show, sorted. */
function pathsOf(...leaves: (FakeLeaf | FakePdfLeaf)[]): string[] {
  return leaves.map((leaf) => leaf.view.file!.path).sort();
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

/** Where the row {@link wireItemNote} makes, id `x`, says its note is. */
const ROW_REFERENCE = 'items/note.md';

/**
 * A reading-mode leaf showing a note with `frontmatter`, at the reference of
 * row `x` of `table` or, as a copy, elsewhere, and a plugin whose item layer
 * is a real one over a database holding that row as `row` says (or none).
 */
async function wireItemNote(spec: {
  table: 'article' | 'snippet' | 'srs_card';
  row: 'live' | 'deleted' | 'absent';
  atReference: boolean;
  frontmatter: Record<string, unknown>;
}) {
  const path = spec.atReference ? ROW_REFERENCE : `copies/${ROW_REFERENCE}`;
  const vault = makeItemVault({ [path]: spec.frontmatter });
  const repo = await TestRepository.create();
  if (spec.row !== 'absent') {
    insertItemAt(repo, spec.table, {
      id: 'x',
      reference: ROW_REFERENCE,
      deleted: spec.row === 'deleted',
    });
  }
  const file = vault.files.get(path)!;
  const containerEl = makeContainerEl();
  const plugin = makePlugin([makeMarkdownLeaf({ containerEl, file })]);
  // The note reads as that vault has it, through the plugin's app too
  Object.assign(plugin.app, { vault: vault.app.vault });
  Object.assign(plugin.reviewManager, {
    articles: new ItemManager({ app: vault.app } as never, repo),
  });
  /** Edit the note's frontmatter, as the cache then reports. */
  const editNote = async (edit: (fm: Record<string, unknown>) => void) => {
    await vault.app.fileManager.processFrontMatter(file, edit);
    plugin.emitMetadataChanged(file);
    await flush();
  };
  return { plugin, containerEl, editNote };
}

// #endregion

describe('registerReadingModeActionBar', () => {
  beforeEach(() => {
    vi.spyOn(
      ActionBarExtension,
      'renderStandaloneActionBarDOM'
    ).mockImplementation(() => () => {});
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

    it('hands every workspace and metadata cache listener to the plugin to release on unload', () => {
      const plugin = makePlugin([]);
      registerReadingModeActionBar(plugin as never);
      const refs = [
        ...plugin.app.workspace.on.mock.results,
        ...plugin.app.metadataCache.on.mock.results,
      ].map((r): unknown => r.value);
      expect(plugin.app.workspace.on).toHaveBeenCalled();
      expect(plugin.app.metadataCache.on).toHaveBeenCalled();
      const registered = plugin.registerEvent.mock.calls.map(
        ([ref]): unknown => ref
      );
      expect(registered).toHaveLength(refs.length);
      expect(new Set(registered)).toEqual(new Set(refs));
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
    it('does not mount when the item layer gives the note no type', async () => {
      const leaf = makeMarkdownLeaf({});
      const plugin = makePlugin([leaf]);
      plugin.reviewManager.articles.getItemType.mockResolvedValue(null);
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
        const containerEl = makeContainerEl();
        const leaf = makeMarkdownLeaf({ containerEl });
        const plugin = makePlugin([leaf]);
        plugin.reviewManager.articles.getItemType.mockResolvedValue(noteType);
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

    it('removes the bar when the type changes to none', async () => {
      const containerEl = makeContainerEl();
      const leaf = makeMarkdownLeaf({ containerEl });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);
      await flush();

      plugin.reviewManager.articles.getItemType.mockResolvedValue(null);
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
          async (kind, hasFile, itemType) => {
            const render = vi
              .spyOn(ActionBarExtension, 'renderStandaloneActionBarDOM')
              .mockImplementation(() => () => {});
            render.mockClear();
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

            // Only articles are ever PDFs
            const expected =
              hasFile &&
              ((kind === 'markdown-preview' && itemType !== null) ||
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

    it('leaves following the selection in PDF tabs to the highlights, which do it in every one', async () => {
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

            expect(tabSelection).not.toHaveBeenCalled();
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
      const note = makeMarkdownLeaf({});
      const pdf = makePdfLeaf();
      const plugin = makePlugin([note, pdf]);
      registerReadingModeActionBar(plugin as never);
      await flush();
      plugin.reviewManager.articles.getItemType.mockClear();

      for (const event of [
        'active-leaf-change',
        'file-open',
        'layout-change',
      ]) {
        plugin.app.workspace.trigger(event);
      }
      await flush();

      expect(lookedUp(plugin)).toEqual(pathsOf(note, pdf));
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
      const pdf = makePdfLeaf();
      const plugin = makePlugin([makeMarkdownLeaf({}), pdf]);
      registerReadingModeActionBar(plugin as never);
      await flush();
      plugin.reviewManager.articles.getItemType.mockClear();

      plugin.emitDataChange();
      await flush();

      expect(lookedUp(plugin)).toEqual(pathsOf(pdf));
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
      const note = makeMarkdownLeaf({});
      const pdf = makePdfLeaf();
      const plugin = makePlugin([note, pdf]);
      const resync = registerReadingModeActionBar(plugin as never);
      await flush();
      plugin.reviewManager.articles.getItemType.mockClear();

      resync();

      expect(lookedUp(plugin)).toEqual(pathsOf(note, pdf));
    });
  });

  describe('notes whose metadata changes', () => {
    const noteTypes = ['article', 'snippet', 'card', null] as const;

    it('re-checks a reading-mode note each time the cache re-indexes it, mounting or dropping its bar by the type it has now', async () => {
      // An in-place import gives the note its `ir-id` through the cache alone,
      // with no workspace event to re-check the leaf
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...noteTypes),
          fc.array(fc.constantFrom(...noteTypes), {
            minLength: 1,
            maxLength: 4,
          }),
          async (initial, changes) => {
            const render = vi
              .spyOn(ActionBarExtension, 'renderStandaloneActionBarDOM')
              .mockImplementation(() => () => {});
            render.mockClear();
            const containerEl = makeContainerEl();
            const file = { path: 'note.md' } as TFile;
            const plugin = makePlugin([
              makeMarkdownLeaf({ containerEl, file }),
            ]);
            const { getItemType } = plugin.reviewManager.articles;
            getItemType.mockResolvedValue(initial);
            registerReadingModeActionBar(plugin as never);
            await flush();

            let renders = initial === null ? 0 : 1;
            let previous: (typeof noteTypes)[number] = initial;
            for (const type of changes) {
              getItemType.mockResolvedValue(type);
              plugin.emitMetadataChanged(file);
              await flush();

              expect(containerEl.children).toHaveLength(type === null ? 0 : 1);
              // A note that stays an item keeps the bar it has
              if (previous === null && type !== null) renders++;
              previous = type;
            }
            expect(render).toHaveBeenCalledTimes(renders);
            plugin.runCleanup();
          }
        ),
        // Each change waits out a macrotask; few types, so few runs cover them
        { numRuns: 40 }
      );
    });

    it('re-checks only the leaves showing the re-indexed file, notes and PDFs alike', async () => {
      type Kind = 'markdown-preview' | 'markdown-source' | 'pdf' | 'non-file';
      const files = ['a.md', 'b.md', 'c.pdf'].map(
        (path) => ({ path }) as TFile
      );
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              kind: fc.constantFrom<Kind>(
                'markdown-preview',
                'markdown-source',
                'pdf',
                'non-file'
              ),
              shown: fc.constantFrom(...files),
            }),
            { maxLength: 6 }
          ),
          fc.constantFrom(...files),
          async (specs, changed) => {
            const leaves = specs.map(({ kind, shown }) => {
              if (kind === 'pdf') return makePdfLeaf({ file: shown });
              if (kind === 'non-file') {
                // Holds a file without being a file view, so never shows it
                return {
                  view: { getViewType: () => 'other', file: shown },
                } as unknown as FakeLeaf;
              }
              return makeMarkdownLeaf({
                mode: kind.slice('markdown-'.length),
                file: shown,
              });
            });
            const plugin = makePlugin(leaves);
            registerReadingModeActionBar(plugin as never);
            await flush();
            plugin.reviewManager.articles.getItemType.mockClear();

            plugin.emitMetadataChanged(changed);
            await flush();

            const showing = (kind: Kind) =>
              specs.filter((s) => s.kind === kind && s.shown === changed)
                .length;
            expect(lookedUp(plugin)).toEqual(
              Array<string>(showing('markdown-preview') + showing('pdf')).fill(
                changed.path
              )
            );
            plugin.runCleanup();
          }
        )
      );
    });

    it('mounts nothing when the cache re-indexes a note after the cleanup ran', async () => {
      const containerEl = makeContainerEl();
      const file = { path: 'note.md' } as TFile;
      const plugin = makePlugin([makeMarkdownLeaf({ containerEl, file })]);
      plugin.reviewManager.articles.getItemType.mockResolvedValue(null);
      registerReadingModeActionBar(plugin as never);
      await flush();
      plugin.runCleanup();

      plugin.reviewManager.articles.getItemType.mockResolvedValue('article');
      plugin.emitMetadataChanged(file);
      await flush();

      expect(containerEl.children).toHaveLength(0);
    });
  });

  describe('notes that lost their type tag', () => {
    const tableArb = fc.constantFrom('article', 'snippet', 'srs_card' as const);

    it("shows the bar on a note carrying a live row's ir-id at its reference, and on no tombstone's or copy's", async () => {
      await fc.assert(
        fc.asyncProperty(
          tableArb,
          fc.constantFrom('live', 'deleted', 'absent' as const),
          fc.boolean(),
          async (table, row, atReference) => {
            const { plugin, containerEl } = await wireItemNote({
              table,
              row,
              atReference,
              frontmatter: { 'ir-id': 'x' },
            });

            registerReadingModeActionBar(plugin as never);
            await flush();

            expect(containerEl.children).toHaveLength(
              row === 'live' && atReference ? 1 : 0
            );
            plugin.runCleanup();
          }
        ),
        { numRuns: 30 }
      );
    });

    it('keeps the bar when only the tag comes off a note its row still holds', async () => {
      const { plugin, containerEl, editNote } = await wireItemNote({
        table: 'article',
        row: 'live',
        atReference: true,
        frontmatter: { 'ir-id': 'x', tags: [ARTICLE_TAG] },
      });
      registerReadingModeActionBar(plugin as never);
      await flush();
      const bar = containerEl.firstElementChild;
      expect(bar).not.toBeNull();

      await editNote((fm) => delete fm.tags);

      expect(containerEl.firstElementChild).toBe(bar);
    });

    it('takes the bar down once the ir-id comes off an untagged note', async () => {
      const { plugin, containerEl, editNote } = await wireItemNote({
        table: 'snippet',
        row: 'live',
        atReference: true,
        frontmatter: { 'ir-id': 'x' },
      });
      registerReadingModeActionBar(plugin as never);
      await flush();
      expect(containerEl.children).toHaveLength(1);

      await editNote((fm) => delete fm['ir-id']);

      expect(containerEl.children).toHaveLength(0);
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

      plugin.reviewManager.articles.getItemType.mockRejectedValue(error);
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
