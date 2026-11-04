// @vitest-environment jsdom
import {
  ARTICLE_TAG,
  CARD_TAG,
  DISMISS_ICON_STROKE,
  PLUGIN_ICON,
  SNIPPET_TAG,
} from '#/lib/constants';
import { ItemManager } from '#/lib/items/ItemManager';
import { configureSuccessNotices } from '#/lib/notices';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { registerPluginIcon } from '#/lib/plugin-icon';
import { ActionRefusedError } from '#/lib/readiness';
import type {
  DataChangeEvent,
  DataChangeListener,
  IArticleBase,
  NoteType,
  ReviewItem,
} from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import { Notice, removeIcon } from '#/test/__mocks__/obsidian';
import {
  insertItemAt,
  makeItemVault,
  TestRepository,
  trackChangeListeners,
} from '#/test/item-vault';
import {
  applyRowWrite,
  itemOfNote,
  type RowWrite,
  rowWriteArb,
  storedArticleAt,
} from '#/test/row-writes';
import {
  showSuccessNotices,
  SUCCESS_NOTICE_LEVELS,
} from '#/test/success-notices';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import fc from 'fast-check';
import {
  type CachedMetadata,
  type MarkdownFileInfo,
  type TFile,
} from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  actionBarExtension,
  renderStandaloneActionBarDOM,
  ROWS_RELOADED_EVENT,
  setReviewCallbacks,
  setReviewModeEffect,
  setShowAnswerEffect,
} from './ActionBarExtension';
import { irPluginFacet } from './irPluginFacet';

// #region HELPERS

type ItemVault = ReturnType<typeof makeItemVault>;

/**
 * Obsidian adds these to `HTMLElement` at runtime and jsdom has neither. The
 * panel path calls both, so this file installs them for itself rather than in
 * the shared setup, where they would silently change every other suite.
 */
function installObsidianElementExtensions() {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.empty = function empty(this: HTMLElement) {
    this.replaceChildren();
  };
  proto.hasClass = function hasClass(this: HTMLElement, cls: string) {
    return this.classList.contains(cls);
  };
}
installObsidianElementExtensions();

/** A row as the standalone bar reads it: only `id` and `dismissed` are used. */
function makeItem(overrides: {
  id?: string;
  dismissed?: boolean;
  file?: TFile;
}): ReviewItem {
  const file = overrides.file ?? makeFile();
  return {
    data: {
      id: overrides.id ?? 'item-1',
      type: 'article',
      dismissed: overrides.dismissed ?? false,
      priority: 50,
      reference: file.path,
    } as IArticleBase,
    file,
  };
}

function makeFile(path = 'notes/article.md'): TFile {
  return { path, basename: path.split('/').pop() } as TFile;
}

/**
 * A plugin whose `reviewManager` reads one mutable row, so a test can change
 * the stored state the way another surface would and then emit the repository
 * change event that write would have produced.
 */
function makeHarness(
  options: {
    item?: ReviewItem | null;
    lookupRejects?: boolean;
  } = {}
) {
  const listeners = new Set<DataChangeListener>();
  let row: ReviewItem | null =
    options.item === undefined ? makeItem({}) : options.item;

  const getReviewItemFromFile = vi.fn(async (): Promise<ReviewItem | null> => {
    if (options.lookupRejects) throw new Error('db unavailable');
    return row;
  });

  const reviewManager = {
    getReviewItemFromFile,
    dismissItem: vi.fn(async (item: ReviewItem) => {
      setStored(item.data.id, true);
    }),
    unDismissItem: vi.fn(async (item: ReviewItem) => {
      setStored(item.data.id, false);
    }),
    repo: {
      onDataChange: vi.fn((listener: DataChangeListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    },
  };

  /** Write `dismissed` straight to the row, as any other surface would. */
  function setStored(id: string, dismissed: boolean) {
    if (row && row.data.id === id) row.data.dismissed = dismissed;
  }

  /** Fire the change event the repository emits after such a write. */
  function emit(event: Partial<DataChangeEvent> & { ids: string[] }) {
    const full: DataChangeEvent = {
      table: event.table ?? 'article',
      op: event.op ?? 'update',
      ids: event.ids,
    };
    for (const listener of [...listeners]) listener(full);
  }

  return {
    plugin: { reviewManager } as unknown as IncrementalReadingPlugin,
    reviewManager,
    setStored,
    emit,
    listenerCount: () => listeners.size,
    setRow: (next: ReviewItem | null) => {
      row = next;
    },
  };
}

/**
 * Flush the pending microtask chains the bar kicked off. Every await under test
 * settles on an already-resolved promise, so draining the microtask queue is
 * enough — and unlike a `setTimeout` hop it stays cheap across a property's
 * hundreds of runs.
 */
const tick = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

/** A promise with its settle functions, for reads a test lands by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const buttons = (container: HTMLElement) =>
  [...container.querySelectorAll('button')] as HTMLButtonElement[];

const dismissButton = (container: HTMLElement) => buttons(container)[0];

const reviewButton = (container: HTMLElement) => buttons(container)[1];

/** The `<svg>` Obsidian's `setIcon` put in a button, if any. */
const iconSvg = (btn: Element) => btn.querySelector(':scope > svg.svg-icon');

/**
 * The icon a button shows, by its id without any `lucide-` prefix, or null for
 * a text-only button. Tests tell buttons apart by this, not by their wording.
 */
const iconName = (btn: Element) =>
  [...(iconSvg(btn)?.classList ?? [])]
    .find((c) => c !== 'svg-icon')
    ?.replace(/^lucide-/, '') ?? null;

/** The toggle's icon while a click would dismiss the item. */
const DISMISS = 'ban';
/** The toggle's icon while a click would restore a dismissed item. */
const RESTORE = 'archive-restore';

/** The Lucide icon a button shows, by its `lucide-*` class, or null. */
const iconOf = (btn: Element) =>
  [...(iconSvg(btn)?.classList ?? [])].find((c) => c.startsWith('lucide-')) ??
  null;

/** What the toggle shows: its icon, or `'status'` for plain status text. */
const faceOf = (btn: Element) =>
  btn.classList.contains('ir-action-bar-status') ? 'status' : iconName(btn);

/**
 * The face the toggle owes an item stored as `dismissed`: the action a click
 * would take on it, or status text for a note no live row holds (`null`).
 */
const faceFor = (dismissed: boolean | null) =>
  dismissed === null ? 'status' : dismissed ? RESTORE : DISMISS;

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

/** What the metadata cache calls its `changed` listeners with. */
type MetadataChangedListener = (
  file: TFile,
  data: string,
  cache: CachedMetadata
) => void;

/** Editors mounted by {@link mountPanel}, torn down after each test. */
const mountedViews: EditorView[] = [];

/**
 * Mount the real CodeMirror panel the edit-mode bar lives in, so the teardown
 * plumbing around it is exercised rather than described.
 *
 * `getFileInfoFromState` is stubbed because the mocked `obsidian` module has no
 * real editor-info state fields, so the extension would otherwise see no file
 * and never build a panel at all.
 */
function mountPanel(
  harness: ReturnType<typeof makeHarness>,
  options: {
    providePlugin?: boolean;
    /** What reading the note's type answers; `'article'` by default. */
    noteType?: () => Promise<NoteType | null>;
    /**
     * A real item layer to type the note through instead, over `vault`, which
     * holds the note at `path`.
     */
    items?: { manager: ItemManager; vault: ItemVault; path: string };
    /**
     * The `ir-id` the note claims, short of a real item layer, whose row the
     * bar then watches through `harness`'s change events. None by default.
     */
    claims?: string;
  } = {}
) {
  const file = options.items
    ? options.items.vault.files.get(options.items.path)!
    : makeFile();
  /** The `changed` listener the bar holds on the metadata cache, if any. */
  let onChanged: MetadataChangedListener | null = null;
  /** The file at each path, as the vault has it. */
  const vaultFiles =
    options.items?.vault.files ?? new Map<string, TFile>([[file.path, file]]);
  // Over a real item layer, the note reads as that vault has it
  const itemApp = options.items?.vault.app;
  /** The workspace events listened for, by name. */
  const workspaceListeners = new Map<string, Set<() => void>>();
  const app = {
    ...itemApp,
    isMobile: false,
    workspace: {
      on: vi.fn((name: string, listener: () => void) => {
        const named = workspaceListeners.get(name) ?? new Set();
        named.add(listener);
        workspaceListeners.set(name, named);
        return { name, listener };
      }),
      offref: vi.fn((ref: { name: string; listener: () => void }) => {
        workspaceListeners.get(ref.name)?.delete(ref.listener);
      }),
      trigger: (name: string) => {
        for (const listener of [...(workspaceListeners.get(name) ?? [])]) {
          listener();
        }
      },
    },
    vault: itemApp?.vault ?? {
      getFileByPath: (path: string) => vaultFiles.get(path) ?? null,
    },
    metadataCache: {
      getFileCache: () => null,
      ...itemApp?.metadataCache,
      on: vi.fn((_name: string, listener: MetadataChangedListener) => {
        onChanged = listener;
        return {};
      }),
      offref: vi.fn(),
    },
  };
  const parent = document.createElement('div');
  document.body.appendChild(parent);

  let view: EditorView | null = null;
  let info: MarkdownFileInfo | null = {
    file,
    app,
  } as unknown as MarkdownFileInfo;
  vi.spyOn(Obsidian, 'getFileInfoFromState').mockImplementation(() => ({
    info,
    editorView: view,
  }));
  // Short of a real item layer, one with no rows: a note is typed by what
  // reading it answers, and a change by the tags the cache parsed
  const getItemType = vi.fn(
    options.noteType ?? (async (): Promise<NoteType | null> => 'article')
  );
  const articles = options.items?.manager ?? {
    getItemType,
    // A note the cache has no parse of, as it has none here short of a
    // reported change, is typed by reading it again
    itemTypeFromCache: (changed: TFile, cache: CachedMetadata | null) =>
      cache === null
        ? getItemType()
        : Obsidian.noteTypeFromCache(changed, cache, app as never),
    // With no rows, no note is typed by one: it claims only what it is given
    typingRowId: () => options.claims ?? null,
    watchRow: (id: string, onWrite: () => void) =>
      harness.reviewManager.repo.onDataChange(({ ids }) => {
        if (ids.includes(id)) onWrite();
      }),
  };
  Object.assign(harness.reviewManager, { articles });

  view = new EditorView({
    state: EditorState.create({
      doc: 'note body',
      extensions: [
        ...(options.providePlugin === false
          ? []
          : [irPluginFacet.of(harness.plugin)]),
        actionBarExtension,
      ],
    }),
    parent,
  });
  mountedViews.push(view);

  return {
    view,
    file,
    app,
    getItemType: articles.getItemType as ReturnType<typeof vi.fn>,
    /**
     * Report a change to `changed` (the open file by default) whose parse has
     * `frontmatter`, as the metadata cache does once it has read the new text.
     */
    reportChange: (
      frontmatter: Record<string, unknown> | undefined,
      changed: TFile = file
    ) => onChanged?.(changed, '', frontmatter ? { frontmatter } : {}),
    /**
     * Show `other` in this editor instead, as a leaf opening another note
     * does, then run a transaction for the bar to see it by.
     */
    switchTo: (other: TFile) => {
      vaultFiles.set(other.path, other);
      info = { file: other, app } as unknown as MarkdownFileInfo;
      view?.dispatch({ changes: { from: 0, insert: ' ' } });
    },
    /** How many listeners the workspace event `name` has. */
    workspaceListenerCount: (name: string) =>
      workspaceListeners.get(name)?.size ?? 0,
    /** Take the open file out of the vault, as a delete does. */
    dropFromVault: () => vaultFiles.delete(file.path),
    /** The bar on screen, if any. */
    bar: () => parent.querySelector('.ir-action-bar'),
    /** Whether the bar is on screen. */
    hasBar: () => parent.querySelector('.ir-action-bar') !== null,
    /** Drop the file info, as a detached editor would. */
    clearInfo: () => {
      info = null;
    },
    barButtons: () =>
      [...parent.querySelectorAll('.ir-action-bar button')].map(iconName),
    /** The CodeMirror panel slot the bar was mounted into. */
    host: () => parent.querySelector('.ir-action-bar-host'),
    topSlotBar: () => parent.querySelector('.cm-panels-top .ir-action-bar'),
  };
}

/** Where the row {@link wireItemNote} makes, id `x`, says its note is. */
const ROW_REFERENCE = 'items/note.md';

/**
 * An editor showing a note with `frontmatter`, at the reference of row `x` of
 * `table` or, as a copy, elsewhere, typed through a real item layer over a
 * database holding that row as `row` says (or none).
 */
async function wireItemNote(spec: {
  table: 'article' | 'snippet' | 'srs_card';
  row: 'live' | 'deleted' | 'absent';
  atReference: boolean;
  frontmatter: Record<string, unknown>;
  /** Other notes in the vault, by path, with their frontmatter. */
  others?: Record<string, Record<string, unknown>>;
  /**
   * Whether the bar reads the note's item from that database, as the plugin
   * does, rather than from a stand-in row that is always there.
   */
  realLookup?: boolean;
}) {
  const path = spec.atReference ? ROW_REFERENCE : `copies/${ROW_REFERENCE}`;
  const vault = makeItemVault({ ...spec.others, [path]: spec.frontmatter });
  const repo = await TestRepository.create();
  if (spec.row !== 'absent') {
    insertItemAt(repo, spec.table, {
      id: 'x',
      reference: ROW_REFERENCE,
      deleted: spec.row === 'deleted',
    });
  }
  const manager = new ItemManager({ app: vault.app } as never, repo);
  const harness = makeHarness();
  if (spec.realLookup) {
    harness.reviewManager.getReviewItemFromFile.mockImplementation(
      (...args: unknown[]) => itemOfNote(manager, args[0] as TFile)
    );
  }
  const panel = mountPanel(harness, {
    items: { manager, vault, path },
  });
  /** Edit the note's frontmatter, then report the change as the cache does. */
  const editNote = async (edit: (fm: Record<string, unknown>) => void) => {
    await vault.app.fileManager.processFrontMatter(panel.file, edit);
    panel.reportChange(
      vault.app.metadataCache.getFileCache(panel.file)?.frontmatter
    );
  };
  return { panel, repo, manager, vault, editNote, harness };
}

/**
 * Assert `btn` shows the review bar's dismiss or restore icon — whichever
 * names the action a click would take on an item stored as `dismissed` — in
 * the same amber stroke, with the old text label kept as its name.
 */
function expectDismissFace(btn: HTMLButtonElement, dismissed: boolean) {
  expect(iconOf(btn)).toBe(dismissed ? 'lucide-archive-restore' : 'lucide-ban');
  expect(iconSvg(btn)?.getAttribute('stroke')).toBe(DISMISS_ICON_STROKE);
  expect(btn.getAttribute('aria-label')).toBeTruthy();
  expect(btn.classList.contains('clickable-icon')).toBe(true);
  expect(btn.classList.contains('ir-action-bar-status')).toBe(false);
  expect(btn.textContent).toBe('');
  expect(btn.childNodes).toHaveLength(1);
}

/**
 * Assert `btn` reads as plain muted status text: no icon, and no `aria-label`
 * tooltip repeating what is already on screen.
 */
function expectStatusText(btn: HTMLButtonElement) {
  expect(btn.textContent).toBeTruthy();
  expect(iconSvg(btn)).toBeNull();
  expect(btn.hasAttribute('aria-label')).toBe(false);
  expect(btn.classList.contains('clickable-icon')).toBe(false);
  expect(btn.classList.contains('ir-action-bar-status')).toBe(true);
  expect(btn.classList.contains('ir-review-button')).toBe(true);
  expect(btn.disabled).toBe(true);
}

// #endregion

beforeEach(() => {
  Notice.reset();
});

afterEach(() => {
  while (mountedViews.length) mountedViews.pop()?.destroy();
  document.body.replaceChildren();
  removeIcon(PLUGIN_ICON);
  vi.restoreAllMocks();
});

describe('renderStandaloneActionBarDOM', () => {
  it('shows a disabled placeholder until the lookup resolves', () => {
    const { plugin } = makeHarness();
    const container = makeContainer();

    renderStandaloneActionBarDOM(makeFile(), plugin, container);

    expect(iconName(dismissButton(container))).toBe('loader');
    expect(dismissButton(container).disabled).toBe(true);
  });

  it('labels the button to match the stored state', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.string({ minLength: 1 }),
        async (dismissed, id) => {
          const file = makeFile();
          const { plugin } = makeHarness({
            item: makeItem({ id, dismissed, file }),
          });
          const container = makeContainer();

          renderStandaloneActionBarDOM(file, plugin, container);
          await tick();

          expect(iconName(dismissButton(container))).toBe(
            dismissed ? RESTORE : DISMISS
          );
          expect(dismissButton(container).disabled).toBe(false);
          container.remove();
        }
      )
    );
  });

  it('holds the loader icon in the toggle slot while the lookup runs', () => {
    const { plugin } = makeHarness();
    const container = makeContainer();

    renderStandaloneActionBarDOM(makeFile(), plugin, container);

    const btn = dismissButton(container);
    expect(iconOf(btn)).toBe('lucide-loader');
    expect(iconSvg(btn)?.getAttribute('stroke')).toBe('currentColor');
    expect(btn.getAttribute('aria-label')).toBeTruthy();
    expect(btn.classList.contains('clickable-icon')).toBe(true);
    expect(btn.classList.contains('ir-action-bar-status')).toBe(false);
    expect(btn.textContent).toBe('');
  });

  it('says so when the note has no row, and stays disabled', async () => {
    const { plugin } = makeHarness({ item: null });
    const container = makeContainer();

    renderStandaloneActionBarDOM(makeFile(), plugin, container);
    await tick();

    expectStatusText(dismissButton(container));
  });

  it('tells a note with no row apart from a lookup that failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const missing = makeContainer();
    const failed = makeContainer();

    renderStandaloneActionBarDOM(
      makeFile(),
      makeHarness({ item: null }).plugin,
      missing
    );
    renderStandaloneActionBarDOM(
      makeFile(),
      makeHarness({ lookupRejects: true }).plugin,
      failed
    );
    await tick();

    expect(dismissButton(missing).textContent).not.toBe(
      dismissButton(failed).textContent
    );
  });

  it('says so when the lookup throws, and reports why', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { plugin } = makeHarness({ lookupRejects: true });
    const container = makeContainer();

    renderStandaloneActionBarDOM(makeFile(), plugin, container);
    await tick();

    expectStatusText(dismissButton(container));
    expect(logged).toHaveBeenCalledWith(
      'Failed to fetch item status:',
      expect.any(Error)
    );
  });

  it('reports a row that vanished between render and click, changing nothing', async () => {
    const file = makeFile();
    const harness = makeHarness({ item: makeItem({ file }) });
    const container = makeContainer();
    const notify = vi.spyOn(Obsidian, 'notify');

    renderStandaloneActionBarDOM(file, harness.plugin, container);
    await tick();
    harness.setRow(null);
    dismissButton(container).click();
    await tick();

    expect(Notice.messages).toHaveLength(1);
    expect(notify).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      kind: 'error',
    });
    expect(harness.reviewManager.dismissItem).not.toHaveBeenCalled();
    expect(harness.reviewManager.unDismissItem).not.toHaveBeenCalled();
  });

  it('reports a failed write and leaves the label describing the untaken action', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = makeFile();
    const harness = makeHarness({ item: makeItem({ dismissed: false, file }) });
    harness.reviewManager.dismissItem.mockRejectedValueOnce(
      new Error('write failed')
    );
    const container = makeContainer();
    const notify = vi.spyOn(Obsidian, 'notify');

    renderStandaloneActionBarDOM(file, harness.plugin, container);
    await tick();
    dismissButton(container).click();
    await tick();

    expect(Notice.messages).toHaveLength(1);
    expect(notify).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      kind: 'error',
    });
    expect(iconName(dismissButton(container))).toBe(DISMISS);
    expect(logged).toHaveBeenCalledWith(
      'Failed to toggle dismiss status:',
      expect.any(Error)
    );
  });

  it('says nothing more of a write the database refused, which said why itself, and leaves the label as it was', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = makeFile();
    const harness = makeHarness({ item: makeItem({ dismissed: false, file }) });
    harness.reviewManager.dismissItem.mockRejectedValueOnce(
      new ActionRefusedError('dismiss the item')
    );
    const container = makeContainer();
    const notify = vi.spyOn(Obsidian, 'notify');

    renderStandaloneActionBarDOM(file, harness.plugin, container);
    await tick();
    dismissButton(container).click();
    await tick();

    expect(notify).not.toHaveBeenCalled();
    expect(logged).not.toHaveBeenCalled();
    expect(iconName(dismissButton(container))).toBe(DISMISS);
  });

  it('opens a known item in review in the current tab', async () => {
    const file = makeFile();
    const item = makeItem({ file });
    const harness = makeHarness({ item });
    const learn = vi.fn(async () => {});
    const plugin = Object.assign(harness.plugin, { learn });
    const container = makeContainer();

    renderStandaloneActionBarDOM(file, plugin, container);
    await tick();
    buttons(container)[1].click();
    await tick();

    expect(learn).toHaveBeenCalledWith(item, false);
  });

  it('opens review empty-handed when the note has no row', async () => {
    const file = makeFile();
    const harness = makeHarness({ item: null });
    const learn = vi.fn(async () => {});
    const plugin = Object.assign(harness.plugin, { learn });
    const container = makeContainer();

    renderStandaloneActionBarDOM(file, plugin, container);
    await tick();
    buttons(container)[1].click();
    await tick();

    expect(learn).toHaveBeenCalledWith();
  });

  describe('the Review button', () => {
    /** The bar for a known item, with `learn` stubbed to record its calls. */
    async function renderReviewButton() {
      const file = makeFile();
      const item = makeItem({ file });
      const harness = makeHarness({ item });
      const learn = vi.fn(async () => {});
      const plugin = Object.assign(harness.plugin, { learn });
      const container = makeContainer();
      renderStandaloneActionBarDOM(file, plugin, container);
      await tick();
      return {
        item,
        learn,
        reviewManager: harness.reviewManager,
        button: buttons(container)[1],
        dismiss: dismissButton(container),
      };
    }

    const modifiersArb = fc.record({
      ctrlKey: fc.boolean(),
      metaKey: fc.boolean(),
      altKey: fc.boolean(),
      shiftKey: fc.boolean(),
    });

    /**
     * Where Obsidian's own links open for these keys: a middle click a tab
     * whatever is held, else Mod+Alt+Shift a window, Mod+Alt a split, Mod a
     * tab, anything else in place. Mod is Ctrl or Cmd (the mock accepts
     * either; the app reads the platform's one).
     */
    function expectedPane(
      {
        ctrlKey,
        metaKey,
        altKey,
        shiftKey,
      }: Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>,
      middle: boolean
    ): 'tab' | 'split' | 'window' | false {
      if (middle) return 'tab';
      const mod = ctrlKey || metaKey;
      if (mod && altKey) return shiftKey ? 'window' : 'split';
      return mod ? 'tab' : false;
    }

    function press(
      target: HTMLElement,
      type: 'click' | 'auxclick' | 'mousedown',
      init: MouseEventInit = {}
    ): MouseEvent {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        ...init,
      });
      target.dispatchEvent(event);
      return event;
    }

    it('opens review in a new tab on Ctrl+click', async () => {
      const { item, learn, button } = await renderReviewButton();

      press(button, 'click', { ctrlKey: true });
      await tick();

      expect(learn).toHaveBeenCalledWith(item, 'tab');
    });

    it('opens review in a new tab on a middle click', async () => {
      // A middle click never fires `click`: browsers emit `auxclick` for it.
      const { item, learn, button } = await renderReviewButton();

      press(button, 'auxclick', { button: 1 });
      await tick();

      expect(learn).toHaveBeenCalledWith(item, 'tab');
    });

    it('opens review in place on a plain click', async () => {
      const { item, learn, button } = await renderReviewButton();

      press(button, 'click');
      await tick();

      expect(learn).toHaveBeenCalledWith(item, false);
    });

    it('opens review where the modifier keys say, as Obsidian links do', async () => {
      await fc.assert(
        fc.asyncProperty(
          modifiersArb,
          fc.constantFrom(
            { type: 'click', button: 0 } as const,
            { type: 'auxclick', button: 1 } as const
          ),
          async (modifiers, { type, button: mouseButton }) => {
            document.body.replaceChildren();
            const { item, learn, button } = await renderReviewButton();

            press(button, type, { ...modifiers, button: mouseButton });
            await tick();

            expect(learn).toHaveBeenCalledTimes(1);
            expect(learn).toHaveBeenCalledWith(
              item,
              expectedPane(modifiers, mouseButton === 1)
            );
          }
        )
      );
    });

    it('ignores the other non-primary buttons', async () => {
      // `auxclick` fires for the right button too, ahead of the context menu.
      await fc.assert(
        fc.asyncProperty(
          modifiersArb,
          fc.integer({ min: 2, max: 4 }),
          async (modifiers, mouseButton) => {
            document.body.replaceChildren();
            const { learn, button } = await renderReviewButton();

            press(button, 'auxclick', { ...modifiers, button: mouseButton });
            await tick();

            expect(learn).not.toHaveBeenCalled();
          }
        )
      );
    });

    it('claims the middle-button press, and only that one', async () => {
      // Middle-mousedown starts autoscroll on Windows and pastes the primary
      // selection on Linux, neither of which belongs in front of a new tab.
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 4 }),
          async (mouseButton) => {
            document.body.replaceChildren();
            const { button } = await renderReviewButton();

            const event = press(button, 'mousedown', { button: mouseButton });

            expect(event.defaultPrevented).toBe(mouseButton === 1);
          }
        )
      );
    });

    it('leaves the dismiss toggle to plain clicks', async () => {
      // Nothing opens from it, so a middle press keeps its default as well.
      const { reviewManager, learn, dismiss } = await renderReviewButton();

      const pressed = press(dismiss, 'mousedown', { button: 1 });
      press(dismiss, 'auxclick', { button: 1 });
      await tick();

      expect(pressed.defaultPrevented).toBe(false);
      expect(reviewManager.dismissItem).not.toHaveBeenCalled();
      expect(learn).not.toHaveBeenCalled();
    });
  });

  it('shows Review as the plugin icon, named by its tooltip and not by text', async () => {
    registerPluginIcon();
    const { plugin } = makeHarness();
    const container = makeContainer();

    renderStandaloneActionBarDOM(makeFile(), plugin, container);
    await tick();

    const btn = reviewButton(container);
    expect(iconSvg(btn)?.classList.contains(PLUGIN_ICON)).toBe(true);
    expect(btn.classList.contains('ir-review-button')).toBe(true);
    expect(btn.getAttribute('aria-label')).toBeTruthy();
    expect(btn.classList.contains('clickable-icon')).toBe(true);
    expect(btn.textContent).toBe('');
    expect(btn.hasAttribute('title')).toBe(false);
    expect(iconSvg(btn)?.hasAttribute('aria-label')).toBe(false);
  });

  it('adds a Review button alongside the dismiss toggle', async () => {
    const { plugin } = makeHarness();
    const container = makeContainer();

    renderStandaloneActionBarDOM(makeFile(), plugin, container);
    await tick();

    expect(buttons(container).map(iconName)).toEqual([DISMISS, PLUGIN_ICON]);
  });

  it('toggles the stored state on click and relabels for the opposite action', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (dismissed) => {
        const file = makeFile();
        const harness = makeHarness({ item: makeItem({ dismissed, file }) });
        const container = makeContainer();
        Notice.reset();

        renderStandaloneActionBarDOM(file, harness.plugin, container);
        await tick();
        dismissButton(container).click();
        await tick();

        if (dismissed) {
          expect(harness.reviewManager.unDismissItem).toHaveBeenCalledOnce();
          expect(harness.reviewManager.dismissItem).not.toHaveBeenCalled();
        } else {
          expect(harness.reviewManager.dismissItem).toHaveBeenCalledOnce();
          expect(harness.reviewManager.unDismissItem).not.toHaveBeenCalled();
        }
        expect(iconName(dismissButton(container))).toBe(
          dismissed ? DISMISS : RESTORE
        );
        container.remove();
      })
    );
  });

  it('confirms a dismissal or restore only while every success notice shows', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.constantFrom(...SUCCESS_NOTICE_LEVELS),
        async (dismissed, level) => {
          const file = makeFile();
          const harness = makeHarness({ item: makeItem({ dismissed, file }) });
          const container = makeContainer();
          showSuccessNotices(level);
          Notice.reset();

          renderStandaloneActionBarDOM(file, harness.plugin, container);
          await tick();
          dismissButton(container).click();
          await tick();
          configureSuccessNotices(null);
          container.remove();

          expect(Notice.messages).toHaveLength(level === 'all' ? 1 : 0);
        }
      )
    );
  });

  it('keeps showing the icon for the next action through clicks and outside writes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.array(fc.option(fc.boolean(), { nil: undefined }), {
          maxLength: 6,
        }),
        async (initial, steps) => {
          const file = makeFile();
          const harness = makeHarness({
            item: makeItem({ id: 'watched', dismissed: initial, file }),
          });
          const container = makeContainer();
          let stored = initial;

          const bar = renderStandaloneActionBarDOM(
            file,
            harness.plugin,
            container
          );
          await tick();
          expectDismissFace(dismissButton(container), stored);

          // `undefined` is a click here; a boolean, a write made elsewhere,
          // which the bar's owner hears and has it look again for
          for (const step of steps) {
            if (step === undefined) {
              dismissButton(container).click();
              stored = !stored;
            } else {
              harness.setStored('watched', step);
              bar.refresh();
              stored = step;
            }
            await tick();
            expectDismissFace(dismissButton(container), stored);
          }
          container.remove();
        }
      )
    );
  });

  describe('looking again when its owner says to', () => {
    /** A row as each step leaves it: dismissed or not, or gone (`null`). */
    const rowStateArb = fc.option(fc.boolean(), { nil: null });

    it('shows what each look finds: the item, dismissed or not, or no row at all', async () => {
      await fc.assert(
        fc.asyncProperty(
          rowStateArb,
          fc.array(rowStateArb, { minLength: 1, maxLength: 6 }),
          async (initial, steps) => {
            const file = makeFile();
            const rowFor = (state: boolean | null) =>
              state === null
                ? null
                : makeItem({ id: 'watched', dismissed: state, file });
            const harness = makeHarness({ item: rowFor(initial) });
            const container = makeContainer();

            const bar = renderStandaloneActionBarDOM(
              file,
              harness.plugin,
              container
            );
            await tick();

            for (const state of steps) {
              harness.setRow(rowFor(state));
              bar.refresh();
              await tick();

              const btn = dismissButton(container);
              if (state === null) {
                expectStatusText(btn);
              } else {
                expectDismissFace(btn, state);
                expect(btn.disabled).toBe(false);
              }
            }
            container.remove();
          }
        )
      );
    });

    it('reads once for a burst of calls to look again', async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (calls) => {
          const file = makeFile();
          const harness = makeHarness({ item: makeItem({ file }) });
          const container = makeContainer();

          const bar = renderStandaloneActionBarDOM(
            file,
            harness.plugin,
            container
          );
          await tick();
          harness.reviewManager.getReviewItemFromFile.mockClear();

          for (let i = 0; i < calls; i += 1) bar.refresh();
          await tick();

          expect(
            harness.reviewManager.getReviewItemFromFile
          ).toHaveBeenCalledOnce();
          container.remove();
        })
      );
    });

    it('keeps its face, its focus and its button usable while a look is under way', async () => {
      await fc.assert(
        fc.asyncProperty(fc.boolean(), async (dismissed) => {
          const file = makeFile();
          const harness = makeHarness({ item: makeItem({ dismissed, file }) });
          const container = makeContainer();
          const bar = renderStandaloneActionBarDOM(
            file,
            harness.plugin,
            container
          );
          await tick();
          const btn = dismissButton(container);
          btn.focus();

          const read = deferred<ReviewItem | null>();
          harness.reviewManager.getReviewItemFromFile.mockReturnValueOnce(
            read.promise
          );
          bar.refresh();
          await tick();

          expect(dismissButton(container)).toBe(btn);
          expectDismissFace(btn, dismissed);
          expect(btn.disabled).toBe(false);
          expect(document.activeElement).toBe(btn);
          read.resolve(makeItem({ dismissed, file }));
          await tick();
          container.remove();
        })
      );
    });

    it('shows what the newest look found, however the reads land', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc
            .array(fc.boolean(), { minLength: 2, maxLength: 5 })
            .chain((answers) =>
              fc.tuple(
                fc.constant(answers),
                fc.shuffledSubarray(
                  answers.map((_, i) => i),
                  { minLength: answers.length }
                )
              )
            ),
          async ([answers, landingOrder]) => {
            const file = makeFile();
            const harness = makeHarness({ item: makeItem({ file }) });
            const container = makeContainer();
            // Each look waits on a read the test lands by hand, the one made
            // on rendering first
            const reads = answers.map(() => deferred<ReviewItem | null>());
            for (const read of reads) {
              harness.reviewManager.getReviewItemFromFile.mockReturnValueOnce(
                read.promise
              );
            }
            const bar = renderStandaloneActionBarDOM(
              file,
              harness.plugin,
              container
            );
            for (let i = 1; i < reads.length; i += 1) {
              bar.refresh();
              await tick();
            }
            expect(
              harness.reviewManager.getReviewItemFromFile
            ).toHaveBeenCalledTimes(reads.length);
            for (const i of landingOrder) {
              reads[i].resolve(makeItem({ dismissed: answers[i], file }));
              await tick();
            }

            expectDismissFace(dismissButton(container), answers.at(-1)!);
            container.remove();
          }
        )
      );
    });

    it('keeps the face and reports why when a look fails', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      await fc.assert(
        fc.asyncProperty(
          fc.boolean(),
          fc.anything(),
          async (dismissed, reason) => {
            logged.mockClear();
            const file = makeFile();
            const harness = makeHarness({
              item: makeItem({ id: 'watched', dismissed, file }),
            });
            const container = makeContainer();

            const bar = renderStandaloneActionBarDOM(
              file,
              harness.plugin,
              container
            );
            await tick();

            harness.reviewManager.getReviewItemFromFile.mockRejectedValueOnce(
              reason
            );
            bar.refresh();
            await tick();

            expectDismissFace(dismissButton(container), dismissed);
            expect(logged).toHaveBeenCalledExactlyOnceWith(
              expect.stringMatching(/refresh/),
              reason
            );
            container.remove();
          }
        )
      );
    });

    it('reads nothing and repaints nothing once torn down, a look under way or asked for included', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('idle', 'asked', 'reading' as const),
          async (when) => {
            const file = makeFile();
            const harness = makeHarness({
              item: makeItem({ dismissed: false, file }),
            });
            const container = makeContainer();
            const bar = renderStandaloneActionBarDOM(
              file,
              harness.plugin,
              container
            );
            await tick();
            const read = deferred<ReviewItem | null>();
            harness.reviewManager.getReviewItemFromFile.mockClear();
            harness.reviewManager.getReviewItemFromFile.mockReturnValueOnce(
              read.promise
            );
            if (when !== 'idle') bar.refresh();
            if (when === 'reading') await tick();

            bar.dispose();
            bar.refresh();
            read.resolve(makeItem({ dismissed: true, file }));
            await tick();

            expect(
              harness.reviewManager.getReviewItemFromFile
            ).toHaveBeenCalledTimes(when === 'reading' ? 1 : 0);
            expectDismissFace(dismissButton(container), false);
            container.remove();
          }
        )
      );
    });

    it('shows nothing of a failed first read that lands after teardown or before a newer read', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('torn down', 'overtaken' as const),
          async (then) => {
            const file = makeFile();
            const harness = makeHarness();
            const first = deferred<ReviewItem | null>();
            const second = deferred<ReviewItem | null>();
            harness.reviewManager.getReviewItemFromFile
              .mockReturnValueOnce(first.promise)
              .mockReturnValueOnce(second.promise);
            const container = makeContainer();
            const bar = renderStandaloneActionBarDOM(
              file,
              harness.plugin,
              container
            );
            await tick();
            if (then === 'torn down') bar.dispose();
            else bar.refresh();
            await tick();

            first.reject(new Error('db unavailable'));
            await tick();
            expect(iconName(dismissButton(container))).toBe('loader');

            second.resolve(makeItem({ dismissed: true, file }));
            await tick();
            if (then === 'overtaken') {
              expectDismissFace(dismissButton(container), true);
            }
            container.remove();
          }
        )
      );
    });

    it('reports a failure after a failed first read as one to look again, leaving the face', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const harness = makeHarness({ lookupRejects: true });
      const container = makeContainer();
      const bar = renderStandaloneActionBarDOM(
        makeFile(),
        harness.plugin,
        container
      );
      await tick();
      const failedFace = dismissButton(container).textContent;
      logged.mockClear();

      bar.refresh();
      await tick();

      expect(logged).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(/refresh/),
        expect.any(Error)
      );
      expectStatusText(dismissButton(container));
      expect(dismissButton(container).textContent).toBe(failedFace);
    });

    it('subscribes to nothing itself, leaving its owner to say when to look again', async () => {
      const file = makeFile();
      const harness = makeHarness({ item: makeItem({ file }) });
      const container = makeContainer();

      renderStandaloneActionBarDOM(file, harness.plugin, container);
      await tick();

      expect(harness.reviewManager.repo.onDataChange).not.toHaveBeenCalled();
    });

    it('returns a bar that is safe to use when there is no review manager', () => {
      const container = makeContainer();
      const bar = renderStandaloneActionBarDOM(
        makeFile(),
        { reviewManager: undefined } as unknown as IncrementalReadingPlugin,
        container
      );

      expect(() => {
        bar.refresh();
        bar.dispose();
      }).not.toThrow();
      expect(buttons(container)).toHaveLength(0);
    });
  });
});

describe('the edit-mode action bar panel', () => {
  it('sits above the note on desktop, in a slot marked as its host', async () => {
    const harness = makeHarness({ item: makeItem({ id: 'watched' }) });
    const panel = mountPanel(harness);
    await tick();

    expect(panel.topSlotBar()).not.toBeNull();
    expect(panel.host()).not.toBeNull();
    expect(panel.host()?.querySelector('.ir-action-bar')).not.toBeNull();
  });

  it('relabels a panel that was built before the item changed elsewhere', async () => {
    // The reported bug: dismiss here, leave for reading mode, restore there,
    // come back. The panel outlives the switch, so only a live label is right.
    const harness = makeHarness({
      item: makeItem({ id: 'watched', dismissed: true }),
    });
    const panel = mountPanel(harness, { claims: 'watched' });
    await tick();
    expect(panel.barButtons()).toEqual([RESTORE, PLUGIN_ICON]);

    harness.setStored('watched', false);
    harness.emit({ ids: ['watched'] });
    await tick();

    expect(panel.barButtons()).toEqual([DISMISS, PLUGIN_ICON]);
  });

  it('reads the item again once per write naming the row the note claims, and never for one naming others', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.uniqueArray(fc.constantFrom('watched', 'other', 'another'), {
            minLength: 1,
          }),
          { maxLength: 6 }
        ),
        async (writes) => {
          const harness = makeHarness({ item: makeItem({ id: 'watched' }) });
          const panel = mountPanel(harness, { claims: 'watched' });
          await tick();
          harness.reviewManager.getReviewItemFromFile.mockClear();

          for (const ids of writes) {
            harness.emit({ ids });
            await tick();
          }

          expect(
            harness.reviewManager.getReviewItemFromFile
          ).toHaveBeenCalledTimes(
            writes.filter((ids) => ids.includes('watched')).length
          );
          panel.view.destroy();
        }
      )
    );
  });

  it('rebuilds nothing and reads nothing for an edit to the note', async () => {
    const harness = makeHarness({ item: makeItem({ id: 'watched' }) });
    const panel = mountPanel(harness, { claims: 'watched' });
    await tick();
    const toggle = dismissButton(panel.bar() as HTMLElement);
    harness.reviewManager.getReviewItemFromFile.mockClear();

    panel.view.dispatch({ changes: { from: 0, insert: 'more ' } });
    await tick();

    expect(dismissButton(panel.bar() as HTMLElement)).toBe(toggle);
    expect(harness.reviewManager.getReviewItemFromFile).not.toHaveBeenCalled();
  });

  it('reads nothing for an update that carries no transaction, as focusing the editor makes', async () => {
    const harness = makeHarness({ item: makeItem({ id: 'watched' }) });
    const panel = mountPanel(harness, { claims: 'watched' });
    await tick();
    harness.reviewManager.getReviewItemFromFile.mockClear();

    panel.view.focus();
    // CodeMirror tells its extensions of a focus change after a short timeout
    await new Promise((resolve) => setTimeout(resolve, 30));
    await tick();

    expect(panel.view.hasFocus).toBe(true);

    expect(harness.reviewManager.getReviewItemFromFile).not.toHaveBeenCalled();
  });

  it('reads nothing more once the editor goes away', async () => {
    const harness = makeHarness({ item: makeItem({ id: 'watched' }) });
    const panel = mountPanel(harness, { claims: 'watched' });
    await tick();
    harness.reviewManager.getReviewItemFromFile.mockClear();

    panel.view.destroy();
    harness.emit({ ids: ['watched'] });
    await tick();

    expect(harness.reviewManager.getReviewItemFromFile).not.toHaveBeenCalled();
    expect(harness.listenerCount()).toBe(0);
  });

  it('reads once per write after re-rendering, not once per render it ever had', async () => {
    const harness = makeHarness({ item: makeItem({ id: 'watched' }) });
    const panel = mountPanel(harness, { claims: 'watched' });
    await tick();

    panel.view.dispatch({ effects: setShowAnswerEffect.of(true) });
    await tick();
    harness.reviewManager.getReviewItemFromFile.mockClear();
    harness.emit({ ids: ['watched'] });
    await tick();

    expect(harness.reviewManager.getReviewItemFromFile).toHaveBeenCalledOnce();
  });

  it('reads nothing for a write once the bar has switched into review mode', async () => {
    const harness = makeHarness({ item: makeItem({ id: 'watched' }) });
    const panel = mountPanel(harness, { claims: 'watched' });
    await tick();

    panel.view.dispatch({
      effects: [
        setReviewCallbacks.of({
          getCurrentItem: () => makeItem({ id: 'watched' }),
        }),
        setReviewModeEffect.of(true),
      ],
    });
    await tick();
    harness.reviewManager.getReviewItemFromFile.mockClear();
    harness.emit({ ids: ['watched'] });
    await tick();

    expect(panel.barButtons()).toEqual([]);
    expect(harness.reviewManager.getReviewItemFromFile).not.toHaveBeenCalled();
  });

  it('takes the bar and its host marking away with the file, and reads nothing for it after', async () => {
    const harness = makeHarness({ item: makeItem({ id: 'watched' }) });
    const panel = mountPanel(harness, { claims: 'watched' });
    await tick();
    // Held across the teardown: the slot may be detached along with the panel,
    // and a class left behind on a detached node is still a class left behind.
    const host = panel.host();
    expect(host).not.toBeNull();

    panel.clearInfo();
    // Any state change re-derives the panel, which a file-less editor has none of.
    panel.view.dispatch({ effects: setShowAnswerEffect.of(true) });
    await tick();
    harness.reviewManager.getReviewItemFromFile.mockClear();
    harness.emit({ ids: ['watched'] });
    await tick();

    expect(panel.barButtons()).toEqual([]);
    expect(host?.classList.contains('ir-action-bar-host')).toBe(false);
    expect(harness.reviewManager.getReviewItemFromFile).not.toHaveBeenCalled();
  });

  it('renders nothing and watches nothing without a plugin to render for', async () => {
    const harness = makeHarness({ item: makeItem({ id: 'watched' }) });
    const panel = mountPanel(harness, {
      providePlugin: false,
      claims: 'watched',
    });
    await tick();

    expect(panel.barButtons()).toEqual([]);
    expect(harness.listenerCount()).toBe(0);
  });
});

describe('the edit-mode bar on a tagged note whose row comes and goes', () => {
  /** A tagged article note claiming row `x`, afresh: edits change it. */
  const tagged = (): Record<string, unknown> => ({
    'ir-id': 'x',
    tags: [ARTICLE_TAG],
  });
  const tableArb = fc.constantFrom('article', 'snippet', 'srs_card' as const);
  /**
   * A write to the database: one {@link rowWriteArb} makes, or row `x` of a
   * table dismissed or restored. Row `y` stays off the note's path: the item
   * is read by path (see `ReviewManager.getReviewItemFromFile`), and a row
   * the note doesn't claim at its path names nothing the bar watches.
   */
  const writeArb = fc.oneof(
    rowWriteArb.filter((write) => write.id === 'x' || !write.atNote),
    fc.record({ table: tableArb, dismissed: fc.boolean() })
  );

  const apply = (
    repo: TestRepository,
    write: RowWrite | { table: string; dismissed: boolean },
    notePath: string
  ) => {
    if ('kind' in write) {
      applyRowWrite(repo, write, notePath);
    } else {
      repo.mutate(`UPDATE ${write.table} SET dismissed = $1 WHERE id = 'x'`, [
        write.dismissed,
      ]);
    }
  };

  /** Tombstone row `x` of `table`, or bring it back, with no note edit. */
  const flagRow = (repo: TestRepository, table: string, deleted: boolean) => {
    repo.mutate(`UPDATE ${table} SET deleted = $1 WHERE id = 'x'`, [deleted]);
  };

  it('shows what the database holds for the note after each write, with no edit to the note', async () => {
    await fc.assert(
      fc.asyncProperty(
        tableArb,
        fc.constantFrom('live', 'deleted', 'absent' as const),
        fc.array(writeArb, { minLength: 1, maxLength: 4 }),
        async (table, row, writes) => {
          const { panel, repo, manager } = await wireItemNote({
            table,
            row,
            atReference: true,
            frontmatter: tagged(),
            realLookup: true,
          });
          await tick();

          for (const write of writes) {
            try {
              apply(repo, write, panel.file.path);
            } catch {
              // A row the table already holds by id or path: nothing written
              continue;
            }
            await tick();

            if ((await manager.getItemType(panel.file)) === null) {
              expect(panel.hasBar()).toBe(false);
              continue;
            }
            expect(faceOf(dismissButton(panel.bar() as HTMLElement))).toBe(
              faceFor(storedArticleAt(repo, panel.file.path))
            );
          }
          panel.view.destroy();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('switches from saying it has no row to the item once a row with its id is stored', async () => {
    const { panel, repo } = await wireItemNote({
      table: 'article',
      row: 'absent',
      atReference: true,
      frontmatter: tagged(),
      realLookup: true,
    });
    await tick();
    expect(panel.barButtons()).toEqual([null, PLUGIN_ICON]);

    insertItemAt(repo, 'article', {
      id: 'x',
      reference: ROW_REFERENCE,
      deleted: false,
    });
    await tick();

    expect(panel.barButtons()).toEqual([DISMISS, PLUGIN_ICON]);
  });

  it('says it has no row once the row is deleted elsewhere, and shows the item again once it is revived', async () => {
    const { panel, repo } = await wireItemNote({
      table: 'article',
      row: 'live',
      atReference: true,
      frontmatter: tagged(),
      realLookup: true,
    });
    await tick();
    expect(panel.barButtons()).toEqual([DISMISS, PLUGIN_ICON]);

    flagRow(repo, 'article', true);
    await tick();
    expectStatusText(dismissButton(panel.bar() as HTMLElement));

    flagRow(repo, 'article', false);
    await tick();
    expect(panel.barButtons()).toEqual([DISMISS, PLUGIN_ICON]);
  });

  it('keeps its button, and the focus on it, through a write naming its row', async () => {
    const { panel, repo } = await wireItemNote({
      table: 'article',
      row: 'live',
      atReference: true,
      frontmatter: tagged(),
      realLookup: true,
    });
    await tick();
    const btn = dismissButton(panel.bar() as HTMLElement);
    btn.focus();

    repo.mutate(`UPDATE article SET dismissed = TRUE WHERE id = 'x'`);
    await tick();

    expect(dismissButton(panel.bar() as HTMLElement)).toBe(btn);
    expect(document.activeElement).toBe(btn);
    expectDismissFace(btn, true);
    panel.view.destroy();
  });

  it('reads nothing for a write naming another row', async () => {
    const { panel, repo, harness } = await wireItemNote({
      table: 'article',
      row: 'absent',
      atReference: true,
      frontmatter: tagged(),
      realLookup: true,
    });
    await tick();
    harness.reviewManager.getReviewItemFromFile.mockClear();

    insertItemAt(repo, 'article', {
      id: 'y',
      reference: 'elsewhere/other.md',
      deleted: false,
    });
    await tick();

    expect(harness.reviewManager.getReviewItemFromFile).not.toHaveBeenCalled();
    expect(panel.barButtons()).toEqual([null, PLUGIN_ICON]);
  });

  it('looks again once a database swapped in from disk has been taken in', async () => {
    const { panel, repo } = await wireItemNote({
      table: 'article',
      row: 'deleted',
      atReference: true,
      frontmatter: tagged(),
      realLookup: true,
    });
    await tick();
    expect(panel.barButtons()).toEqual([null, PLUGIN_ICON]);

    // Taken in with no change reported for any row
    await repo.takeIn(`UPDATE article SET deleted = FALSE WHERE id = 'x'`);
    panel.app.workspace.trigger(ROWS_RELOADED_EVENT);
    await tick();

    expect(panel.barButtons()).toEqual([DISMISS, PLUGIN_ICON]);
  });

  it('looks again when an edit gives the note another id, as an import does', async () => {
    const { panel, repo, editNote } = await wireItemNote({
      table: 'article',
      row: 'absent',
      atReference: true,
      frontmatter: { tags: [ARTICLE_TAG] },
      realLookup: true,
    });
    await tick();
    // Stored before the note names it: no row the note claims was written
    insertItemAt(repo, 'article', {
      id: 'y',
      reference: ROW_REFERENCE,
      deleted: false,
    });
    await tick();
    expect(panel.barButtons()).toEqual([null, PLUGIN_ICON]);

    await editNote((fm) => {
      fm['ir-id'] = 'y';
    });
    await tick();

    expect(panel.barButtons()).toEqual([DISMISS, PLUGIN_ICON]);
  });

  it('reads nothing more for an edit that keeps the note its id and type', async () => {
    const { panel, harness, editNote } = await wireItemNote({
      table: 'article',
      row: 'live',
      atReference: true,
      frontmatter: tagged(),
      realLookup: true,
    });
    await tick();
    harness.reviewManager.getReviewItemFromFile.mockClear();

    await editNote((fm) => {
      fm.title = 'renamed';
    });
    await tick();

    expect(harness.reviewManager.getReviewItemFromFile).not.toHaveBeenCalled();
    expect(panel.barButtons()).toEqual([DISMISS, PLUGIN_ICON]);
  });
});

describe('the edit-mode bar on a note that lost its type tag', () => {
  const tableArb = fc.constantFrom('article', 'snippet', 'srs_card' as const);
  /** The tag a note of each table's rows carries. */
  const TABLE_TAG = {
    article: ARTICLE_TAG,
    snippet: SNIPPET_TAG,
    srs_card: CARD_TAG,
  } as const;

  it("shows on a note carrying a live row's ir-id at its reference, and on no tombstone's or copy's", async () => {
    await fc.assert(
      fc.asyncProperty(
        tableArb,
        fc.constantFrom('live', 'deleted', 'absent' as const),
        fc.boolean(),
        async (table, row, atReference) => {
          const { panel } = await wireItemNote({
            table,
            row,
            atReference,
            frontmatter: { 'ir-id': 'x' },
          });
          await tick();

          expect(panel.hasBar()).toBe(row === 'live' && atReference);
          panel.view.destroy();
        }
      ),
      { numRuns: 30 }
    );
  });

  it('keeps the bar, at once, when only the tag comes off a note its row still holds', async () => {
    await fc.assert(
      fc.asyncProperty(tableArb, async (table) => {
        const { panel, editNote } = await wireItemNote({
          table,
          row: 'live',
          atReference: true,
          frontmatter: { 'ir-id': 'x', tags: [TABLE_TAG[table]] },
        });
        await tick();
        const bar = panel.bar();
        expect(bar).not.toBeNull();

        await editNote((fm) => delete fm.tags);

        expect(panel.bar()).toBe(bar);
        panel.view.destroy();
      }),
      { numRuns: 6 }
    );
  });

  it('takes the bar off once the ir-id comes off an untagged note', async () => {
    const { panel, editNote } = await wireItemNote({
      table: 'srs_card',
      row: 'live',
      atReference: true,
      frontmatter: { 'ir-id': 'x' },
    });
    await tick();
    expect(panel.hasBar()).toBe(true);

    await editNote((fm) => delete fm['ir-id']);

    expect(panel.hasBar()).toBe(false);
  });

  it('keeps the bar it has while a slower database is asked about a tag gone, then shows its answer', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (deleted) => {
        const { panel, repo, editNote } = await wireItemNote({
          table: 'article',
          row: deleted ? 'deleted' : 'live',
          atReference: true,
          frontmatter: { 'ir-id': 'x', tags: [ARTICLE_TAG] },
        });
        await tick();
        const answer = repo.deferReads();

        await editNote((fm) => delete fm.tags);
        expect(panel.hasBar()).toBe(true);

        answer();
        await tick();
        expect(panel.hasBar()).toBe(!deleted);
        panel.view.destroy();
      }),
      { numRuns: 4 }
    );
  });

  it("drops a slower database's answer that lands after a newer change", async () => {
    const { panel, repo, editNote } = await wireItemNote({
      table: 'article',
      row: 'deleted',
      atReference: true,
      frontmatter: { 'ir-id': 'x', tags: [ARTICLE_TAG] },
    });
    await tick();
    const answer = repo.deferReads();

    // Asks the database, which would say the tombstone holds no note
    await editNote((fm) => delete fm.tags);
    // Answered at once by the tag put back
    await editNote((fm) => {
      fm.tags = [ARTICLE_TAG];
    });
    answer();
    await tick();

    expect(panel.hasBar()).toBe(true);
  });
});

describe('the edit-mode bar on a note its row alone types', () => {
  /** The frontmatter of a note no tag types, claiming row `x`, afresh: edits change it. */
  const untagged = () => ({ 'ir-id': 'x', tags: ['mine'] });
  const tableArb = fc.constantFrom('article', 'snippet', 'srs_card' as const);

  /** Tombstone row `x` of `table`, or bring it back, with no note edit. */
  const flagRow = (repo: TestRepository, table: string, deleted: boolean) => {
    repo.mutate(`UPDATE ${table} SET deleted = $1 WHERE id = 'x'`, [deleted]);
  };

  it("shows the bar exactly while the item layer types the note, tagged or not, the row's note or a copy of it, after any write to the database and no edit to the note", async () => {
    await fc.assert(
      fc.asyncProperty(
        tableArb,
        fc.constantFrom('live', 'deleted', 'absent' as const),
        fc.boolean(),
        fc.boolean(),
        rowWriteArb,
        async (table, row, tagged, atReference, write) => {
          const frontmatter = untagged();
          if (tagged) frontmatter.tags = [ARTICLE_TAG];
          const { panel, repo, manager } = await wireItemNote({
            table,
            row,
            atReference,
            frontmatter,
            // A copy's original, at the row's reference, claiming its id
            others: atReference ? {} : { [ROW_REFERENCE]: { 'ir-id': 'x' } },
          });
          await tick();
          try {
            applyRowWrite(repo, write, panel.file.path);
          } catch {
            // A row the table already holds by id or path: nothing written
            panel.view.destroy();
            return;
          }
          await tick();

          const typed = (await manager.getItemType(panel.file)) !== null;
          expect(panel.hasBar()).toBe(typed);
          panel.view.destroy();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('takes the bar off when the row is deleted elsewhere, and puts it back once the row is back', async () => {
    const { panel, repo } = await wireItemNote({
      table: 'snippet',
      row: 'live',
      atReference: true,
      frontmatter: untagged(),
    });
    await tick();
    expect(panel.hasBar()).toBe(true);

    flagRow(repo, 'snippet', true);
    await tick();
    expect(panel.hasBar()).toBe(false);

    flagRow(repo, 'snippet', false);
    await tick();
    expect(panel.hasBar()).toBe(true);
  });

  it('puts the bar on a tagged copy once the row its original holds is deleted, and takes it off once the row is back', async () => {
    const { panel, repo } = await wireItemNote({
      table: 'article',
      row: 'live',
      atReference: false,
      frontmatter: { 'ir-id': 'x', tags: [ARTICLE_TAG] },
      others: { [ROW_REFERENCE]: { 'ir-id': 'x' } },
    });
    await tick();
    expect(panel.hasBar()).toBe(false);

    flagRow(repo, 'article', true);
    await tick();
    expect(panel.hasBar()).toBe(true);

    flagRow(repo, 'article', false);
    await tick();
    expect(panel.hasBar()).toBe(false);
  });

  it('watches the row of a note claiming an id, tagged or not, asking the database once per write naming it, and nothing for a note claiming none', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<unknown>(
          [ARTICLE_TAG],
          [CARD_TAG, 'mine'],
          ['mine'],
          undefined
        ),
        fc.constantFrom<unknown>('x', undefined, 7),
        async (tags, irId) => {
          const watchRow = vi.spyOn(ItemManager.prototype, 'watchRow');
          watchRow.mockClear();
          const frontmatter: Record<string, unknown> = {};
          if (tags !== undefined) frontmatter.tags = tags;
          if (irId !== undefined) frontmatter['ir-id'] = irId;
          const { panel, repo } = await wireItemNote({
            table: 'article',
            row: 'live',
            atReference: true,
            frontmatter,
          });
          await tick();
          const query = vi.spyOn(repo, 'query');
          const claimsId = typeof irId === 'string';

          flagRow(repo, 'article', true);
          await tick();

          expect(watchRow).toHaveBeenCalledTimes(claimsId ? 1 : 0);
          expect(query).toHaveBeenCalledTimes(claimsId ? 1 : 0);
          expect(panel.workspaceListenerCount(ROWS_RELOADED_EVENT)).toBe(
            claimsId ? 1 : 0
          );
          panel.view.destroy();
          watchRow.mockRestore();
        }
      ),
      { numRuns: 24 }
    );
  });

  it('asks the database once for writes reported together, however many name the row', async () => {
    const { panel, repo } = await wireItemNote({
      table: 'article',
      row: 'live',
      atReference: true,
      frontmatter: untagged(),
    });
    await tick();
    const query = vi.spyOn(repo, 'query');

    await repo.transaction(async () => {
      repo.mutate("UPDATE article SET priority = 40 WHERE id = 'x'");
      insertItemAt(repo, 'snippet', {
        id: 'x',
        reference: 'elsewhere/other.md',
        deleted: false,
      });
      flagRow(repo, 'article', true);
    });
    await tick();

    expect(query).toHaveBeenCalledOnce();
    expect(panel.hasBar()).toBe(false);
  });

  it('keeps the bar it has while a slower database answers a write, then shows its answer', async () => {
    const { panel, repo } = await wireItemNote({
      table: 'article',
      row: 'live',
      atReference: true,
      frontmatter: untagged(),
    });
    await tick();
    const answer = repo.deferReads();

    flagRow(repo, 'article', true);
    await tick();
    expect(panel.hasBar()).toBe(true);

    answer();
    await tick();
    expect(panel.hasBar()).toBe(false);
  });

  it("drops a slower database's answer to a write once a change to the note answers after it", async () => {
    const { panel, repo, editNote } = await wireItemNote({
      table: 'article',
      row: 'live',
      atReference: true,
      frontmatter: untagged(),
    });
    await tick();
    const answer = repo.deferReads();

    // Asks the database, which will say the tombstone holds no note
    flagRow(repo, 'article', true);
    await tick();
    // Answered at once by the tag put on
    await editNote((fm) => {
      fm.tags = [ARTICLE_TAG];
    });
    answer();
    await tick();

    expect(panel.hasBar()).toBe(true);
  });

  it('stops watching the row once the note lets go of its id, gives way to another note, or the editor goes away', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('no id', 'other note', 'gone' as const),
        async (ending) => {
          const { panel, repo, editNote, vault } = await wireItemNote({
            table: 'article',
            row: 'live',
            atReference: true,
            frontmatter: untagged(),
            others: { 'plain.md': { tags: ['mine'] } },
          });
          await tick();
          if (ending === 'no id') {
            await editNote((fm) => delete fm['ir-id']);
          } else if (ending === 'other note') {
            panel.switchTo(vault.files.get('plain.md')!);
          } else {
            panel.view.destroy();
          }
          await tick();
          const query = vi.spyOn(repo, 'query');
          query.mockClear();

          flagRow(repo, 'article', true);
          panel.app.workspace.trigger(ROWS_RELOADED_EVENT);
          await tick();

          expect(query).not.toHaveBeenCalled();
          expect(panel.workspaceListenerCount(ROWS_RELOADED_EVENT)).toBe(0);
          panel.view.destroy();
          query.mockRestore();
        }
      ),
      { numRuns: 6 }
    );
  });

  it('holds one watch at most however often the editor switches notes, and none once it goes away', async () => {
    /** Each note the editor can show, and whether it claims an id. */
    const notes: Record<string, boolean> = {
      [ROW_REFERENCE]: true,
      'same.md': true,
      'other.md': true,
      'tagged.md': true,
      'plain.md': false,
    };
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...Object.keys(notes)), {
          minLength: 1,
          maxLength: 12,
        }),
        async (paths) => {
          const listeners = trackChangeListeners();
          try {
            const { panel, repo, vault } = await wireItemNote({
              table: 'article',
              row: 'live',
              atReference: true,
              frontmatter: untagged(),
              others: {
                'same.md': { 'ir-id': 'x' },
                'other.md': { 'ir-id': 'y', tags: ['mine'] },
                'tagged.md': { 'ir-id': 'z', tags: [ARTICLE_TAG] },
                'plain.md': { tags: ['mine'] },
              },
            });
            await tick();
            for (const path of paths) {
              panel.switchTo(vault.files.get(path)!);
              await tick();
            }
            const claimsId = notes[paths.at(-1)!];

            expect(listeners.count(repo)).toBe(claimsId ? 1 : 0);
            expect(panel.workspaceListenerCount(ROWS_RELOADED_EVENT)).toBe(
              claimsId ? 1 : 0
            );
            panel.view.destroy();
            expect(listeners.count(repo)).toBe(0);
            expect(panel.workspaceListenerCount(ROWS_RELOADED_EVENT)).toBe(0);
          } finally {
            listeners.restore();
          }
        }
      ),
      { numRuns: 30 }
    );
  });

  it('keeps one watch through edits that leave the note claiming the same row', async () => {
    const watchRow = vi.spyOn(ItemManager.prototype, 'watchRow');
    const { panel, editNote } = await wireItemNote({
      table: 'article',
      row: 'live',
      atReference: true,
      frontmatter: untagged(),
    });
    await tick();

    await editNote((fm) => {
      fm.extra = 1;
    });
    await editNote((fm) => {
      fm.tags = ['other'];
    });
    await editNote((fm) => {
      fm.tags = [ARTICLE_TAG];
    });

    expect(watchRow).toHaveBeenCalledOnce();
    expect(panel.workspaceListenerCount(ROWS_RELOADED_EVENT)).toBe(1);
  });

  it('follows the row a changed ir-id names instead', async () => {
    const { panel, repo, editNote } = await wireItemNote({
      table: 'article',
      row: 'live',
      atReference: true,
      frontmatter: untagged(),
    });
    await tick();

    await editNote((fm) => {
      fm['ir-id'] = 'y';
    });
    await tick();
    expect(panel.hasBar()).toBe(false);
    repo.mutate("UPDATE article SET id = 'y' WHERE id = 'x'");
    await tick();

    expect(panel.hasBar()).toBe(true);
  });

  it('looks again once a database is swapped in from disk, which reports no write', async () => {
    const { panel, repo } = await wireItemNote({
      table: 'article',
      row: 'live',
      atReference: true,
      frontmatter: untagged(),
    });
    await tick();

    await repo.takeIn("UPDATE article SET deleted = TRUE WHERE id = 'x'");
    await tick();
    expect(panel.hasBar()).toBe(true);

    panel.app.workspace.trigger(ROWS_RELOADED_EVENT);
    await tick();
    expect(panel.hasBar()).toBe(false);
  });
});

describe("the edit-mode bar following its note's type", () => {
  /** Any `tags` value, type tags well represented, as a list or a lone string. */
  const tagsArb = fc.oneof(
    fc.array(
      fc.oneof(fc.constantFrom(ARTICLE_TAG, SNIPPET_TAG, CARD_TAG), fc.string())
    ),
    fc.constantFrom(ARTICLE_TAG, SNIPPET_TAG, CARD_TAG, 'other'),
    fc.constant(undefined),
    fc.integer()
  );

  /** Whether `tags` names any item type, worked out apart from the code. */
  const namesAType = (tags: unknown) =>
    (Array.isArray(tags) || typeof tags === 'string') &&
    [ARTICLE_TAG, SNIPPET_TAG, CARD_TAG].some((tag) => tags.includes(tag));

  it('takes the bar off once the cache shows the type tags gone, reading nothing', async () => {
    // The reported bug: an un-import strips the tags from the open note
    const panel = mountPanel(makeHarness({ item: null }));
    await tick();
    expect(panel.hasBar()).toBe(true);

    panel.reportChange({ tags: ['keep-me'] });

    expect(panel.hasBar()).toBe(false);
    // Read once, when the editor opened, and never again
    expect(panel.getItemType).toHaveBeenCalledOnce();
  });

  it('shows and hides the bar as each reported change names a type or none', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(tagsArb, { maxLength: 6 }), async (changes) => {
        const panel = mountPanel(makeHarness(), {
          noteType: async () => null,
        });
        await tick();
        for (const tags of changes) {
          panel.reportChange(tags === undefined ? {} : { tags });
          expect(panel.hasBar()).toBe(namesAType(tags));
        }
        panel.view.destroy();
      }),
      { numRuns: 40 }
    );
  });

  it('takes the bar off a note whose changed text has no frontmatter', async () => {
    const panel = mountPanel(makeHarness());
    await tick();

    panel.reportChange(undefined);

    expect(panel.hasBar()).toBe(false);
  });

  it('leaves the bar alone for a change to another note', async () => {
    const panel = mountPanel(makeHarness());
    await tick();

    panel.reportChange({ tags: [] }, makeFile('notes/other.md'));

    expect(panel.hasBar()).toBe(true);
  });

  it('takes the bar off a note the vault no longer holds, whatever its tags', async () => {
    const panel = mountPanel(makeHarness());
    await tick();

    panel.dropFromVault();
    panel.reportChange({ tags: [ARTICLE_TAG] });

    expect(panel.hasBar()).toBe(false);
  });

  it('drops a read of the note that lands after a newer change', async () => {
    // A note over the vault's cache limit is read from the disk, slowly: its
    // un-import can be reported before the read made on opening it answers
    let answer: (type: NoteType | null) => void = () => {};
    const panel = mountPanel(makeHarness({ item: null }), {
      noteType: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });

    panel.reportChange({ tags: ['keep-me'] });
    answer('article');
    await tick();

    expect(panel.hasBar()).toBe(false);
  });

  it('applies the read made on opening when no change came after it', async () => {
    let answer: (type: NoteType | null) => void = () => {};
    const panel = mountPanel(makeHarness(), {
      noteType: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    expect(panel.hasBar()).toBe(false);

    answer('snippet');
    await tick();

    expect(panel.hasBar()).toBe(true);
  });

  it('follows another note opened in the same editor, and only it', async () => {
    const panel = mountPanel(makeHarness(), { noteType: async () => null });
    await tick();
    const other = makeFile('notes/other.md');

    panel.switchTo(other);
    await tick();
    // Its type is read afresh, and the old note's watch handed over
    expect(panel.getItemType).toHaveBeenLastCalledWith(other);
    expect(panel.app.metadataCache.offref).toHaveBeenCalledOnce();

    panel.reportChange({ tags: [ARTICLE_TAG] });
    expect(panel.hasBar()).toBe(false);
    panel.reportChange({ tags: [ARTICLE_TAG] }, other);
    expect(panel.hasBar()).toBe(true);
  });

  it('drops a read for a note this editor has since moved on from', async () => {
    // Opening a note, a change to it, then another note: the first read
    // answering last is about a note no longer shown
    const answers: ((type: NoteType | null) => void)[] = [];
    const panel = mountPanel(makeHarness(), {
      noteType: () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
    });
    panel.reportChange({ tags: [] });
    panel.switchTo(makeFile('notes/other.md'));
    expect(answers).toHaveLength(2);

    answers[0]('article');
    await tick();

    expect(panel.hasBar()).toBe(false);
  });

  it('keeps the bar it has through changes that keep the type', async () => {
    const harness = makeHarness();
    const panel = mountPanel(harness);
    await tick();
    const bar = panel.bar();

    panel.reportChange({ tags: [ARTICLE_TAG, 'more'] });
    await tick();

    expect(panel.bar()).toBe(bar);
    expect(harness.reviewManager.getReviewItemFromFile).toHaveBeenCalledOnce();
  });

  it('lets go of the cache when the editor goes away', async () => {
    const panel = mountPanel(makeHarness());
    await tick();
    const ref = panel.app.metadataCache.on.mock.results[0]?.value as unknown;

    panel.view.destroy();

    expect(panel.app.metadataCache.offref).toHaveBeenCalledExactlyOnceWith(ref);
  });

  it('ignores a change reported after the editor is gone', async () => {
    const panel = mountPanel(makeHarness());
    await tick();
    const typed = vi.spyOn(Obsidian, 'noteTypeFromCache');
    // With no file info left to unsubscribe through, the listener outlives it
    panel.clearInfo();
    panel.view.destroy();

    panel.reportChange({ tags: [ARTICLE_TAG] });

    expect(typed).not.toHaveBeenCalled();
  });
});
