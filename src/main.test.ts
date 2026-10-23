import { AutoImportWatcher } from '#/lib/AutoImportWatcher';
import {
  AUTO_IMPORT_DEBOUNCE_MS,
  AUTO_IMPORT_MAX_WAIT_MS,
  AUTO_IMPORT_TAG,
  DATA_DIRECTORY,
  PLUGIN_ICON,
} from '#/lib/constants';
import {
  loadDeviceState,
  SESSION_KEY,
  UI_STATE_KEY,
  WARNED_PATHS_KEY,
  type ReviewSession,
} from '#/lib/device-state';
import { refusedPathsWarning } from '#/lib/item-path-guard';
import ReviewManager from '#/lib/items/ReviewManager';
import { SnippetManager } from '#/lib/items/SnippetManager';
import { configureSuccessNotices, notify } from '#/lib/notices';
import * as ObsidianEditor from '#/lib/obsidian-editor';
import {
  SYNC_HOLD_MESSAGES,
  SYNC_WAIT_TIMEOUT_MS,
  syncExclusionMessage,
} from '#/lib/obsidian-sync';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import * as ObsidianPdf from '#/lib/pdf/obsidian-pdf';
import {
  DEVICE_ID_KEY,
  loadAutoImportWatermark,
  parsePluginData,
} from '#/lib/plugin-data';
import { queryClient } from '#/lib/query-client';
import {
  DatabaseLoadError,
  SQLJSRepository,
  StartupCancelledError,
  type SyncHold,
} from '#/lib/repository/SQLJSRepository';
import * as ReviewReminder from '#/lib/review-reminder';
import { DEFAULT_SETTINGS } from '#/lib/settings';
import {
  resetSession,
  setCurrentItemId,
  setPage,
  setShowAnswer,
  store,
  type ReviewPage,
} from '#/lib/store';
import type { Readiness, ReviewItem } from '#/lib/types';
import * as UnimportModule from '#/lib/unimport-article';
import {
  loadWatchedFolderLedger,
  saveWatchedFolderLedger,
} from '#/lib/watched-folder-ledger';
import IncrementalReadingPlugin, {
  startupFailureMessage,
  STILL_STARTING_NOTICE,
} from '#/main';
import { LeftoverWatch } from '#/views/LeftoverModal';
// The Vitest alias points `obsidian` at this same file, so the `Menu` built
// here is the one the plugin fills — importing it by path is what gives TS the
// stub's recorded `items`, which the real class does not expose.
import type {
  CandidateSource,
  FilterSources,
  ScanEvent,
} from '#/lib/bulk-import/types';
import {
  getIconIds,
  Menu,
  Notice,
  removeIcon,
  type MenuItem,
} from '#/test/__mocks__/obsidian';
import { BulkImportModal } from '#/views/BulkImportModal';
import { ImportModal } from '#/views/ImportModal';
import ReviewView from '#/views/ReviewView';
import fc from 'fast-check';
import {
  MarkdownView,
  TFile,
  TFolder,
  type TAbstractFile,
  type WorkspaceLeaf,
} from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `main.ts` pulls the schema in as a raw `.sql` import, which Vite cannot parse
// as a module. Mocking it is the documented way around that — see
// `src/db/migrations.test.ts` — and the contents are irrelevant here, since
// nothing in this file opens a database.
vi.mock('./db/schema.sql', () => ({ default: '' }));

// #region HELPERS

/**
 * The menu entries read only `path` and `extension` off the file they were
 * raised on; the extension is derived the way Obsidian derives it, lowercased.
 */
function makeFile(path = 'notes/Chapter 1.md'): TFile {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return { path, name, extension } as TFile;
}

/** A folder at `path`, as the file explorer raises its menu on one. */
function makeFolder(path: string): TFolder {
  return Object.assign(new TFolder(), {
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
  });
}

/**
 * The extension of any file the plugin cannot import: anything a vault can
 * hold but a note or a PDF, including no extension at all.
 */
const unimportableExtension = fc
  .oneof(fc.constantFrom('png', 'canvas', ''), fc.string())
  .filter((extension) => !['md', 'pdf'].includes(extension.toLowerCase()));

/** A file of type `extension` somewhere in the vault. */
function fileWithExtension(extension: string): TFile {
  return {
    path: `notes/thing.${extension}`,
    name: `thing.${extension}`,
    extension,
  } as TFile;
}

/** How many menu entries import a file with the advanced ones shown. */
const ADVANCED_IMPORT_COUNT = 5;

/** The icons of a menu holding `count` import entries and nothing else. */
function importsOnly(count: number): string[] {
  return Array.from({ length: count }, () => PLUGIN_ICON);
}

/**
 * Bare receiver for `addIRMenuItems`, carrying the slots it touches.
 * Constructing a real plugin would stand up the database and the workspace;
 * the method needs neither.
 */
function makeReceiver({
  advanced = false,
  file = makeFile() as TFile | null,
  imported = true,
  frontmatter = undefined as Record<string, unknown> | undefined,
  articleId = null as string | null,
  articlesUnder = false,
} = {}) {
  const importArticle = vi.fn();
  const goToContext = vi.fn().mockResolvedValue(undefined);
  // The id of the live article the file is, if any
  const articleIdAt = vi.fn((_file: TFile): string | null => articleId);
  // Whether a live article is in a folder, any folder
  const hasArticleUnder = vi.fn((_folder: string) => articlesUnder);
  const receiver = {
    settings: { showAdvancedImportMenuItems: advanced },
    // Truthy stands for a plugin that finished loading; the menu is suppressed
    // until then, since importing needs the manager.
    reviewManager: imported ? { articleIdAt, hasArticleUnder } : undefined,
    app: {
      vault: { getFileByPath: vi.fn(() => file) },
      // The cached frontmatter of `file`, and of nothing else.
      metadataCache: {
        getFileCache: vi.fn((f: TFile) =>
          f === file && frontmatter !== undefined ? { frontmatter } : null
        ),
      },
    },
    importArticle,
    importFromFolder: vi.fn(),
    unimportFromFolder: vi.fn(),
    actions: { goToContext },
  };
  return {
    receiver,
    importArticle,
    goToContext,
    articleIdAt,
    hasArticleUnder,
    file,
  };
}

/**
 * A leaf showing the review tab. `Object.create` stands in for a constructed
 * view, which the obsidian mock cannot produce, and answers the guard's
 * `instanceof` the way a real one would.
 */
function reviewLeaf(): WorkspaceLeaf {
  return {
    view: Object.create(ReviewView.prototype) as object,
  } as WorkspaceLeaf;
}

/** A leaf showing anything else — a plain note, say. */
function otherLeaf(): WorkspaceLeaf {
  return { view: {} } as WorkspaceLeaf;
}

/** Raise a file menu the way `workspace.trigger('file-menu', …)` does. */
function raiseMenu(
  receiver: ReturnType<typeof makeReceiver>['receiver'],
  leaf?: WorkspaceLeaf,
  file: TFile | TFolder = makeFile()
): Menu {
  const menu = new Menu();
  IncrementalReadingPlugin.prototype.addIRMenuItems.call(
    receiver as unknown as IncrementalReadingPlugin,
    menu as never,
    file,
    leaf
  );
  return menu;
}

/** Entry icons, in the order they were added; each import carries the plugin's. */
function iconsOf(menu: Menu) {
  return menu.items.map((item) => item.icon);
}

/** A click on a menu entry: any button Obsidian reports one for, any keys. */
const menuClickArb = fc.record({
  button: fc.constantFrom(0, 1),
  ctrlKey: fc.boolean(),
  metaKey: fc.boolean(),
  altKey: fc.boolean(),
  shiftKey: fc.boolean(),
});

/**
 * Where Obsidian opens a link clicked that way: a middle click is a new tab
 * whatever keys are held; Ctrl/Cmd is a new tab, +Alt a split, +Alt+Shift a
 * window; anything else is the tab the user is in.
 */
function paneFor(click: {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | false {
  if (click.button === 1) return 'tab';
  if (!click.ctrlKey && !click.metaKey) return false;
  if (!click.altKey) return 'tab';
  return click.shiftKey ? 'window' : 'split';
}

/**
 * Fire an entry's callback the way clicking it would. Obsidian hands the
 * callback the click event; the import entries ignore it, so none is built and
 * this file needs no DOM.
 */
function click(item: MenuItem | undefined): void {
  if (!item) throw new Error('menu entry not present');
  item.callback?.(undefined);
}

const DEVICE = 'device-a';

/**
 * Bare receiver for `resumeSession`, which touches only the pointer on disk,
 * the tracker holding the live one, and the lookup that validates whichever it
 * reads. `tracked` left out stands for startup, before tracking has begun.
 */
function makeResumeReceiver({
  session = { deviceId: DEVICE, itemId: 'item-1' },
  tracked,
  // Only the id and the dismissed flag are read off the resolved item.
  item = {
    data: { id: 'item-1', dismissed: 0 },
  } as unknown as ReviewItem | null,
}: {
  session?: ReviewSession | null;
  tracked?: string | null;
  item?: ReviewItem | null;
} = {}) {
  const saveSession = vi.fn();
  const getItemOrMissingFromId = vi.fn(() => Promise.resolve(item));
  const forget = vi.fn();
  const receiver = {
    deviceState: { session },
    app: { loadLocalStorage: vi.fn(() => DEVICE), saveLocalStorage: vi.fn() },
    reviewManager: { getItemOrMissingFromId },
    sessionTracker:
      tracked === undefined ? undefined : { itemId: tracked, forget },
    saveSession,
  };
  return { receiver, saveSession, getItemOrMissingFromId, forget };
}

/** Run `resumeSession` against a bare receiver. */
function resumeSession(
  receiver: ReturnType<typeof makeResumeReceiver>['receiver']
): Promise<boolean> {
  return IncrementalReadingPlugin.prototype.resumeSession.call(
    receiver as unknown as IncrementalReadingPlugin
  ) as Promise<boolean>;
}

/**
 * Bare receiver for `learn`. By default no review tab is open, which is the
 * branch that picks the landing page; `reviewTab` puts one up, focused or not.
 * The store is the module's own, so the page it lands on is read back from
 * there.
 */
function makeLearnReceiver({
  resumed = false,
  skipHomeScreen = false,
  reviewTab = 'none',
}: {
  resumed?: boolean;
  skipHomeScreen?: boolean;
  reviewTab?: 'none' | 'focused' | 'unfocused';
} = {}) {
  /**
   * What the store said as the view mounted. `setViewState` runs `onOpen`,
   * which renders the interface against the store as it finds it, so this is
   * the page the user actually sees first — not the one left behind at the end.
   */
  const pageAtMount: { page?: ReviewPage; itemId?: string | null } = {};
  const leaf = {
    setViewState: vi.fn(() => {
      pageAtMount.page = store.getState().page;
      pageAtMount.itemId = store.getState().currentItemId;
      return Promise.resolve();
    }),
    view: {},
  };
  const receiver = {
    settings: { skipHomeScreen },
    getOpenReviewLeaf: vi.fn(() => (reviewTab === 'none' ? null : leaf)),
    getActiveReviewView: vi.fn(() =>
      reviewTab === 'focused' ? { leaf } : null
    ),
    resumeSession: vi.fn((): Promise<boolean> => Promise.resolve(resumed)),
    app: {
      workspace: {
        getLeaf: vi.fn(() => leaf),
        revealLeaf: vi.fn(() => Promise.resolve()),
      },
    },
  };
  return { receiver, leaf, pageAtMount };
}

/** Run `learn` against a bare receiver. */
function learn(
  receiver: ReturnType<typeof makeLearnReceiver>['receiver'],
  initialItem?: ReviewItem,
  ...newLeaf: [] | [Parameters<IncrementalReadingPlugin['learn']>[1]]
): Promise<void> {
  return IncrementalReadingPlugin.prototype.learn.call(
    receiver as unknown as IncrementalReadingPlugin,
    initialItem,
    ...newLeaf
  ) as Promise<void>;
}

/** Only the id is read off an item handed to `learn`. */
const item = (id: string) => ({ data: { id } }) as unknown as ReviewItem;

/**
 * Bare receiver for `followMovedNotes`, over a database holding one article at
 * `one.md` and a vault holding its note — at `moved/one.md` when `moved`.
 * `indexingSignal` false stands for an Obsidian without `onCleanCache`, which
 * falls back to the `resolved` event; `finishIndexing` fires whichever it used.
 * `refusedPaths` are the item paths that already hold a refused character.
 */
function makeFollowReceiver({
  moved = true,
  indexingSignal = true,
  refusedPaths = [] as string[],
  warned = [] as string[],
  watcherMade = true,
} = {}) {
  const unloaders: (() => void)[] = [];
  let whenIndexed: (() => void) | undefined;
  const note = { path: moved ? 'moved/one.md' : 'one.md' } as TFile;
  const repo = {
    query: vi.fn((sql: string, params: unknown[]) =>
      sql.includes('FROM article') && params[0] === 0
        ? [{ rowid: 1, id: 'a', reference: 'one.md', deleted: 0 }]
        : []
    ),
    mutate: vi.fn(),
    transaction: vi.fn((work: () => Promise<void>) => work()),
  };
  const refreshAllHighlights = vi.fn(() => Promise.resolve());
  const followChildSources = vi.fn(() => Promise.resolve());
  const claimMovedFiles = vi.fn(() => Promise.resolve());
  const itemPathsWithRefusedChars = vi.fn(() => Promise.resolve(refusedPaths));
  const resolvedRef = { event: 'resolved' };
  const metadataCache = {
    getFileCache: vi.fn(() => ({ frontmatter: { 'ir-id': 'a' } })),
    onCleanCache: indexingSignal
      ? vi.fn((callback: () => void) => {
          whenIndexed = callback;
        })
      : undefined,
    on: vi.fn((_name: string, callback: () => void) => {
      whenIndexed = callback;
      return resolvedRef;
    }),
    offref: vi.fn(),
  };
  const saveData = vi.fn(() => Promise.resolve());
  const saveLocalStorage = vi.fn();
  const startupScan = vi.fn(() => Promise.resolve());
  const runCatchUpScan = vi.fn(() => Promise.resolve());
  const watcher = { runCatchUpScan };
  let makeWatcher!: () => void;
  const receiver = {
    leftovers: { startupScan },
    autoImportWatcherMade: {
      promise: watcherMade
        ? Promise.resolve(watcher)
        : new Promise<typeof watcher>(
            (resolve) => (makeWatcher = () => resolve(watcher))
          ),
    },
    deviceState: { warnedRefusedPaths: [...warned] },
    saveData,
    rememberWarnedPaths: (
      IncrementalReadingPlugin.prototype as unknown as {
        rememberWarnedPaths: unknown;
      }
    ).rememberWarnedPaths,
    register: vi.fn((unloader: () => void) => unloaders.push(unloader)),
    registerEvent: vi.fn(),
    reviewManager: {
      refreshAllHighlights,
      followChildSources,
      claimMovedFiles,
      itemPathsWithRefusedChars,
    },
    app: {
      vault: {
        getFileByPath: vi.fn((path: string) =>
          path === note.path ? note : null
        ),
        getMarkdownFiles: vi.fn(() => [note]),
      },
      metadataCache,
      saveLocalStorage,
    },
  };
  return {
    receiver,
    repo,
    metadataCache,
    resolvedRef,
    refreshAllHighlights,
    followChildSources,
    claimMovedFiles,
    itemPathsWithRefusedChars,
    saveData,
    saveLocalStorage,
    startupScan,
    runCatchUpScan,
    /** Have `watchAutoImports` make the watcher, when `watcherMade` was false. */
    makeWatcher: () => makeWatcher(),
    finishIndexing: () => whenIndexed?.(),
    unload: () => unloaders.forEach((unloader) => unloader()),
  };
}

/** Run `followMovedNotes` against a bare receiver. */
function followMovedNotes({
  receiver,
  repo,
}: ReturnType<typeof makeFollowReceiver>) {
  (
    IncrementalReadingPlugin.prototype as unknown as {
      followMovedNotes(repo: unknown): void;
    }
  ).followMovedNotes.call(receiver, repo);
}

/** Give a scan that was never going to start long enough to show it didn't. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** The ids of the commands that make a snippet or card, by what they make. */
const EXTRACT_COMMANDS = {
  snippet: 'extract-selection',
  card: 'create-card',
} as const;

type ExtractKind = keyof typeof EXTRACT_COMMANDS;

/** A note open in its own tab, in editing mode unless `reading`. */
function markdownView({ reading = false } = {}): MarkdownView {
  const editMode = {};
  const previewMode = {};
  return Object.assign(Object.create(MarkdownView.prototype) as object, {
    getViewType: () => 'markdown',
    editMode,
    previewMode,
    currentMode: reading ? previewMode : editMode,
  }) as unknown as MarkdownView;
}

/**
 * Bare receiver for `addExtractCommands`, with the active tab showing
 * `where`: the review tab, a note, Obsidian's own PDF tab (with
 * `tabFile` open), another file view of type `otherViewType`, or none.
 * The commands it registers are kept by id, to be run the way the command
 * palette runs them.
 */
function makeExtractReceiver({
  where = 'review' as 'review' | 'note' | 'pdf' | 'other' | 'none',
  reading = false,
  editor = true,
  itemExtension = null as string | null,
  tabFile = { path: 'papers/a.pdf', extension: 'pdf' } as TFile | null,
  otherViewType = 'image',
  loaded = true,
} = {}) {
  const reviewView = Object.create(ReviewView.prototype) as ReviewView;
  // The review tab's item, by its file's extension; `null` for none
  reviewView.currentItemFile = () =>
    itemExtension === null
      ? null
      : ({
          path: `items/a.${itemExtension}`,
          extension: itemExtension,
        } as TFile);
  const noteView = markdownView({ reading });
  const fileView = {
    getViewType: () => (where === 'pdf' ? 'pdf' : otherViewType),
    file: tabFile,
  };
  const actions = {
    extract: vi.fn(() => Promise.resolve()),
    extractFromPdfTab: vi.fn(() => Promise.resolve()),
    createSnippet: vi.fn(() => Promise.resolve(null)),
    createCard: vi.fn(() => Promise.resolve(null)),
  };
  const commands = new Map<string, (checking: boolean) => boolean | void>();
  const unloaders: (() => void)[] = [];
  const receiver = {
    // Absent until the plugin has finished loading
    reviewManager: loaded ? {} : undefined,
    actions,
    register: vi.fn((unloader: () => void) => unloaders.push(unloader)),
    addCommand: vi.fn(
      (command: {
        id: string;
        checkCallback: (checking: boolean) => boolean | void;
      }) => {
        commands.set(command.id, command.checkCallback);
      }
    ),
    getActiveReviewView: vi.fn(() => (where === 'review' ? reviewView : null)),
    app: {
      workspace: {
        activeEditor: editor ? { editor: {} } : null,
        getActiveViewOfType: vi.fn(() => (where === 'note' ? noteView : null)),
        getActiveFileView: vi.fn(() =>
          where === 'pdf' || where === 'other' ? fileView : null
        ),
      },
    },
  };
  (
    IncrementalReadingPlugin.prototype as unknown as {
      addExtractCommands(): void;
    }
  ).addExtractCommands.call(receiver);

  /** Run the command that makes `kind`, or only ask whether it can run. */
  const run = (kind: ExtractKind, checking = false) => {
    const callback = commands.get(EXTRACT_COMMANDS[kind]);
    if (!callback) throw new Error(`no command makes a ${kind}`);
    return callback(checking);
  };
  const unload = () => unloaders.forEach((unloader) => unloader());
  return { receiver, actions, reviewView, fileView, run, unload };
}

/**
 * Each import command, by id, with the options it hands `importArticle`. All
 * but the first appear only with `showAdvancedImportCommands` on.
 */
const IMPORT_COMMANDS = {
  'import-article': { opts: undefined },
  'import-article-copy': {
    opts: { copyOnImport: true, showImportDialog: false },
  },
  'import-article-in-place': {
    opts: { copyOnImport: false, showImportDialog: false },
  },
  'open-import-dialog': { opts: { showImportDialog: true } },
  'quick-import': { opts: { showImportDialog: false } },
} as const;

type ImportCommandId = keyof typeof IMPORT_COMMANDS;

const importCommandIds = fc.constantFrom(
  ...(Object.keys(IMPORT_COMMANDS) as ImportCommandId[])
);

/**
 * A plugin with every import command registered, basic and advanced, and the
 * active tab showing `where`: a file of type `extension`, the review tab, or
 * nothing. Built on the prototype so the commands reach the real helpers they
 * share; the slots they touch are set by hand.
 */
function makeImportCommandReceiver({
  extension = 'md',
  where = 'file' as 'file' | 'review' | 'none',
  loaded = true,
  view = null as unknown,
  showImportDialog = false,
} = {}) {
  const file = fileWithExtension(extension);
  const importArticle = vi.fn(() => Promise.resolve());
  const importWebPage = vi.fn(() => Promise.resolve(null));
  const recordImport = vi.fn();
  /** The palette: registered commands by id, dropped again on removal. */
  const commands = new Map<
    string,
    { name: string; checkCallback: (checking: boolean) => boolean | void }
  >();
  const receiver = Object.assign(
    Object.create(IncrementalReadingPlugin.prototype) as object,
    {
      reviewManager: loaded ? { importWebPage } : undefined,
      actions: { recordImport },
      settings: { defaultPriority: 30, showImportDialog },
      importArticle,
      addCommand: vi.fn(
        (command: {
          id: string;
          name: string;
          checkCallback: (checking: boolean) => boolean | void;
        }) => {
          commands.set(command.id, command);
        }
      ),
      removeCommand: vi.fn((id: string) => {
        commands.delete(id);
      }),
      getActiveReviewView: vi.fn(() =>
        where === 'review'
          ? (Object.create(ReviewView.prototype) as ReviewView)
          : null
      ),
      app: {
        workspace: {
          getActiveFileView: vi.fn(() => (where === 'none' ? null : { file })),
          getActiveViewOfType: vi.fn(() => view),
        },
      },
    }
  ) as unknown as {
    addImportCommands(): void;
    toggleAdvancedCommands(enable: boolean): void;
  };
  receiver.addImportCommands();
  receiver.toggleAdvancedCommands(true);

  /** Run the command, or only ask whether it can run. */
  const run = (id: ImportCommandId, checking = false) => {
    const command = commands.get(id);
    if (!command) throw new Error(`no command ${id}`);
    return command.checkCallback(checking);
  };
  return {
    receiver,
    commands,
    file,
    importArticle,
    importWebPage,
    recordImport,
    run,
  };
}

/**
 * A view shaped as Obsidian's web viewer is, showing a page at
 * `https://example.com/page` that reads as `content` (a page, if not given;
 * `undefined` given is answered as is).
 */
function makeWebViewer(...args: [content?: unknown]) {
  const content = args.length > 0 ? args[0] : { title: 'Page', md: 'Text' };
  return {
    getViewType: () => 'webviewer',
    getReaderModeContent: vi.fn(() => Promise.resolve(content)),
    url: 'https://example.com/page',
  };
}

/** Views a page can't be imported from: not web viewers it can read. */
const notWebViewerArb = fc.oneof(
  fc.constant(null),
  fc.constant({ getViewType: () => 'webviewer' }),
  fc.constant({
    getViewType: () => 'markdown',
    getReaderModeContent: () => Promise.resolve({ title: 'x', md: 'y' }),
  }),
  fc.anything()
);

/**
 * Stand in for the import dialog in a test without a DOM: `open` opens
 * nothing, and each dialog opened is handed back to read or close.
 */
function stubImportDialog() {
  // The mock modal builds its content element in its constructor; any
  // element will do for a dialog never shown.
  vi.stubGlobal('document', { createElement: () => ({}) });
  const open = vi
    .spyOn(ImportModal.prototype, 'open')
    .mockImplementation(() => {});
  const dialogs = () => open.mock.contexts as ImportModal[];
  return { open, dialogs };
}

/**
 * Bare receiver for `importArticle`, with the dialog off and a copy not made
 * unless a call's options say otherwise. `call` runs the method on it.
 */
function makeImportReceiver() {
  /** What the import answers, which the undo entry is recorded for. */
  const result = { articleId: 'imported', effect: 'created', article: null };
  const importArticle = vi.fn(() => Promise.resolve(result));
  const recordImport = vi.fn();
  const receiver = {
    settings: {
      showImportDialog: false,
      copyOnImport: false,
      defaultPriority: 3,
    },
    reviewManager: { importArticle },
    actions: { recordImport },
  };
  const call = async (file: TFile, opts?: Record<string, boolean>) => {
    await IncrementalReadingPlugin.prototype.importArticle.call(
      receiver as unknown as IncrementalReadingPlugin,
      file,
      opts
    );
  };
  return { importArticle, recordImport, result, call };
}

/**
 * Stands the plugin's database up against a stub repository, and hands back
 * the reload hook it gave the repository. `resync` stands for the action
 * bars, registered once the database is up.
 */
async function startDatabase(
  resync: (() => void) | undefined,
  extra: Record<string, unknown> = {}
) {
  let onReloadFromDisk: (() => void | Promise<void>) | undefined;
  let onWriteBlocked: ((error: Error) => void) | undefined;
  let onWritesResumed: (() => void) | undefined;
  const handleFileChange = vi.fn(async () => {});
  vi.spyOn(SQLJSRepository, 'start').mockImplementation((params) => {
    onReloadFromDisk = params.onReloadFromDisk;
    onWriteBlocked = params.onWriteBlocked;
    onWritesResumed = params.onWritesResumed;
    return Promise.resolve({
      onDataChange: vi.fn(() => () => {}),
      handleFileChange,
    } as unknown as SQLJSRepository);
  });
  vi.spyOn(ReviewManager.prototype, 'refreshAllHighlights').mockResolvedValue(
    undefined
  );
  vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
  const receiver = {
    app: { vault: { on: vi.fn() } },
    register: vi.fn(),
    registerEvent: vi.fn(),
    followMovedNotes: vi.fn(),
    createLeftoverWatch: vi.fn(),
    resyncLeafActionBars: resync,
    ...extra,
  };
  await (
    IncrementalReadingPlugin.prototype as unknown as {
      initReviewManager(): Promise<void>;
    }
  ).initReviewManager.call(receiver);
  /** Fire the vault event `name` for `file`, as Obsidian would. */
  const fireVault = (name: string, file: unknown) => {
    for (const [event, handler] of receiver.app.vault.on.mock.calls as [
      string,
      (file: unknown) => void,
    ][]) {
      if (event === name) handler(file);
    }
  };
  return {
    reload: () => onReloadFromDisk!(),
    blockWrites: (error: Error) => onWriteBlocked!(error),
    resumeWrites: () => onWritesResumed!(),
    fireVault,
    handleFileChange,
  };
}

/**
 * A plugin over a stub database whose rows name `items`, hearing renames and
 * deletes as its listeners do. Each undo the guard asks for is a
 * `Vault.rename` run at once through `runAsyncLinkUpdate`, moving the file
 * back and firing `rename` for it.
 */
async function startRenames(items: readonly string[] = []) {
  const readinessListeners = new Set<(state: Readiness) => void>();
  const repo = {
    onDataChange: vi.fn(() => () => {}),
    readiness: 'ready' as Readiness,
    writeRefusal: () => null,
    onReadinessChange: (listener: (state: Readiness) => void) => {
      readinessListeners.add(listener);
      return () => readinessListeners.delete(listener);
    },
  };
  /** Have the repository become `state`, telling its listeners. */
  const becomes = (state: Readiness) => {
    repo.readiness = state;
    for (const listener of [...readinessListeners]) listener(state);
  };
  vi.spyOn(SQLJSRepository, 'start').mockResolvedValue(
    repo as unknown as SQLJSRepository
  );
  vi.spyOn(ReviewManager.prototype, 'isItemFileAt').mockImplementation(
    (_file, path) => items.includes(path)
  );
  vi.spyOn(ReviewManager.prototype, 'referencesUnder').mockImplementation(
    (folder) => new Set(items.filter((path) => path.startsWith(`${folder}/`)))
  );
  const follow = vi
    .spyOn(ReviewManager.prototype, 'handleExternalRename')
    .mockResolvedValue(undefined);
  const deletion = vi
    .spyOn(ReviewManager.prototype, 'handleDeletion')
    .mockResolvedValue(undefined);
  const notify = vi.spyOn(Obsidian, 'notify');
  const plugin = IncrementalReadingPlugin.prototype as unknown as Record<
    string,
    unknown
  >;
  /** What the vault holds, by path. */
  const entries = new Map<string, TFile | TFolder>();
  const vaultRename = vi.fn(async (entry: TFile | TFolder, to: string) => {
    const from = entry.path;
    entries.delete(from);
    entry.path = to;
    entries.set(to, entry);
    rename(entry, from);
  });
  const receiver: Record<string, unknown> = {
    app: {
      vault: {
        on: vi.fn(),
        getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
        rename: vaultRename,
      },
      // Runs each op at once, as a job of its own
      fileManager: { runAsyncLinkUpdate: (op: () => Promise<void>) => op() },
    },
    register: vi.fn(),
    registerEvent: vi.fn(),
    followMovedNotes: vi.fn(),
    createLeftoverWatch: vi.fn(),
    onVaultRename: plugin.onVaultRename,
    onVaultDelete: plugin.onVaultDelete,
    followRename: plugin.followRename,
  };
  /** Hear that `entry`, now in the vault at its path, moved from `oldPath`. */
  const rename = (entry: TFile | TFolder, oldPath: string) => {
    entries.delete(oldPath);
    entries.set(entry.path, entry);
    (receiver.onVaultRename as (entry: unknown, oldPath: string) => void).call(
      receiver,
      entry,
      oldPath
    );
  };
  /** Hear that `entry` was deleted. */
  const remove = (entry: TFile) => {
    entries.delete(entry.path);
    (receiver.onVaultDelete as (entry: unknown) => void).call(receiver, entry);
  };
  const start = async () => {
    await (plugin.initReviewManager as () => Promise<void>).call(receiver);
  };
  return {
    rename,
    remove,
    start,
    follow,
    deletion,
    notify,
    entries,
    vaultRename,
    becomes,
  };
}

/** A vault file at `path`, as `instanceof TFile` tells it. */
const tFileAt = (path: string) =>
  Object.assign(new TFile(), {
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
  });

/** A plugin hearing creations, and what it is left holding. */
function makeCreationReceiver(refused: (string | null)[]) {
  let created: ((file: unknown) => void) | undefined;
  let fire: (() => void) | undefined;
  const unloaders: (() => void)[] = [];
  const handleCreation = vi.fn(() => Promise.resolve(refused.shift() ?? null));
  const receiver = {
    deviceState: { warnedRefusedPaths: ['old|.md'] },
    saveData: vi.fn(() => Promise.resolve()),
    rememberWarnedPaths: (
      IncrementalReadingPlugin.prototype as unknown as {
        rememberWarnedPaths: unknown;
      }
    ).rememberWarnedPaths,
    reviewManager: undefined as unknown,
    app: {
      saveLocalStorage: vi.fn(),
      vault: {
        on: vi.fn((_name: string, callback: (file: unknown) => void) => {
          created = callback;
          return {};
        }),
      },
    },
    register: vi.fn((unloader: () => void) => unloaders.push(unloader)),
    registerEvent: vi.fn(),
  };
  const timer = vi.fn((run: () => void) => {
    fire = run;
    return () => (fire = undefined);
  });
  (
    IncrementalReadingPlugin.prototype as unknown as {
      watchCreations(timer: unknown): void;
    }
  ).watchCreations.call(receiver, timer);
  return {
    receiver,
    handleCreation,
    create: (file: unknown) => created!(file),
    fire: () => fire?.(),
    unload: () => unloaders.forEach((unloader) => unloader()),
  };
}

/**
 * A plugin watching for notes that gain a trigger tag, its settings at their
 * defaults but with importing by tag on, and no review manager yet.
 */
function makeAutoImportReceiver() {
  type Changed = (file: TFile, data: string, cache: unknown) => void;
  let changed: Changed | undefined;
  const changedRef = { event: 'changed' };
  type Arrived = (file: TFile, oldPath: string) => void;
  const arrivals = new Map<string, Arrived>();
  const arrivalRefs = {
    create: { event: 'create' },
    rename: { event: 'rename' },
    delete: { event: 'delete' },
  };
  const unloaders: (() => void)[] = [];
  const files = new Map<string, TFile>();
  const caches = new Map<TFile, unknown>();
  const importTaggedNotes = vi.fn(
    (_entries: { file: TFile }[], _options: unknown): Promise<unknown[]> =>
      Promise.resolve([])
  );
  const hasItemRow = vi.fn((_id: string) => Promise.resolve(false));
  const recordImport = vi.fn();
  const storage = new Map<string, unknown>();
  const settingsListeners = new Set<() => void>();
  const receiver = {
    settings: { ...structuredClone(DEFAULT_SETTINGS), autoImportOnTag: true },
    reviewManager: undefined as unknown,
    actions: { recordImport },
    autoImportWatcher: undefined as unknown,
    autoImportWatcherMade: { resolve: vi.fn() },
    onSettingsChange: (listener: () => void) => {
      settingsListeners.add(listener);
      return () => settingsListeners.delete(listener);
    },
    app: {
      loadLocalStorage: (key: string): unknown => storage.get(key) ?? null,
      saveLocalStorage: (key: string, data: unknown) => {
        storage.set(key, data);
      },
      vault: {
        getFileByPath: (path: string) => files.get(path) ?? null,
        getFiles: () => [...files.values()],
        on: vi.fn((name: keyof typeof arrivalRefs, callback: Arrived) => {
          arrivals.set(name, callback);
          return arrivalRefs[name];
        }),
      },
      metadataCache: {
        on: vi.fn((name: string, callback: Changed) => {
          if (name === 'changed') changed = callback;
          return changedRef;
        }),
        getFileCache: (file: TFile) => caches.get(file) ?? null,
      },
    },
    register: vi.fn((unloader: () => void) => unloaders.push(unloader)),
    registerEvent: vi.fn(),
  };
  (
    IncrementalReadingPlugin.prototype as unknown as {
      watchAutoImports(): void;
    }
  ).watchAutoImports.call(receiver);
  return {
    receiver,
    importTaggedNotes,
    hasItemRow,
    recordImport,
    changedRef,
    arrivalRefs,
    /**
     * Have the review manager up, importing through `importTaggedNotes` and
     * looking ids up through `hasItemRow`.
     */
    startReviewManager() {
      receiver.reviewManager = { importTaggedNotes, hasItemRow };
    },
    /** A note at `path` re-indexed with `frontmatter`, as Obsidian tells of it. */
    change(path: string, frontmatter: Record<string, unknown>) {
      const file = files.get(path) ?? tFileAt(path);
      files.set(path, file);
      const cache = { frontmatter };
      caches.set(file, cache);
      changed!(file, '', cache);
      return file;
    },
    /** How many listen for changes to the settings. */
    settingsListeners: () => settingsListeners.size,
    /** Save the settings as they now stand, as the settings tab does. */
    saveSettings: () => settingsListeners.forEach((listener) => listener()),
    /**
     * A file Obsidian tells of creating at `path`, or of moving there from
     * `oldPath`. A note's cache, once read, has no frontmatter.
     */
    arrive(path: string, oldPath?: string) {
      const file = Object.assign(tFileAt(path), {
        extension: path.slice(path.lastIndexOf('.') + 1),
        stat: { ctime: 0, mtime: 0, size: 1 },
      });
      files.set(path, file);
      if (oldPath === undefined) {
        arrivals.get('create')!(file, '');
      } else {
        caches.set(file, {});
        arrivals.get('rename')!(file, oldPath);
      }
      return file;
    },
    /** Delete the file at `path`, as Obsidian tells of it. */
    remove(path: string) {
      const file = files.get(path) ?? tFileAt(path);
      files.delete(path);
      arrivals.get('delete')!(file, '');
    },
    unload: () => unloaders.forEach((unloader) => unloader()),
  };
}

/**
 * A workspace holding `views` in leaves of the review type: each a review
 * tab, or a leaf Obsidian has not built its view for yet (a deferred view).
 */
function makeWorkspaceReceiver(views: ('review' | 'deferred')[]) {
  const synced: number[] = [];
  const leaves = views.map((kind, i) => {
    // A deferred view answers to the type it stands in for.
    if (kind === 'deferred') {
      return { view: { getViewType: (): string => ReviewView.viewType } };
    }
    const view = Object.create(ReviewView.prototype) as ReviewView;
    view.syncTitleBar = vi.fn(() => {
      synced.push(i);
    });
    return { view };
  });
  const getLeavesOfType = vi.fn((type: string) =>
    type === ReviewView.viewType ? leaves : []
  );
  const receiver = { app: { workspace: { getLeavesOfType } } };
  return { receiver, synced };
}

/**
 * Obsidian Sync's plugin instance as `app.internalPlugins` hands it out
 * (undocumented), with only what the plugin reads of it.
 */
function fakeSync(fields: {
  status?: string;
  pause?: boolean;
  ready?: boolean;
  /** What `filter.allowSyncFile` answers for the database file. */
  allowed?: boolean;
  allowTypes?: string[];
  ignoreFolders?: string[];
}) {
  return {
    getStatus: () => fields.status ?? 'synced',
    pause: fields.pause ?? false,
    ready: fields.ready ?? true,
    newServerFiles: [],
    filter: {
      allowSyncFile: () => fields.allowed ?? true,
      allowTypes: new Set(fields.allowTypes ?? ['image', 'unsupported']),
      ignoreFolders: fields.ignoreFolders ?? [],
    },
    on: vi.fn(() => ({})),
    offref: vi.fn(),
  };
}

/** An `app` whose Sync plugin is `sync`, or off when null. */
const appWithSync = (sync: unknown) => ({
  vault: { on: vi.fn() },
  internalPlugins: { getEnabledPluginById: vi.fn(() => sync) },
});

/**
 * Bare receiver for `onload`, carrying the slots it touches before handing
 * off to `onLayoutReady`, which it never calls. `iconsAtRibbon` records which
 * icons Obsidian knew of when the ribbon button was drawn.
 */
function makeLoadReceiver() {
  const ribbonIcons: string[] = [];
  const iconsAtRibbon: string[][] = [];
  const receiver = {
    settings: { showAdvancedImportCommands: false },
    app: {
      workspace: { on: vi.fn(), onLayoutReady: vi.fn() },
      vault: { on: vi.fn() },
    },
    loadSettings: vi.fn().mockResolvedValue(undefined),
    addRibbonIcon: vi.fn((icon: string) => {
      ribbonIcons.push(icon);
      iconsAtRibbon.push(getIconIds());
      return { addClass: vi.fn() };
    }),
    addExtractCommands: vi.fn(),
    addImportCommands: vi.fn(),
    addBulkImportCommand: vi.fn(),
    addCommand: vi.fn(),
    registerEvent: vi.fn(),
    addSettingTab: vi.fn(),
  };
  return { receiver, ribbonIcons, iconsAtRibbon };
}

/**
 * Obsidian's per-vault localStorage as its source has it: values kept as
 * JSON, `null` for a key never set, and any falsy value removing the key.
 */
function makeObsidianLocalStorage(initial: Record<string, unknown> = {}) {
  const entries = new Map<string, string>();
  const saveLocalStorage = vi.fn((key: string, data: unknown) => {
    if (data) entries.set(key, JSON.stringify(data));
    else entries.delete(key);
  });
  for (const [key, value] of Object.entries(initial)) {
    if (value) entries.set(key, JSON.stringify(value));
  }
  return {
    entries,
    loadLocalStorage: (key: string): unknown => {
      const json = entries.get(key);
      return json ? (JSON.parse(json) as unknown) : null;
    },
    saveLocalStorage,
  };
}

/**
 * A bare plugin over `storage`, whose `data.json` holds `raw`. What it writes
 * to the file lands in `written`, as JSON would keep it.
 */
function makeStoragePlugin(
  storage: ReturnType<typeof makeObsidianLocalStorage>,
  raw: unknown = { settings: {} }
) {
  const plugin = new IncrementalReadingPlugin({} as never, {} as never);
  const written: unknown[] = [];
  // The obsidian mock's Plugin has neither to spy on
  const saveData = vi.fn((data: unknown) => {
    written.push(JSON.parse(JSON.stringify(data)));
    return Promise.resolve();
  });
  Object.assign(plugin, {
    app: storage,
    loadData: vi.fn(() => Promise.resolve(raw)),
    saveData,
  });
  return { plugin, saveData, written };
}

/** A session pointer of any shape, empty ids included, or none. */
const sessionOrNoneArb = fc.option(
  fc.record({ deviceId: fc.string(), itemId: fc.string() }),
  { nil: null }
);

/** What a device may already keep for itself, any key left unset. */
const storedDeviceStateArb = fc.record(
  {
    [SESSION_KEY]: fc.oneof(
      fc.string().map((itemId) => ({ deviceId: DEVICE, itemId })),
      fc.anything()
    ),
    [UI_STATE_KEY]: fc.oneof(
      fc.record({ folderImportIncludeSubfolders: fc.boolean() }),
      fc.anything()
    ),
    [WARNED_PATHS_KEY]: fc.oneof(fc.array(fc.string()), fc.anything()),
  },
  { requiredKeys: [] }
);

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IncrementalReadingPlugin.addIRMenuItems', () => {
  it('offers the import from a menu raised without a leaf', () => {
    // The file explorer's context menu passes none.
    const { receiver } = makeReceiver();

    const menu = raiseMenu(receiver);

    expect(iconsOf(menu)).toEqual(importsOnly(1));
    expect(menu.items[0]?.section).toBe('incremental-reading');
  });

  it("still offers the import from a plain note's own menu", () => {
    // The discriminator for the guard below: a note's ⋮ menu reports the same
    // `more-options` source the review tab's does, so only the leaf tells them
    // apart.
    const { receiver } = makeReceiver();

    const menu = raiseMenu(receiver, otherLeaf());

    expect(iconsOf(menu)).toEqual(importsOnly(1));
  });

  it('marks every import entry with the plugin icon', () => {
    const { receiver } = makeReceiver({ advanced: true });

    expect(iconsOf(raiseMenu(receiver))).toEqual(
      importsOnly(ADVANCED_IMPORT_COUNT)
    );
  });

  it('stays out of the review tab, where the note is already an item', () => {
    const { receiver } = makeReceiver();

    const menu = raiseMenu(receiver, reviewLeaf());

    expect(menu.items).toHaveLength(0);
  });

  it('keeps the advanced entries behind their setting', () => {
    const plain = makeReceiver({ advanced: false });
    const advanced = makeReceiver({ advanced: true });

    expect(iconsOf(raiseMenu(plain.receiver))).toEqual(importsOnly(1));
    expect(iconsOf(raiseMenu(advanced.receiver))).toEqual(
      importsOnly(ADVANCED_IMPORT_COUNT)
    );
  });

  it('imports the note the menu was raised on', () => {
    const { receiver, importArticle, file } = makeReceiver();
    const menu = raiseMenu(receiver);

    click(menu.items[0]);

    expect(importArticle).toHaveBeenCalledWith(file);
  });

  it('imports a copy of the note from the copy entry', () => {
    const { receiver, importArticle, file } = makeReceiver({ advanced: true });
    const menu = raiseMenu(receiver);

    click(menu.items.find((i) => i.title === 'Import a copy'));

    expect(importArticle).toHaveBeenCalledExactlyOnceWith(file, {
      copyOnImport: true,
      showImportDialog: false,
    });
  });

  it('offers to import from a folder, and to un-import from it only while a live article is under it', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (advanced, articlesUnder) => {
        const { receiver, hasArticleUnder } = makeReceiver({
          advanced,
          articlesUnder,
          file: null,
        });
        const folder = makeFolder('notes/reading');

        const menu = raiseMenu(receiver, undefined, folder);

        expect(iconsOf(menu)).toEqual([
          PLUGIN_ICON,
          ...(articlesUnder ? ['lucide-folder-x'] : []),
        ]);
        expect(hasArticleUnder).toHaveBeenCalledExactlyOnceWith(folder.path);
        for (const item of menu.items) {
          expect(item.section).toBe('incremental-reading');
        }
        click(menu.items[0]);
        expect(receiver.importFromFolder).toHaveBeenCalledExactlyOnceWith(
          folder
        );
        expect(receiver.unimportFromFolder).not.toHaveBeenCalled();
        if (!articlesUnder) return;
        click(menu.items[1]);
        expect(receiver.unimportFromFolder).toHaveBeenCalledExactlyOnceWith(
          folder
        );
        expect(receiver.importFromFolder).toHaveBeenCalledOnce();
      })
    );
  });

  it('offers no folder import before the review manager is up, or in the review tab', () => {
    const waiting = makeReceiver({ imported: false });
    const ready = makeReceiver();

    expect(
      raiseMenu(waiting.receiver, undefined, makeFolder('notes')).items
    ).toHaveLength(0);
    expect(
      raiseMenu(ready.receiver, reviewLeaf(), makeFolder('notes')).items
    ).toHaveLength(0);
  });

  it('says nothing about a path that resolves to no file', () => {
    const { receiver } = makeReceiver({ file: null });

    const menu = raiseMenu(receiver);

    expect(menu.items).toHaveLength(0);
  });

  it('waits for the review manager before offering to import', () => {
    // The event can fire before `onload` finishes wiring the plugin up.
    const { receiver } = makeReceiver({ imported: false });

    const menu = raiseMenu(receiver);

    expect(menu.items).toHaveLength(0);
  });

  it("offers the context of a note that carries an item's id, and of no other", () => {
    fc.assert(
      fc.property(
        fc.option(
          fc.dictionary(
            fc.constantFrom('ir-id', 'tags', 'source', 'other'),
            fc.oneof(fc.string(), fc.integer(), fc.constant(null))
          ),
          { nil: undefined }
        ),
        fc.boolean(),
        (frontmatter, withLeaf) => {
          const { receiver } = makeReceiver({ frontmatter });

          const menu = raiseMenu(receiver, withLeaf ? otherLeaf() : undefined);

          const entry = menu.items.find((i) => i.title === 'Go to context');
          if (typeof frontmatter?.['ir-id'] === 'string') {
            expect(entry?.section).toBe('incremental-reading');
            expect(entry?.icon).toBe('lucide-locate');
          } else {
            expect(entry).toBeUndefined();
          }
        }
      )
    );
  });

  it('offers no import on a file whose type it cannot import', () => {
    fc.assert(
      fc.property(
        unimportableExtension,
        fc.boolean(),
        fc.boolean(),
        (extension, advanced, withLeaf) => {
          const file = fileWithExtension(extension);
          const { receiver } = makeReceiver({ advanced, file });

          const menu = raiseMenu(
            receiver,
            withLeaf ? otherLeaf() : undefined,
            file
          );

          expect(iconsOf(menu)).not.toContain(PLUGIN_ICON);
        }
      )
    );
  });

  it('offers every import of a PDF that it offers of a note, a copy included', () => {
    fc.assert(
      fc.property(
        fc.mixedCase(fc.constant('pdf')),
        fc.boolean(),
        fc.boolean(),
        (extension, advanced, withLeaf) => {
          const file = fileWithExtension(extension);
          const { receiver, importArticle } = makeReceiver({ advanced, file });

          const menu = raiseMenu(
            receiver,
            withLeaf ? otherLeaf() : undefined,
            file
          );

          expect(iconsOf(menu)).toEqual(
            importsOnly(advanced ? ADVANCED_IMPORT_COUNT : 1)
          );
          if (!advanced) return;
          click(menu.items.find((i) => i.title === 'Import a copy'));
          expect(importArticle).toHaveBeenCalledExactlyOnceWith(file, {
            copyOnImport: true,
            showImportDialog: false,
          });
        }
      )
    );
  });

  it('goes to the context of the note the menu was raised on', () => {
    const { receiver, goToContext, file } = makeReceiver({
      frontmatter: { 'ir-id': 'abc' },
    });
    const menu = raiseMenu(receiver);

    click(menu.items.find((i) => i.title === 'Go to context'));

    expect(goToContext).toHaveBeenCalledExactlyOnceWith(file, false);
  });

  it('goes to the context where a modified click asks', () => {
    fc.assert(
      fc.property(menuClickArb, (init) => {
        const { receiver, goToContext, file } = makeReceiver({
          frontmatter: { 'ir-id': 'abc' },
        });
        const menu = raiseMenu(receiver);

        menu.items.find((i) => i.title === 'Go to context')?.callback?.(init);

        expect(goToContext).toHaveBeenCalledExactlyOnceWith(
          file,
          paneFor(init)
        );
      })
    );
  });

  it('offers to un-import a file that is a live article, and no other', () => {
    fc.assert(
      fc.property(
        fc.option(fc.string(), { nil: null }),
        fc.constantFrom('md', 'pdf', 'png'),
        fc.boolean(),
        fc.boolean(),
        (articleId, extension, advanced, withLeaf) => {
          const file = fileWithExtension(extension);
          const { receiver, articleIdAt } = makeReceiver({
            advanced,
            file,
            articleId,
          });

          const menu = raiseMenu(
            receiver,
            withLeaf ? otherLeaf() : undefined,
            file
          );

          expect(articleIdAt).toHaveBeenCalledExactlyOnceWith(file);
          const entries = menu.items.filter(
            (i) => i.title === 'Un-import article'
          );
          if (articleId === null) {
            expect(entries).toEqual([]);
            return;
          }
          expect(entries).toHaveLength(1);
          expect(entries[0].section).toBe('incremental-reading');
          expect(entries[0].icon).toBe('lucide-file-x');
        }
      )
    );
  });

  it('un-imports the file the menu was raised on', () => {
    const unimport = vi
      .spyOn(UnimportModule, 'unimportArticle')
      .mockResolvedValue(true);
    const { receiver, file } = makeReceiver({ articleId: 'a' });
    const menu = raiseMenu(receiver, undefined, file!);

    click(menu.items.find((i) => i.title === 'Un-import article'));

    expect(unimport).toHaveBeenCalledExactlyOnceWith(receiver, file);
  });
});

describe('IncrementalReadingPlugin onload', () => {
  beforeEach(() => {
    removeIcon(PLUGIN_ICON);
    vi.spyOn(ObsidianEditor, 'getEditorClass').mockReturnValue(
      class {} as never
    );
    // The settings tab classes its container and listens on it, which this
    // node environment has no document to build.
    vi.stubGlobal('document', {
      createElement: () => ({
        classList: { add: vi.fn() },
        addEventListener: vi.fn(),
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    removeIcon(PLUGIN_ICON);
  });

  it('puts the plugin icon on the ribbon, registered before it is drawn', async () => {
    const { receiver, ribbonIcons, iconsAtRibbon } = makeLoadReceiver();

    await IncrementalReadingPlugin.prototype.onload.call(
      receiver as unknown as IncrementalReadingPlugin
    );

    expect(ribbonIcons).toEqual([PLUGIN_ICON]);
    expect(iconsAtRibbon[0]).toContain(PLUGIN_ICON);
  });

  it('registers the bulk import command', async () => {
    const { receiver } = makeLoadReceiver();

    await IncrementalReadingPlugin.prototype.onload.call(
      receiver as unknown as IncrementalReadingPlugin
    );

    expect(receiver.addBulkImportCommand).toHaveBeenCalledOnce();
  });
});

describe('IncrementalReadingPlugin import commands', () => {
  it('registers each import command in the palette', () => {
    const { commands } = makeImportCommandReceiver();

    expect([...commands.keys()].sort()).toEqual(
      Object.keys(IMPORT_COMMANDS).sort()
    );
  });

  it('takes the advanced imports back out when their setting goes off', () => {
    const { receiver, commands } = makeImportCommandReceiver();

    receiver.toggleAdvancedCommands(false);

    expect([...commands.keys()]).toEqual(['import-article']);
  });

  it('offers every import on a note, each with its own options', () => {
    fc.assert(
      fc.property(importCommandIds, (id) => {
        const { file, importArticle, run } = makeImportCommandReceiver();

        expect(run(id, true)).toBe(true);
        expect(importArticle).not.toHaveBeenCalled();

        run(id);

        expect(importArticle).toHaveBeenCalledExactlyOnceWith(
          file,
          IMPORT_COMMANDS[id].opts
        );
      })
    );
  });

  it('offers no import while a file it cannot import is active', () => {
    fc.assert(
      fc.property(importCommandIds, unimportableExtension, (id, extension) => {
        const { importArticle, run } = makeImportCommandReceiver({
          extension,
        });

        expect(run(id, true)).toBe(false);
        run(id);

        expect(importArticle).not.toHaveBeenCalled();
      })
    );
  });

  it('offers every import of a PDF, a copy included, each with its own options', () => {
    fc.assert(
      fc.property(
        importCommandIds,
        fc.mixedCase(fc.constant('pdf')),
        (id, extension) => {
          const { file, importArticle, run } = makeImportCommandReceiver({
            extension,
          });

          expect(run(id, true)).toBe(true);
          expect(importArticle).not.toHaveBeenCalled();
          run(id);

          expect(importArticle).toHaveBeenCalledExactlyOnceWith(
            file,
            IMPORT_COMMANDS[id].opts
          );
        }
      )
    );
  });

  it('offers no import from the review tab, with no file open, or before loading', () => {
    fc.assert(
      fc.property(
        importCommandIds,
        fc.constantFrom(
          { where: 'review' as const },
          { where: 'none' as const },
          { loaded: false }
        ),
        (id, setup) => {
          const { importArticle, run } = makeImportCommandReceiver(setup);

          expect(run(id, true)).toBe(false);
          run(id);

          expect(importArticle).not.toHaveBeenCalled();
        }
      )
    );
  });
});

describe('IncrementalReadingPlugin import from the web viewer', () => {
  beforeEach(() => {
    Notice.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers the import on a page open in the web viewer, importing it at the default priority', async () => {
    const view = makeWebViewer({ title: 'Page', md: 'Text' });
    const { importArticle, importWebPage, recordImport, run } =
      makeImportCommandReceiver({ where: 'none', view });

    expect(run('import-article', true)).toBe(true);
    expect(view.getReaderModeContent).not.toHaveBeenCalled();
    run('import-article');

    await vi.waitFor(() =>
      expect(importWebPage).toHaveBeenCalledExactlyOnceWith(
        { title: 'Page', markdown: 'Text', url: 'https://example.com/page' },
        30,
        null
      )
    );
    // Recorded for an undo, with what it answered: here, nothing imported
    await vi.waitFor(() =>
      expect(recordImport).toHaveBeenCalledExactlyOnceWith({
        name: 'Page',
        result: null,
      })
    );
    expect(importArticle).not.toHaveBeenCalled();
    expect(Notice.messages).toEqual([]);
  });

  it('still imports the note when the active view is a file view, as before', () => {
    // `getActiveViewOfType(ItemView)` answers a Markdown or PDF view too
    fc.assert(
      fc.property(
        importCommandIds,
        fc.constantFrom('markdown', 'pdf'),
        (id, type) => {
          const { file, importArticle, importWebPage, run } =
            makeImportCommandReceiver({ view: { getViewType: () => type } });

          expect(run(id, true)).toBe(true);
          run(id);

          expect(importArticle).toHaveBeenCalledExactlyOnceWith(
            file,
            IMPORT_COMMANDS[id].opts
          );
          expect(importWebPage).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('offers none of the advanced imports on a page in the web viewer', () => {
    fc.assert(
      fc.property(
        importCommandIds.filter((id) => id !== 'import-article'),
        (id) => {
          const { importWebPage, run } = makeImportCommandReceiver({
            where: 'none',
            view: makeWebViewer(),
          });

          expect(run(id, true)).toBe(false);
          run(id);

          expect(importWebPage).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('offers no import on a view that is no web viewer it can read', () => {
    fc.assert(
      fc.property(importCommandIds, notWebViewerArb, (id, view) => {
        const { importArticle, importWebPage, run } = makeImportCommandReceiver(
          { where: 'none', view }
        );

        expect(run(id, true)).toBe(false);
        run(id);

        expect(importArticle).not.toHaveBeenCalled();
        expect(importWebPage).not.toHaveBeenCalled();
      })
    );
  });

  it('offers no import of a web page from the review tab or before loading', () => {
    for (const setup of [{ where: 'review' as const }, { loaded: false }]) {
      const view = makeWebViewer();
      const { importWebPage, run } = makeImportCommandReceiver({
        ...setup,
        view,
      });

      expect(run('import-article', true)).toBe(false);
      run('import-article');

      expect(view.getReaderModeContent).not.toHaveBeenCalled();
      expect(importWebPage).not.toHaveBeenCalled();
    }
  });

  it('imports nothing, saying nothing more, when Obsidian reads nothing from the page', async () => {
    // Obsidian shows a notice of its own when Readability finds nothing
    const view = makeWebViewer(undefined);
    const { importWebPage, run } = makeImportCommandReceiver({
      where: 'none',
      view,
    });

    run('import-article');

    await vi.waitFor(() =>
      expect(view.getReaderModeContent).toHaveBeenCalled()
    );
    // A macrotask: every promise the import chains has settled by then
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(importWebPage).not.toHaveBeenCalled();
    expect(Notice.messages).toEqual([]);
  });

  it('imports a page once, however often asked while it is being imported', async () => {
    vi.spyOn(console, 'error').mockReturnValue(undefined);
    for (const outcome of ['read', 'unread', 'thrown'] as const) {
      Notice.reset();
      const view = makeWebViewer();
      let finishRead = (): void => undefined;
      view.getReaderModeContent.mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            finishRead = () => {
              if (outcome === 'thrown') reject(new Error('gone'));
              else
                resolve(
                  outcome === 'read' ? { title: 'Page', md: 'Text' } : undefined
                );
            };
          })
      );
      let finishImport = (): void => undefined;
      const { importWebPage, run } = makeImportCommandReceiver({
        where: 'none',
        view,
      });
      importWebPage.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishImport = () => resolve(null);
          })
      );

      // Asked again while the page is read, and while it is imported
      run('import-article');
      run('import-article');
      finishRead();
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (outcome === 'read') run('import-article');
      finishImport();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(view.getReaderModeContent).toHaveBeenCalledOnce();
      expect(importWebPage).toHaveBeenCalledTimes(outcome === 'read' ? 1 : 0);

      // Once it is done, the page can be imported again
      run('import-article');
      finishRead();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(view.getReaderModeContent).toHaveBeenCalledTimes(2);
      expect(importWebPage).toHaveBeenCalledTimes(outcome === 'read' ? 2 : 0);
      finishImport();
    }
  });

  it('opens the import dialog on the page when the dialog is on, importing nothing yet', async () => {
    try {
      const { open, dialogs } = stubImportDialog();
      const view = makeWebViewer({ title: 'Page', md: 'Text' });
      const { importWebPage, run } = makeImportCommandReceiver({
        where: 'none',
        view,
        showImportDialog: true,
      });

      run('import-article');

      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
      expect(dialogs()[0].subject).toEqual({
        kind: 'web',
        page: {
          title: 'Page',
          markdown: 'Text',
          url: 'https://example.com/page',
        },
      });
      expect(importWebPage).not.toHaveBeenCalled();
      expect(Notice.messages).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does nothing while the dialog on the page is open, and imports nothing when it is cancelled', async () => {
    try {
      const { open, dialogs } = stubImportDialog();
      const view = makeWebViewer();
      const { importWebPage, run } = makeImportCommandReceiver({
        where: 'none',
        view,
        showImportDialog: true,
      });

      run('import-article');
      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
      run('import-article');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(view.getReaderModeContent).toHaveBeenCalledOnce();
      expect(open).toHaveBeenCalledOnce();

      // Cancelled: Obsidian's `close` calls `onClose`
      dialogs()[0].onClose();
      await new Promise((resolve) => setTimeout(resolve, 0));
      run('import-article');

      await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
      expect(view.getReaderModeContent).toHaveBeenCalledTimes(2);
      expect(importWebPage).not.toHaveBeenCalled();
      expect(Notice.messages).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("says so when the page can't be read", async () => {
    vi.spyOn(console, 'error').mockReturnValue(undefined);
    for (const view of [
      {
        ...makeWebViewer(),
        getReaderModeContent: () => Promise.reject(new Error('gone')),
      },
      makeWebViewer({ title: 1, markdown: 'Text' }),
    ]) {
      Notice.reset();
      const { importWebPage, run } = makeImportCommandReceiver({
        where: 'none',
        view,
      });

      run('import-article');

      await vi.waitFor(() =>
        expect(Notice.messages).toEqual([expect.any(String)])
      );
      expect(importWebPage).not.toHaveBeenCalled();
    }
  });
});

describe('IncrementalReadingPlugin.addWebViewerMenuItems', () => {
  /**
   * Raise a leaf menu for a leaf holding `view` on a plugin loaded or not,
   * as Obsidian's `leaf-menu` event hands it over.
   */
  function raiseLeafMenu(view: unknown, loaded = true) {
    const result = { articleId: 'page', effect: 'created', article: null };
    const importWebPage = vi.fn(() => Promise.resolve(result));
    const recordImport = vi.fn();
    const receiver = Object.assign(
      Object.create(IncrementalReadingPlugin.prototype) as object,
      {
        reviewManager: loaded ? { importWebPage } : undefined,
        actions: { recordImport },
        settings: { defaultPriority: 30, showImportDialog: false },
      }
    ) as unknown as IncrementalReadingPlugin;
    const menu = new Menu();
    receiver.addWebViewerMenuItems(
      menu as never,
      { view } as unknown as WorkspaceLeaf
    );
    return { menu, importWebPage, recordImport, result };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers the import in a web viewer's menu, importing its page", async () => {
    const { menu, importWebPage, recordImport, result } =
      raiseLeafMenu(makeWebViewer());

    expect(iconsOf(menu)).toEqual(importsOnly(1));
    expect(menu.items[0].section).toBe('incremental-reading');
    expect(menu.sections).toEqual(['incremental-reading']);
    expect(importWebPage).not.toHaveBeenCalled();

    await menu.items[0].callback?.({});

    expect(importWebPage).toHaveBeenCalledExactlyOnceWith(
      { title: 'Page', markdown: 'Text', url: 'https://example.com/page' },
      30,
      null
    );
    expect(recordImport).toHaveBeenCalledExactlyOnceWith({
      name: 'Page',
      result,
    });
  });

  it('adds nothing to the menu of any other view, or before loading', () => {
    fc.assert(
      fc.property(notWebViewerArb, (view) => {
        expect(raiseLeafMenu(view).menu.items).toEqual([]);
      })
    );
    expect(raiseLeafMenu(makeWebViewer(), false).menu.items).toEqual([]);
  });
});

describe('IncrementalReadingPlugin.importArticle', () => {
  it('refuses a file it cannot import, dialog or not, and says so', async () => {
    // With the dialog on, constructing the modal would throw here (no DOM), so
    // reaching it fails the property as surely as the `open` spy would.
    await fc.assert(
      fc.asyncProperty(
        unimportableExtension,
        fc.boolean(),
        async (extension, showImportDialog) => {
          Notice.reset();
          const open = vi.spyOn(ImportModal.prototype, 'open');
          open.mockClear();
          const { importArticle, call } = makeImportReceiver();
          const file = fileWithExtension(extension);

          await call(file, { showImportDialog });

          expect(importArticle).not.toHaveBeenCalled();
          expect(open).not.toHaveBeenCalled();
          expect(Notice.messages).toHaveLength(1);
          expect(Notice.messages[0]).toContain(file.name);
        }
      )
    );
  });

  it('imports a note straight away when the dialog is off, recording it for an undo', async () => {
    const { importArticle, recordImport, result, call } = makeImportReceiver();
    const file = makeFile();

    await call(file, { showImportDialog: false, copyOnImport: true });

    expect(importArticle).toHaveBeenCalledExactlyOnceWith(file, 3, null, true);
    expect(recordImport).toHaveBeenCalledExactlyOnceWith({
      name: file.basename,
      result,
    });
  });

  it('opens the dialog on a note when asked, importing nothing yet', async () => {
    // The mock modal builds its content element in its constructor, and this
    // file runs without a DOM; any element will do for a dialog never shown.
    vi.stubGlobal('document', { createElement: () => ({}) });
    try {
      Notice.reset();
      const open = vi
        .spyOn(ImportModal.prototype, 'open')
        .mockImplementation(() => {});
      const { importArticle, recordImport, call } = makeImportReceiver();
      const file = makeFile();

      await call(file, { showImportDialog: true, copyOnImport: true });

      // The dialog records it, once it imports
      expect(recordImport).not.toHaveBeenCalled();

      expect(open).toHaveBeenCalledOnce();
      const modal = open.mock.contexts[0] as ImportModal;
      expect(modal.subject).toEqual({
        kind: 'file',
        file,
        defaultCopyOnImport: true,
      });
      expect(importArticle).not.toHaveBeenCalled();
      expect(Notice.messages).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('IncrementalReadingPlugin.importFromFolder', () => {
  it("opens the bulk import dialog on the folder's files, whatever showImportDialog says", async () => {
    // The mock modal builds its content element in its constructor, and this
    // file runs without a DOM; any element will do for a dialog never shown.
    vi.stubGlobal('document', { createElement: () => ({}) });
    try {
      for (const showImportDialog of [false, true]) {
        const open = vi
          .spyOn(BulkImportModal.prototype, 'open')
          .mockImplementation(() => {});
        open.mockClear();
        const isItemFileAt = vi.fn(() => true);
        const receiver = {
          app: { workspace: { getLeavesOfType: () => [] } },
          settings: { showImportDialog },
          reviewManager: { isItemFileAt },
        };
        const folder = makeFolder('notes/reading');
        const pdf = Object.assign(new TFile(), {
          path: 'notes/reading/paper.pdf',
          name: 'paper.pdf',
          extension: 'pdf',
        });
        folder.children = [pdf];

        const modal = IncrementalReadingPlugin.prototype.importFromFolder.call(
          receiver as unknown as IncrementalReadingPlugin,
          folder
        ) as BulkImportModal;

        expect(open).toHaveBeenCalledOnce();
        expect(open.mock.contexts[0]).toBe(modal);
        expect(modal.request.mode).toBe('import');
        expect(modal.request.source?.title).toBe('reading');
        // A PDF is an item by the row at its path, which the item layer knows
        const events: ScanEvent[] = [];
        for await (const event of modal.request.source!.scan(
          new AbortController().signal
        )) {
          events.push(event);
        }
        // No row: the folder is done with nothing in it
        expect(events).toEqual([{ type: 'folder-done', path: folder.path }]);
        expect(isItemFileAt).toHaveBeenCalledExactlyOnceWith(pdf, pdf.path);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lists the folder's files in the explorer's order as the dialog opened, whatever the explorer changes to after", async () => {
    vi.stubGlobal('document', { createElement: () => ({}) });
    try {
      vi.spyOn(BulkImportModal.prototype, 'open').mockImplementation(() => {});
      // Where the explorer keeps its order (see `readExplorerSortOrder`)
      const explorerState = { sortOrder: 'byModifiedTime' };
      const receiver = {
        app: {
          workspace: {
            getLeavesOfType: (type: string) =>
              type === 'file-explorer'
                ? [{ view: { getState: () => explorerState } }]
                : [],
          },
        },
        settings: { showImportDialog: false },
        // Asked about each PDF in turn, in the order the dialog lists them
        reviewManager: { isItemFileAt: vi.fn((_file: TFile) => true) },
      };
      const folder = makeFolder('papers');
      const pdf = (basename: string, mtime: number) =>
        Object.assign(new TFile(), {
          path: `papers/${basename}.pdf`,
          name: `${basename}.pdf`,
          basename,
          extension: 'pdf',
          stat: { mtime, ctime: 0, size: 0 },
        });
      // Newest first, `b` `c` `a`; by name, as the folder holds them, `a` `b` `c`
      folder.children = [pdf('a', 1), pdf('b', 3), pdf('c', 2)];

      const modal = IncrementalReadingPlugin.prototype.importFromFolder.call(
        receiver as unknown as IncrementalReadingPlugin,
        folder
      ) as BulkImportModal;
      explorerState.sortOrder = 'alphabetical';
      const events: ScanEvent[] = [];
      for await (const event of modal.request.source!.scan(
        new AbortController().signal
      )) {
        events.push(event);
      }

      expect(
        receiver.reviewManager.isItemFileAt.mock.calls.map(
          ([file]) => file.basename
        )
      ).toEqual(['b', 'c', 'a']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('IncrementalReadingPlugin.addSelectionMenuItems', () => {
  /** A file the item layer and the selection code can tell is one. */
  const fileAt = (path: string) => Object.assign(new TFile(), makeFile(path));
  /**
   * What a multi-selection can hold: notes, a PDF and files that can't
   * import, folders nested in one another, and the data directory.
   */
  const pool = [
    makeFolder('a'),
    makeFolder('a/b'),
    fileAt('a/x.md'),
    fileAt('a/b/y.PDF'),
    fileAt('a 2.md'),
    fileAt('c.png'),
    fileAt('d.md'),
    fileAt('e.canvas'),
    makeFolder(DATA_DIRECTORY),
    fileAt(`${DATA_DIRECTORY}/f.md`),
  ];
  const selectionArb = fc.array(fc.constantFrom(...pool), {
    minLength: 1,
    maxLength: 6,
  });

  function raiseSelectionMenu(
    receiver: ReturnType<typeof makeReceiver>['receiver'],
    files: TAbstractFile[],
    leaf: WorkspaceLeaf | null = null
  ): Menu {
    const menu = new Menu();
    IncrementalReadingPlugin.prototype.addSelectionMenuItems.call(
      receiver as unknown as IncrementalReadingPlugin,
      menu as never,
      files,
      leaf
    );
    return menu;
  }

  it('offers to import the selection, counting each item once and none a selected folder holds, when any of it could import', () => {
    fc.assert(
      fc.property(selectionArb, (files) => {
        const receiver = {
          ...makeReceiver().receiver,
          importSelection: vi.fn(),
        };
        const paths = [...new Set(files.map((file) => file.path))];
        const kept = paths.filter(
          (path) =>
            path !== DATA_DIRECTORY &&
            !path.startsWith(`${DATA_DIRECTORY}/`) &&
            !paths.some((other) => path.startsWith(`${other}/`))
        );
        const offered = kept.some((path) =>
          /^a(\/b)?$|\.(md|pdf)$/i.test(path)
        );

        const menu = raiseSelectionMenu(receiver, files);

        if (!offered) {
          expect(menu.items).toHaveLength(0);
          return;
        }
        expect(iconsOf(menu)).toEqual(importsOnly(1));
        expect(menu.items[0]?.section).toBe('incremental-reading');
        expect(menu.items[0]?.title).toContain(` ${kept.length} `);
        click(menu.items[0]);
        expect(receiver.importSelection).toHaveBeenCalledExactlyOnceWith(files);
      })
    );
  });

  it('offers to un-import the selection, counting as the import does, only when it holds a live article or a folder with one under it', () => {
    fc.assert(
      fc.property(
        selectionArb,
        fc.subarray(pool.map(({ path }) => path)),
        (files, articles) => {
          const { receiver, articleIdAt, hasArticleUnder } = makeReceiver();
          // A file is an article, a folder has one under it, as `articles` says
          articleIdAt.mockImplementation((file) =>
            articles.includes(file.path) ? 'x' : null
          );
          hasArticleUnder.mockImplementation((path) => articles.includes(path));
          const wired = { ...receiver, unimportSelection: vi.fn() };
          const paths = [...new Set(files.map((file) => file.path))];
          const kept = paths.filter(
            (path) =>
              path !== DATA_DIRECTORY &&
              !path.startsWith(`${DATA_DIRECTORY}/`) &&
              !paths.some((other) => path.startsWith(`${other}/`))
          );
          const offered = kept.some((path) => articles.includes(path));

          const menu = raiseSelectionMenu(wired, files);

          const entry = menu.items.find(({ icon }) => icon === 'lucide-file-x');
          if (!offered) {
            expect(entry).toBeUndefined();
            return;
          }
          // After the import, which an article's type always allows
          expect(menu.items.at(-1)).toBe(entry);
          expect(entry?.section).toBe('incremental-reading');
          expect(entry?.title).toContain(` ${kept.length} `);
          click(entry);
          expect(wired.unimportSelection).toHaveBeenCalledExactlyOnceWith(
            files
          );
        }
      )
    );
  });

  it('offers nothing before the review manager is up, or in the review tab', () => {
    const files = [fileAt('d.md'), fileAt('a 2.md')];

    expect(
      raiseSelectionMenu(makeReceiver({ imported: false }).receiver, files)
        .items
    ).toHaveLength(0);
    expect(
      raiseSelectionMenu(makeReceiver().receiver, files, reviewLeaf()).items
    ).toHaveLength(0);
    expect(
      raiseSelectionMenu(makeReceiver().receiver, files, otherLeaf()).items
    ).toHaveLength(1);
  });

  it('is what a menu on a multi-selection gets', async () => {
    removeIcon(PLUGIN_ICON);
    vi.spyOn(ObsidianEditor, 'getEditorClass').mockReturnValue(
      class {} as never
    );
    vi.stubGlobal('document', {
      createElement: () => ({
        classList: { add: vi.fn() },
        addEventListener: vi.fn(),
      }),
    });
    try {
      const { receiver } = makeLoadReceiver();
      const addSelectionMenuItems = vi.fn();
      Object.assign(receiver, { addSelectionMenuItems });

      await IncrementalReadingPlugin.prototype.onload.call(
        receiver as unknown as IncrementalReadingPlugin
      );
      const [, handler] = receiver.app.workspace.on.mock.calls.find(
        ([name]) => name === 'files-menu'
      ) as [string, (...args: unknown[]) => void];
      const menu = new Menu();
      const files = [fileAt('d.md'), makeFolder('a')];
      handler(menu, files, 'file-explorer-context-menu', null);

      expect(addSelectionMenuItems).toHaveBeenCalledExactlyOnceWith(
        menu,
        files,
        null
      );
    } finally {
      vi.unstubAllGlobals();
      removeIcon(PLUGIN_ICON);
    }
  });
});

describe('IncrementalReadingPlugin.importSelection', () => {
  it('opens the bulk import dialog on the selection, in the explorer order as it opened', async () => {
    vi.stubGlobal('document', { createElement: () => ({}) });
    try {
      const open = vi
        .spyOn(BulkImportModal.prototype, 'open')
        .mockImplementation(() => {});
      const explorerState = { sortOrder: 'alphabeticalReverse' };
      const isItemFileAt = vi.fn((_file: TFile, _path: string) => true);
      const receiver = {
        app: {
          workspace: {
            getLeavesOfType: (type: string) =>
              type === 'file-explorer'
                ? [{ view: { getState: () => explorerState } }]
                : [],
          },
        },
        reviewManager: { isItemFileAt },
      };
      const pdf = (basename: string) =>
        Object.assign(new TFile(), {
          path: `papers/${basename}.pdf`,
          name: `${basename}.pdf`,
          basename,
          extension: 'pdf',
        });
      const files = [pdf('a'), pdf('c'), pdf('b')];

      const modal = IncrementalReadingPlugin.prototype.importSelection.call(
        receiver as unknown as IncrementalReadingPlugin,
        files
      ) as BulkImportModal;
      explorerState.sortOrder = 'alphabetical';
      const events: ScanEvent[] = [];
      for await (const event of modal.request.source!.scan(
        new AbortController().signal
      )) {
        events.push(event);
      }

      expect(open).toHaveBeenCalledOnce();
      expect(open.mock.contexts[0]).toBe(modal);
      expect(modal.request.mode).toBe('import');
      expect(modal.request.source?.title).toMatch(/\b3\b/);
      // Each PDF is an item by the row at its path; Z to A, as it opened
      expect(isItemFileAt.mock.calls).toEqual(
        ['c', 'b', 'a'].map((name) => [pdf(name), `papers/${name}.pdf`])
      );
      expect(events).toEqual([{ type: 'folder-done', path: '/' }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('IncrementalReadingPlugin bulk import command', () => {
  /** The plugin with the command registered, loaded or not. */
  function makeReceiver(loaded: boolean) {
    const commands = new Map<
      string,
      { name: string; checkCallback: (checking: boolean) => boolean | void }
    >();
    const receiver = {
      reviewManager: loaded ? {} : undefined,
      openBulkImport: vi.fn(),
      addCommand: vi.fn(
        (command: {
          id: string;
          name: string;
          checkCallback: (checking: boolean) => boolean | void;
        }) => {
          commands.set(command.id, command);
        }
      ),
    };
    (
      IncrementalReadingPlugin.prototype as unknown as {
        addBulkImportCommand(): void;
      }
    ).addBulkImportCommand.call(receiver);
    return { receiver, commands };
  }

  it('is offered once the plugin has loaded, opening the dialog only when run', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (loaded, checking) => {
        const { receiver, commands } = makeReceiver(loaded);

        expect([...commands.keys()]).toEqual(['bulk-import']);
        const offered = commands.get('bulk-import')!.checkCallback(checking);

        expect(offered).toBe(loaded);
        expect(receiver.openBulkImport).toHaveBeenCalledTimes(
          loaded && !checking ? 1 : 0
        );
      })
    );
  });
});

describe('IncrementalReadingPlugin.openBulkImport', () => {
  it('opens the bulk import dialog with its filter bar, on no source yet', () => {
    vi.stubGlobal('document', { createElement: () => ({}) });
    try {
      const open = vi
        .spyOn(BulkImportModal.prototype, 'open')
        .mockImplementation(() => {});
      const receiver = { app: {} };

      const modal = IncrementalReadingPlugin.prototype.openBulkImport.call(
        receiver as unknown as IncrementalReadingPlugin
      ) as BulkImportModal;

      expect(open).toHaveBeenCalledOnce();
      expect(open.mock.contexts[0]).toBe(modal);
      expect(modal.request).toEqual({ mode: 'import', filterBar: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('IncrementalReadingPlugin.bulkImportSources', () => {
  it("makes a folder's source, asking the item layer about each file, in the explorer's order as it was asked for", async () => {
    // Where the explorer keeps its order (see `readExplorerSortOrder`)
    const explorerState = { sortOrder: 'byModifiedTime' };
    const receiver = {
      app: {
        workspace: {
          getLeavesOfType: (type: string) =>
            type === 'file-explorer'
              ? [{ view: { getState: () => explorerState } }]
              : [],
        },
      },
      // Asked about each PDF in turn, in the order the dialog lists them
      reviewManager: {
        isItemFileAt: vi.fn((_file: TFile, _path: string) => true),
      },
      // The plugin's own, run on this receiver as the methods under test are
      // eslint-disable-next-line @typescript-eslint/unbound-method
      candidateChecks: IncrementalReadingPlugin.prototype.candidateChecks,
    };
    const folder = makeFolder('papers/deep');
    const pdf = (basename: string, mtime: number) =>
      Object.assign(new TFile(), {
        path: `papers/deep/${basename}.pdf`,
        name: `${basename}.pdf`,
        basename,
        extension: 'pdf',
        stat: { mtime, ctime: 0, size: 0 },
      });
    // Newest first, `b` `c` `a`; by name, as the folder holds them, `a` `b` `c`
    folder.children = [pdf('a', 1), pdf('b', 3), pdf('c', 2)];

    const sources = IncrementalReadingPlugin.prototype.bulkImportSources.call(
      receiver as unknown as IncrementalReadingPlugin
    ) as FilterSources;
    explorerState.sortOrder = 'alphabetical';
    const source = sources.folder(folder);
    const events: ScanEvent[] = [];
    for await (const event of source.scan(new AbortController().signal)) {
      events.push(event);
    }

    expect(source.title).toBe('deep');
    expect(source.canIncludeSubfolders).toBe(true);
    expect(events).toEqual([{ type: 'folder-done', path: folder.path }]);
    expect(
      receiver.reviewManager.isItemFileAt.mock.calls.map(([file, path]) => [
        file.basename,
        path,
      ])
    ).toEqual([
      ['b', 'papers/deep/b.pdf'],
      ['c', 'papers/deep/c.pdf'],
      ['a', 'papers/deep/a.pdf'],
    ]);
  });
});

describe('IncrementalReadingPlugin.bulkImportSources: tags', () => {
  it("makes a tag's source over the vault's notes carrying it, titled with the tags, in the explorer's order", async () => {
    const note = (path: string, mtime: number) =>
      Object.assign(new TFile(), {
        path,
        name: path.slice(path.lastIndexOf('/') + 1),
        basename: path.slice(path.lastIndexOf('/') + 1, -3),
        extension: 'md',
        stat: { mtime, ctime: 0, size: 0 },
        parent: null,
      });
    const older = note('older.md', 1);
    const newer = note('newer.md', 2);
    const untagged = note('untagged.md', 3);
    const caches = new Map<TFile, unknown>([
      [older, { frontmatter: { tags: ['read/later'] } }],
      [newer, { tags: [{ tag: '#Read' }] }],
    ]);
    const explorerState = { sortOrder: 'byModifiedTime' };
    const receiver = {
      app: {
        workspace: {
          getLeavesOfType: (type: string) =>
            type === 'file-explorer'
              ? [{ view: { getState: () => explorerState } }]
              : [],
        },
        vault: {
          getMarkdownFiles: () => [older, untagged, newer],
          readBinary: async () => new TextEncoder().encode('# x').buffer,
          getResourcePath: (file: TFile) => file.path,
        },
        metadataCache: { getFileCache: (file: TFile) => caches.get(file) },
      },
      reviewManager: { isItemFileAt: vi.fn(() => false) },
      // The plugin's own, run on this receiver as the method under test is
      // eslint-disable-next-line @typescript-eslint/unbound-method
      candidateChecks: IncrementalReadingPlugin.prototype.candidateChecks,
    };

    const sources = IncrementalReadingPlugin.prototype.bulkImportSources.call(
      receiver as unknown as IncrementalReadingPlugin
    ) as FilterSources;
    explorerState.sortOrder = 'alphabetical';
    const source = sources.tag(['read', 'x']);
    const files: TFile[] = [];
    for await (const event of source.scan(new AbortController().signal)) {
      if (event.type === 'file') files.push(event.file);
    }

    expect(source.title).toBe('#read, #x');
    // Newest first, as the explorer was when asked
    expect(files).toEqual([newer, older]);
  });
});

describe('IncrementalReadingPlugin bulk un-import', () => {
  /** A file of `folder`, last modified at `mtime`. */
  const fileIn = (folder: TFolder, name: string, mtime: number) =>
    Object.assign(new TFile(), {
      path: `${folder.path}/${name}`,
      name,
      basename: name.slice(0, name.lastIndexOf('.')),
      extension: name.slice(name.lastIndexOf('.') + 1),
      stat: { mtime, ctime: 0, size: 0 },
      parent: folder,
    });

  /**
   * A plugin whose explorer sorts newest first, with `articles` the live
   * articles by name, and the methods that build the dialogs.
   */
  function makeUnimportReceiver(articles: readonly string[]) {
    const explorerState = { sortOrder: 'byModifiedTime' };
    const readBinary = vi.fn();
    const receiver = {
      app: {
        vault: { readBinary },
        workspace: {
          getLeavesOfType: (type: string) =>
            type === 'file-explorer'
              ? [{ view: { getState: () => explorerState } }]
              : [],
        },
      },
      reviewManager: {
        isItemFileAt: vi.fn((_file: TFile, _path: string) => false),
        articleIdAt: vi.fn((file: TFile) =>
          articles.includes(file.name) ? `id-${file.name}` : null
        ),
      },
      // The plugin's own, run on this receiver as the methods under test are
      // eslint-disable-next-line @typescript-eslint/unbound-method
      candidateChecks: IncrementalReadingPlugin.prototype.candidateChecks,
    };
    return { receiver, readBinary, explorerState };
  }

  /** Every event `source` scans, top level only. */
  async function scanned(source: CandidateSource | undefined) {
    const events: ScanEvent[] = [];
    for await (const event of source!.scan(new AbortController().signal)) {
      events.push(event);
    }
    return events;
  }

  /** The names of the files among `events`. */
  const filesOf = (events: readonly ScanEvent[]) =>
    events.flatMap((event) => (event.type === 'file' ? [event.file.name] : []));

  beforeEach(() => {
    vi.stubGlobal('document', { createElement: () => ({}) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists a folder's live articles alone, by the item layer's word, reading no file, in the explorer's order", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(['a.md', 'b.pdf', 'c.md', 'd.png']),
        fc.constantFrom('filters', 'folder'),
        async (articles, through) => {
          vi.spyOn(BulkImportModal.prototype, 'open').mockImplementation(
            () => {}
          );
          const { receiver, readBinary } = makeUnimportReceiver(articles);
          const folder = makeFolder('notes');
          folder.children = [
            fileIn(folder, 'a.md', 1),
            fileIn(folder, 'b.pdf', 4),
            fileIn(folder, 'c.md', 3),
            fileIn(folder, 'd.png', 2),
          ];
          const plugin = receiver as unknown as IncrementalReadingPlugin;

          const source =
            through === 'filters'
              ? (
                  IncrementalReadingPlugin.prototype.bulkImportSources.call(
                    plugin,
                    'unimport'
                  ) as FilterSources
                ).folder(folder)
              : (
                  IncrementalReadingPlugin.prototype.unimportFromFolder.call(
                    plugin,
                    folder
                  ) as BulkImportModal
                ).request.source;
          const events = await scanned(source);

          // Newest first
          expect(filesOf(events)).toEqual(
            ['b.pdf', 'c.md', 'd.png', 'a.md'].filter((name) =>
              articles.includes(name)
            )
          );
          expect(readBinary).not.toHaveBeenCalled();
          expect(receiver.reviewManager.isItemFileAt).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('opens the dialog to un-import from the folder', () => {
    const open = vi
      .spyOn(BulkImportModal.prototype, 'open')
      .mockImplementation(() => {});
    const { receiver } = makeUnimportReceiver([]);

    const modal = IncrementalReadingPlugin.prototype.unimportFromFolder.call(
      receiver as unknown as IncrementalReadingPlugin,
      makeFolder('notes/reading')
    ) as BulkImportModal;

    expect(open.mock.contexts).toEqual([modal]);
    expect(modal.request.mode).toBe('unimport');
    expect(modal.request.source?.title).toBe('reading');
  });

  it("opens the dialog to un-import the selection's live articles, saying how many items it was on", async () => {
    const open = vi
      .spyOn(BulkImportModal.prototype, 'open')
      .mockImplementation(() => {});
    const { receiver } = makeUnimportReceiver(['a.md', 'c.md']);
    const folder = makeFolder('notes');
    const files = ['a.md', 'b.md', 'c.md'].map((name, i) =>
      fileIn(folder, name, i)
    );

    const modal = IncrementalReadingPlugin.prototype.unimportSelection.call(
      receiver as unknown as IncrementalReadingPlugin,
      files
    ) as BulkImportModal;

    expect(open.mock.contexts).toEqual([modal]);
    expect(modal.request.mode).toBe('unimport');
    expect(modal.request.source?.heading).toMatch(/\b3\b/);
    expect(modal.request.source?.heading).not.toMatch(/^Importing/);
    expect(filesOf(await scanned(modal.request.source))).toEqual([
      'c.md',
      'a.md',
    ]);
  });

  it('opens the dialog with its filter bar to un-import', () => {
    const open = vi
      .spyOn(BulkImportModal.prototype, 'open')
      .mockImplementation(() => {});

    const modal = IncrementalReadingPlugin.prototype.openBulkUnimport.call({
      app: {},
    } as unknown as IncrementalReadingPlugin) as BulkImportModal;

    expect(open.mock.contexts).toEqual([modal]);
    expect(modal.request).toEqual({ mode: 'unimport', filterBar: true });
  });
});

describe('IncrementalReadingPlugin.learn', () => {
  beforeEach(() => {
    store.dispatch(resetSession());
  });

  it('opens on the item a closed tab was left on, home screen setting or not', () => {
    // The setting is about opening review with nothing in progress; an item
    // carried over from a closed tab is somewhere the user already was.
    return learn(makeLearnReceiver({ resumed: true }).receiver).then(() => {
      expect(store.getState().page).toBe('review');
    });
  });

  it('opens on the home screen when there was nothing to resume', () => {
    return learn(makeLearnReceiver({ resumed: false }).receiver).then(() => {
      expect(store.getState().page).toBe('home');
    });
  });

  it('honours the skipped home screen with nothing to resume', () => {
    return learn(
      makeLearnReceiver({ resumed: false, skipHomeScreen: true }).receiver
    ).then(() => {
      expect(store.getState().page).toBe('review');
    });
  });

  it('resumes before the view mounts, so the queue never fills the gap', async () => {
    // Mounting first would fetch the top of the queue against an empty session
    // and dispatch that as the current item, writing over the remembered one.
    const { receiver, leaf } = makeLearnReceiver({ resumed: true });

    await learn(receiver);

    expect(receiver.resumeSession.mock.invocationCallOrder[0]).toBeLessThan(
      leaf.setViewState.mock.invocationCallOrder[0]
    );
  });

  it('has the page settled before the view mounts', async () => {
    // `resetSession` left the page on 'home' when the last tab closed, and the
    // mount renders against whatever it finds: choosing afterwards shows the
    // queue table for a frame before the item replaces it.
    const { receiver, pageAtMount } = makeLearnReceiver({
      resumed: false,
      skipHomeScreen: true,
    });
    store.dispatch(setPage('home'));

    await learn(receiver);

    expect(pageAtMount.page).toBe('review');
  });

  it('has a resumed item on the page before the view mounts', async () => {
    const { receiver, pageAtMount } = makeLearnReceiver({ resumed: true });
    store.dispatch(setPage('home'));

    await learn(receiver);

    expect(pageAtMount.page).toBe('review');
  });

  it('still lands on the home screen before the view mounts', async () => {
    // The same guarantee the other way: nothing to resume and the setting off.
    const { receiver, pageAtMount } = makeLearnReceiver({ resumed: false });
    store.dispatch(setPage('review'));

    await learn(receiver);

    expect(pageAtMount.page).toBe('home');
    expect(store.getState().page).toBe('home');
  });

  it('has an explicit item in the store before the view mounts', async () => {
    // Otherwise the mount finds an empty session and resumes the remembered
    // item over it — see `ReviewView.resumeUnclaimedSession`, whose guard is
    // this dispatch.
    const { receiver, pageAtMount } = makeLearnReceiver({
      skipHomeScreen: false,
    });

    await learn(receiver, item('item-9'));

    expect(pageAtMount.itemId).toBe('item-9');
    expect(pageAtMount.page).toBe('review');
  });

  it('does not go looking for a session when handed an item', async () => {
    const { receiver } = makeLearnReceiver();

    await learn(receiver, item('item-9'));

    expect(receiver.resumeSession).not.toHaveBeenCalled();
    expect(store.getState().currentItemId).toBe('item-9');
  });

  it('opens the top of the queue when toggled on from the home screen', async () => {
    // The store keeps the last item while home is up; toggling back must not
    // resume it.
    const { receiver } = makeLearnReceiver({ reviewTab: 'focused' });
    store.dispatch(setCurrentItemId('left-open'));
    store.dispatch(setPage('home'));

    await learn(receiver);

    expect(store.getState().currentItemId).toBeNull();
    expect(store.getState().page).toBe('review');
  });

  it('toggles back to the home screen from review, keeping the item', async () => {
    const { receiver } = makeLearnReceiver({ reviewTab: 'focused' });
    store.dispatch(setCurrentItemId('on-screen'));
    store.dispatch(setPage('review'));

    await learn(receiver);

    expect(store.getState().currentItemId).toBe('on-screen');
    expect(store.getState().page).toBe('home');
  });

  it('leaves an unfocused review tab where it is, only focusing it', async () => {
    const { receiver } = makeLearnReceiver({ reviewTab: 'unfocused' });
    store.dispatch(setCurrentItemId('on-screen'));
    store.dispatch(setPage('home'));

    await learn(receiver);

    expect(store.getState().currentItemId).toBe('on-screen');
    expect(store.getState().page).toBe('home');
  });

  it('resets the per-item state when handed an item on an open review tab', async () => {
    // A card left with its answer shown must not hand that to the item opened.
    for (const reviewTab of ['focused', 'unfocused'] as const) {
      store.dispatch(resetSession());
      const { receiver } = makeLearnReceiver({ reviewTab });
      store.dispatch(setCurrentItemId('left-open'));
      store.dispatch(setPage('review'));
      store.dispatch(setShowAnswer(true));

      await learn(receiver, item('item-9'));

      expect(store.getState().currentItemId).toBe('item-9');
      expect(store.getState().page).toBe('review');
      expect(store.getState().showAnswer).toBe(false);
    }
  });

  it('reuses an open review tab whatever pane type it is asked for', async () => {
    for (const newLeaf of [false, true, 'tab', 'split', 'window'] as const) {
      const { receiver, leaf } = makeLearnReceiver({ reviewTab: 'unfocused' });

      await learn(receiver, item('item-9'), newLeaf);

      expect(receiver.app.workspace.getLeaf).not.toHaveBeenCalled();
      expect(receiver.app.workspace.revealLeaf).toHaveBeenCalledWith(leaf);
    }
  });

  it('opens review where it is asked to when no review tab is open', async () => {
    const cases = [
      [undefined, 'tab'],
      [true, 'tab'],
      [false, false],
      ['tab', 'tab'],
      ['split', 'split'],
      ['window', 'window'],
    ] as const;
    for (const [newLeaf, paneType] of cases) {
      const { receiver } = makeLearnReceiver();

      await learn(
        receiver,
        item('item-9'),
        ...(newLeaf === undefined ? [] : ([newLeaf] as const))
      );

      expect(receiver.app.workspace.getLeaf).toHaveBeenCalledWith(paneType);
    }
  });
});

describe('IncrementalReadingPlugin.syncReviewTitleBars', () => {
  it('brings every open review tab, and nothing else, up to the setting', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom<('review' | 'deferred')[]>('review', 'deferred'),
          {
            maxLength: 5,
          }
        ),
        (views) => {
          const { receiver, synced } = makeWorkspaceReceiver(views);

          IncrementalReadingPlugin.prototype.syncReviewTitleBars.call(
            receiver as unknown as IncrementalReadingPlugin
          );

          expect(synced).toEqual(
            views.flatMap((kind, i) => (kind === 'review' ? [i] : []))
          );
        }
      )
    );
  });
});

describe('IncrementalReadingPlugin.loadSettings', () => {
  it("writes data.json back once, settings alone, only when it carried device state, and keeps this device's own", async () => {
    const legacyKeys = ['session', 'ui', 'warnedRefusedPaths'];
    const legacyStateArb = fc.record(
      {
        session: fc.oneof(
          fc.string().map((itemId) => ({ deviceId: DEVICE, itemId })),
          fc.record({ deviceId: fc.string(), itemId: fc.string() }),
          fc.anything()
        ),
        ui: fc.oneof(
          fc.record({ folderImportIncludeSubfolders: fc.boolean() }),
          fc.anything()
        ),
        warnedRefusedPaths: fc.oneof(fc.array(fc.string()), fc.anything()),
      },
      { requiredKeys: [] }
    );
    const settingsArb = fc.dictionary(
      fc
        .string()
        .filter((key) => key !== 'settings' && !legacyKeys.includes(key)),
      fc.jsonValue()
    );

    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc
            .tuple(settingsArb, legacyStateArb)
            .map(([settings, state]) => ({ settings, ...state })),
          fc
            .tuple(settingsArb, legacyStateArb)
            .map(([settings, state]) => ({ ...settings, ...state })),
          fc.jsonValue()
        ),
        storedDeviceStateArb,
        async (raw, stored) => {
          const storage = makeObsidianLocalStorage({
            ...stored,
            [DEVICE_ID_KEY]: DEVICE,
          });
          const first = makeStoragePlugin(storage, raw);

          await first.plugin.loadSettings();

          const carried =
            typeof raw === 'object' &&
            raw !== null &&
            !Array.isArray(raw) &&
            legacyKeys.some((key) => key in raw);
          expect(first.plugin.settings).toBe(first.plugin.data.settings);
          expect(first.plugin.data).toStrictEqual(parsePluginData(raw));
          expect(first.written).toStrictEqual(
            carried
              ? [
                  {
                    settings: JSON.parse(
                      JSON.stringify(first.plugin.settings)
                    ) as unknown,
                  },
                ]
              : []
          );
          // What it holds in memory is what is stored, migration included
          expect(first.plugin.deviceState).toStrictEqual(
            loadDeviceState(storage)
          );

          const second = makeStoragePlugin(storage, first.written[0] ?? raw);
          await second.plugin.loadSettings();

          expect(second.saveData).not.toHaveBeenCalled();
          expect(second.plugin.deviceState).toStrictEqual(
            first.plugin.deviceState
          );
        }
      )
    );
  });

  it("resumes this device's pointer from a file an older version wrote, and not another device's", async () => {
    const own = makeObsidianLocalStorage({ [DEVICE_ID_KEY]: DEVICE });
    const { plugin } = makeStoragePlugin(own, {
      settings: {},
      session: { deviceId: DEVICE, itemId: 'item-1' },
    });
    await plugin.loadSettings();
    expect(plugin.deviceState.session).toStrictEqual({
      deviceId: DEVICE,
      itemId: 'item-1',
    });

    const other = makeObsidianLocalStorage({ [DEVICE_ID_KEY]: DEVICE });
    const foreign = makeStoragePlugin(other, {
      settings: {},
      session: { deviceId: 'device-b', itemId: 'item-1' },
    });
    await foreign.plugin.loadSettings();
    expect(foreign.plugin.deviceState.session).toBeNull();
    expect(foreign.written).toHaveLength(1);
  });

  it('still loads when writing the file back without device state fails, and retries next load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = makeObsidianLocalStorage({ [DEVICE_ID_KEY]: DEVICE });
    const raw = {
      settings: { defaultPriority: 42 },
      session: { deviceId: DEVICE, itemId: 'item-1' },
    };
    const first = makeStoragePlugin(storage, raw);
    first.saveData.mockRejectedValueOnce(new Error('disk full'));

    await expect(first.plugin.loadSettings()).resolves.toBeUndefined();
    expect(first.plugin.settings.defaultPriority).toBe(42);
    expect(first.plugin.deviceState.session).toStrictEqual(raw.session);

    const second = makeStoragePlugin(storage, raw);
    await second.plugin.loadSettings();
    expect(second.saveData).toHaveBeenCalledOnce();
    expect(second.plugin.deviceState).toStrictEqual(first.plugin.deviceState);
  });
});

describe('IncrementalReadingPlugin.saveSession', () => {
  it("keeps the pointer in this device's storage, never data.json, the rest as it was", () => {
    fc.assert(
      fc.property(storedDeviceStateArb, sessionOrNoneArb, (stored, session) => {
        const storage = makeObsidianLocalStorage(stored);
        const { plugin, saveData } = makeStoragePlugin(storage);
        plugin.deviceState = loadDeviceState(storage);
        const before = loadDeviceState(storage);

        plugin.saveSession(session);

        expect(saveData).not.toHaveBeenCalled();
        expect(plugin.deviceState.session).toBe(session);
        expect(storage.saveLocalStorage).toHaveBeenCalledExactlyOnceWith(
          SESSION_KEY,
          session
        );
        expect(loadDeviceState(storage)).toStrictEqual({
          ...before,
          session:
            session?.deviceId && session.itemId
              ? { deviceId: session.deviceId, itemId: session.itemId }
              : null,
        });
      })
    );
  });
});

describe('IncrementalReadingPlugin.saveUiState', () => {
  it("keeps the change in this device's storage, never data.json, the rest as it was", () => {
    fc.assert(
      fc.property(
        storedDeviceStateArb,
        fc.record(
          { folderImportIncludeSubfolders: fc.boolean() },
          { requiredKeys: [] }
        ),
        (stored, change) => {
          const storage = makeObsidianLocalStorage(stored);
          const { plugin, saveData } = makeStoragePlugin(storage);
          plugin.deviceState = loadDeviceState(storage);
          const before = loadDeviceState(storage);
          const ui = { ...before.ui, ...change };

          plugin.saveUiState(change);

          expect(saveData).not.toHaveBeenCalled();
          expect(plugin.deviceState.ui).toStrictEqual(ui);
          expect(storage.saveLocalStorage).toHaveBeenCalledExactlyOnceWith(
            UI_STATE_KEY,
            ui
          );
          expect(loadDeviceState(storage)).toStrictEqual({ ...before, ui });
        }
      )
    );
  });
});

describe('IncrementalReadingPlugin.saveSettings', () => {
  it('tells every listener still subscribed of the change, before writing it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { maxLength: 4 }),
        async (staySubscribed) => {
          const plugin = new IncrementalReadingPlugin({} as never, {} as never);
          plugin.data = { settings: {} } as never;
          const events: string[] = [];
          // The obsidian mock's Plugin has no saveData to spy on
          const saveData = vi.fn(() => {
            events.push('write');
            return Promise.resolve();
          });
          plugin.saveData = saveData;
          for (const [i, stays] of staySubscribed.entries()) {
            const unsubscribe = plugin.onSettingsChange(() => {
              events.push(`listener ${i}`);
            });
            if (!stays) unsubscribe();
          }

          await plugin.saveSettings();

          expect(events).toEqual([
            ...staySubscribed.flatMap((stays, i) =>
              stays ? [`listener ${i}`] : []
            ),
            'write',
          ]);
          expect(saveData).toHaveBeenCalledExactlyOnceWith(plugin.data);
        }
      )
    );
  });
});

describe('IncrementalReadingPlugin.resumeSession', () => {
  beforeEach(() => {
    store.dispatch(resetSession());
  });

  it('resumes the item tracking is holding', async () => {
    const { receiver } = makeResumeReceiver({ tracked: 'item-1' });

    await expect(resumeSession(receiver)).resolves.toBe(true);
    expect(store.getState().currentItemId).toBe('item-1');
  });

  it('reads the pointer off disk before tracking has started', async () => {
    // Startup: `resumeSession` runs first so the restored tab opens on the item.
    const { receiver } = makeResumeReceiver({
      session: { deviceId: DEVICE, itemId: 'item-1' },
    });

    await expect(resumeSession(receiver)).resolves.toBe(true);
    expect(store.getState().currentItemId).toBe('item-1');
  });

  it('ignores another device pointer', async () => {
    const { receiver } = makeResumeReceiver({
      session: { deviceId: 'device-b', itemId: 'item-1' },
    });

    await expect(resumeSession(receiver)).resolves.toBe(false);
    expect(store.getState().currentItemId).toBeNull();
  });

  it('leaves the pointer on disk to tracking once it is running', async () => {
    // A departure tracking has not written out yet still names the item in
    // storage; resuming from there would reopen what review just left.
    const { receiver, getItemOrMissingFromId } = makeResumeReceiver({
      session: { deviceId: DEVICE, itemId: 'item-1' },
      tracked: null,
    });

    await expect(resumeSession(receiver)).resolves.toBe(false);
    expect(store.getState().currentItemId).toBeNull();
    expect(getItemOrMissingFromId).not.toHaveBeenCalled();
  });

  it('drops a pointer that no longer resolves', async () => {
    // The item was deleted, here or on another device.
    const { receiver, forget } = makeResumeReceiver({
      tracked: 'item-1',
      item: null,
    });

    await expect(resumeSession(receiver)).resolves.toBe(false);
    expect(store.getState().currentItemId).toBeNull();
    expect(forget).toHaveBeenCalledTimes(1);
  });

  it('drops it through tracking, not around it', async () => {
    // Writing straight to the file would leave the tracker holding the dead id
    // and handing it back on the next resume.
    const { receiver, saveSession } = makeResumeReceiver({
      tracked: 'item-1',
      item: null,
    });

    await resumeSession(receiver);

    expect(saveSession).not.toHaveBeenCalled();
  });

  it('drops an unresolvable pointer straight to disk at startup', async () => {
    // Before tracking begins there is nothing to tell, so the file is it.
    const { receiver, saveSession } = makeResumeReceiver({
      session: { deviceId: DEVICE, itemId: 'item-1' },
      item: null,
    });

    await expect(resumeSession(receiver)).resolves.toBe(false);
    expect(saveSession).toHaveBeenCalledWith(null);
  });

  it('drops a pointer to an item that was dismissed', async () => {
    // Dismissing writes to the database first, so a tab closed in the moments
    // after the click records the item still on screen. Nothing is scheduling
    // it any more, so review must not reopen on it.
    const { receiver, forget } = makeResumeReceiver({
      tracked: 'item-1',
      item: { data: { id: 'item-1', dismissed: 1 } } as unknown as ReviewItem,
    });

    await expect(resumeSession(receiver)).resolves.toBe(false);
    expect(store.getState().currentItemId).toBeNull();
    expect(forget).toHaveBeenCalledTimes(1);
  });

  it('leaves an item review is already showing alone', async () => {
    const { receiver, getItemOrMissingFromId } = makeResumeReceiver({
      tracked: 'item-1',
    });
    await resumeSession(receiver);
    getItemOrMissingFromId.mockClear();

    await expect(resumeSession(receiver)).resolves.toBe(false);
    expect(getItemOrMissingFromId).not.toHaveBeenCalled();
  });
});

describe('IncrementalReadingPlugin.addExtractCommands', () => {
  const kinds = fc.constantFrom<ExtractKind>('snippet', 'card');

  it('does what the action bar button does in the review tab', () => {
    // `Actions.extract` is the button's path: it makes the snippet or card at
    // once of selected text, and enters selection mode with none.
    fc.assert(
      fc.property(kinds, (kind) => {
        const { actions, reviewView, run } = makeExtractReceiver();

        run(kind);

        expect(actions.extract).toHaveBeenCalledExactlyOnceWith(
          kind,
          reviewView
        );
        expect(actions.createSnippet).not.toHaveBeenCalled();
        expect(actions.createCard).not.toHaveBeenCalled();
      })
    );
  });

  it('makes the snippet or card at once in a note', () => {
    // Selection mode is review's; a note has no action bar to confirm it from.
    fc.assert(
      fc.property(kinds, (kind) => {
        const { actions, run } = makeExtractReceiver({ where: 'note' });

        run(kind);

        const [made, other] =
          kind === 'snippet'
            ? [actions.createSnippet, actions.createCard]
            : [actions.createCard, actions.createSnippet];
        expect(made).toHaveBeenCalledExactlyOnceWith();
        expect(other).not.toHaveBeenCalled();
        expect(actions.extract).not.toHaveBeenCalled();
      })
    );
  });

  it('only answers whether it can run while the palette is checking', () => {
    fc.assert(
      fc.property(
        kinds,
        fc.constantFrom('review' as const, 'note' as const),
        (kind, where) => {
          const { actions, run } = makeExtractReceiver({ where });

          expect(run(kind, true)).toBe(true);

          expect(actions.extract).not.toHaveBeenCalled();
          expect(actions.createSnippet).not.toHaveBeenCalled();
          expect(actions.createCard).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('is unavailable with no editor on screen', () => {
    // A card still asking its question is rendered markdown, not an editor.
    fc.assert(
      fc.property(
        kinds,
        fc.constantFrom('review' as const, 'note' as const, 'none' as const),
        (kind, where) => {
          const { run } = makeExtractReceiver({ where, editor: false });

          expect(run(kind, true)).toBe(false);
        }
      )
    );
  });

  it('is unavailable outside review and notes', () => {
    fc.assert(
      fc.property(kinds, (kind) => {
        const { run } = makeExtractReceiver({ where: 'none' });

        expect(run(kind, true)).toBe(false);
      })
    );
  });

  it('does what the button does for a PDF in review, though it has no editor', () => {
    // The button makes snippets and cards from a PDF's viewer, which has no
    // editor; the hotkey should do the same rather than nothing at all
    fc.assert(
      fc.property(
        kinds,
        fc.mixedCase(fc.constant('pdf')),
        fc.boolean(),
        (kind, itemExtension, editor) => {
          const { actions, reviewView, run } = makeExtractReceiver({
            itemExtension,
            editor,
          });

          expect(run(kind, true)).toBe(true);
          expect(actions.extract).not.toHaveBeenCalled();

          run(kind);

          expect(actions.extract).toHaveBeenCalledExactlyOnceWith(
            kind,
            reviewView
          );
          expect(actions.createSnippet).not.toHaveBeenCalled();
          expect(actions.createCard).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('stays unavailable without an editor for any other review item', () => {
    fc.assert(
      fc.property(
        kinds,
        fc.option(
          fc.string().filter((ext) => ext.toLowerCase() !== 'pdf'),
          { nil: null }
        ),
        (kind, itemExtension) => {
          const { run } = makeExtractReceiver({ itemExtension, editor: false });

          expect(run(kind, true)).toBe(false);
        }
      )
    );
  });

  it("makes the snippet or card from a PDF open in Obsidian's own tab, which has no editor", () => {
    fc.assert(
      fc.property(kinds, fc.boolean(), (kind, editor) => {
        const { actions, fileView, run } = makeExtractReceiver({
          where: 'pdf',
          editor,
        });

        expect(run(kind, true)).toBe(true);
        expect(actions.extractFromPdfTab).not.toHaveBeenCalled();

        run(kind);

        expect(actions.extractFromPdfTab).toHaveBeenCalledExactlyOnceWith(
          kind,
          fileView
        );
        expect(actions.extract).not.toHaveBeenCalled();
        expect(actions.createSnippet).not.toHaveBeenCalled();
        expect(actions.createCard).not.toHaveBeenCalled();
      })
    );
  });

  it('is unavailable on a PDF tab with no file open, and on any other file view without an editor', () => {
    fc.assert(
      fc.property(
        kinds,
        fc.string().filter((type) => type !== 'pdf'),
        (kind, otherViewType) => {
          expect(
            makeExtractReceiver({
              where: 'pdf',
              tabFile: null,
              editor: false,
            }).run(kind, true)
          ).toBe(false);
          expect(
            makeExtractReceiver({
              where: 'other',
              otherViewType,
              editor: false,
            }).run(kind, true)
          ).toBe(false);
        }
      )
    );
  });

  it("stops following PDF tabs' selections once the plugin unloads", () => {
    // The commands start following a tab's selection whatever else loaded
    const stop = vi.spyOn(ObsidianPdf, 'stopPdfTabSelections');
    const { unload } = makeExtractReceiver({ where: 'pdf' });
    expect(stop).not.toHaveBeenCalled();

    unload();

    expect(stop).toHaveBeenCalledOnce();
    stop.mockRestore();
  });

  it('makes neither a snippet nor a card from a note in reading mode', () => {
    // Reading view's editor is hidden: what it has selected is not what the
    // user selected on screen, so neither is made of it.
    fc.assert(
      fc.property(kinds, fc.boolean(), (kind, checking) => {
        const { actions, run } = makeExtractReceiver({
          where: 'note',
          reading: true,
        });

        expect(run(kind, checking)).toBe(false);

        expect(actions.createSnippet).not.toHaveBeenCalled();
        expect(actions.createCard).not.toHaveBeenCalled();
        expect(actions.extract).not.toHaveBeenCalled();
        expect(actions.extractFromPdfTab).not.toHaveBeenCalled();
      })
    );
  });

  /** Whatever tab is active, in whatever state, as `makeExtractReceiver` takes it. */
  const anywhere = fc.record({
    where: fc.constantFrom(
      'review' as const,
      'note' as const,
      'pdf' as const,
      'other' as const,
      'none' as const
    ),
    reading: fc.boolean(),
    editor: fc.boolean(),
    itemExtension: fc.option(fc.constantFrom('md', 'pdf', 'PDF', 'png', ''), {
      nil: null,
    }),
    tabFile: fc.option(
      fc
        .constantFrom('pdf', 'PDF', 'md', 'png')
        .map((extension) => ({ path: `a.${extension}`, extension }) as TFile),
      { nil: null }
    ),
    otherViewType: fc.constantFrom('image', 'pdf', 'markdown', ''),
  });

  it('is available to the snippet and card commands alike, wherever the user is', () => {
    // One guard for both: neither is ever offered where the other is not
    fc.assert(
      fc.property(anywhere, (state) => {
        const { run } = makeExtractReceiver(state);

        expect(run('card', true)).toBe(run('snippet', true));
      })
    );
  });

  it('is unavailable, and makes nothing, until the plugin has loaded', () => {
    fc.assert(
      fc.property(kinds, anywhere, (kind, state) => {
        const { actions, run } = makeExtractReceiver({
          ...state,
          loaded: false,
        });

        expect(run(kind, true)).toBe(false);
        run(kind);

        expect(actions.extract).not.toHaveBeenCalled();
        expect(actions.extractFromPdfTab).not.toHaveBeenCalled();
        expect(actions.createSnippet).not.toHaveBeenCalled();
        expect(actions.createCard).not.toHaveBeenCalled();
      })
    );
  });
});

describe('IncrementalReadingPlugin.followMovedNotes', () => {
  beforeEach(() => {
    // The scan yields through `window`; Node, like WebKit, has no idle callback
    vi.stubGlobal('window', globalThis);
    store.dispatch(resetSession());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('waits for Obsidian to finish indexing before looking for moved notes', async () => {
    const follow = makeFollowReceiver();

    followMovedNotes(follow);
    await settle();
    expect(follow.repo.query).not.toHaveBeenCalled();

    follow.finishIndexing();
    await vi.waitFor(() =>
      expect(follow.repo.mutate).toHaveBeenLastCalledWith(expect.any(String), [
        'moved/one.md',
        'a',
        expect.any(String),
      ])
    );
  });

  it('looks for notes left without review data once the scan is done, and not before', async () => {
    const follow = makeFollowReceiver();

    followMovedNotes(follow);
    await settle();
    expect(follow.startupScan).not.toHaveBeenCalled();

    follow.finishIndexing();
    await vi.waitFor(() => expect(follow.startupScan).toHaveBeenCalledOnce());
    expect(follow.itemPathsWithRefusedChars).toHaveBeenCalled();
  });

  it('imports notes tagged while Obsidian was closed once the moved notes are followed, and not before', async () => {
    const follow = makeFollowReceiver();
    let followed!: () => void;
    follow.claimMovedFiles.mockReturnValueOnce(
      new Promise<void>((resolve) => (followed = resolve))
    );

    followMovedNotes(follow);
    await settle();
    expect(follow.runCatchUpScan).not.toHaveBeenCalled();

    follow.finishIndexing();
    await vi.waitFor(() => expect(follow.claimMovedFiles).toHaveBeenCalled());
    await settle();
    expect(follow.runCatchUpScan).not.toHaveBeenCalled();

    followed();
    await vi.waitFor(() =>
      expect(follow.runCatchUpScan).toHaveBeenCalledOnce()
    );
  });

  it('imports notes tagged while Obsidian was closed once the resolved event comes, where Obsidian has no onCleanCache', async () => {
    const follow = makeFollowReceiver({ indexingSignal: false });

    followMovedNotes(follow);
    await settle();
    expect(follow.runCatchUpScan).not.toHaveBeenCalled();

    follow.finishIndexing();
    await vi.waitFor(() =>
      expect(follow.runCatchUpScan).toHaveBeenCalledOnce()
    );
  });

  it('imports notes tagged while Obsidian was closed only once the watcher is made, holding back the look for leftovers till then', async () => {
    const follow = makeFollowReceiver({ watcherMade: false });

    followMovedNotes(follow);
    follow.finishIndexing();
    await vi.waitFor(() => expect(follow.claimMovedFiles).toHaveBeenCalled());
    await settle();
    expect(follow.runCatchUpScan).not.toHaveBeenCalled();
    expect(follow.startupScan).not.toHaveBeenCalled();

    follow.makeWatcher();

    await vi.waitFor(() => expect(follow.startupScan).toHaveBeenCalledOnce());
    expect(follow.runCatchUpScan).toHaveBeenCalledOnce();
  });

  it('imports no notes tagged while Obsidian was closed when unloaded before the watcher is made', async () => {
    const follow = makeFollowReceiver({ watcherMade: false });

    followMovedNotes(follow);
    follow.finishIndexing();
    await vi.waitFor(() => expect(follow.claimMovedFiles).toHaveBeenCalled());
    follow.unload();
    follow.makeWatcher();
    await settle();

    expect(follow.runCatchUpScan).not.toHaveBeenCalled();
    expect(follow.startupScan).not.toHaveBeenCalled();
  });

  it('still imports notes tagged while Obsidian was closed when following the moves fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const follow = makeFollowReceiver();
    follow.claimMovedFiles.mockRejectedValue(new Error('disk full'));

    followMovedNotes(follow);
    follow.finishIndexing();

    await vi.waitFor(() =>
      expect(follow.runCatchUpScan).toHaveBeenCalledOnce()
    );
  });

  it('looks for leftovers only once the notes tagged while Obsidian was closed are imported', async () => {
    const follow = makeFollowReceiver();
    let imported!: () => void;
    follow.runCatchUpScan.mockReturnValueOnce(
      new Promise<void>((resolve) => (imported = resolve))
    );

    followMovedNotes(follow);
    follow.finishIndexing();
    await vi.waitFor(() => expect(follow.runCatchUpScan).toHaveBeenCalled());
    await settle();
    expect(follow.startupScan).not.toHaveBeenCalled();

    imported();
    await vi.waitFor(() => expect(follow.startupScan).toHaveBeenCalledOnce());
  });

  it('reports a failed import of notes tagged while Obsidian was closed, and still looks for leftovers', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('no vault');
    const follow = makeFollowReceiver();
    follow.runCatchUpScan.mockRejectedValueOnce(failure);

    followMovedNotes(follow);
    follow.finishIndexing();

    await vi.waitFor(() => expect(follow.startupScan).toHaveBeenCalledOnce());
    expect(error).toHaveBeenCalledWith(
      'Incremental Reading - failed to catch up on automatic imports:',
      failure
    );
  });

  it('imports no notes tagged while Obsidian was closed once unloaded', async () => {
    const follow = makeFollowReceiver();

    followMovedNotes(follow);
    follow.unload();
    follow.finishIndexing();
    await settle();

    expect(follow.runCatchUpScan).not.toHaveBeenCalled();
  });

  it('imports no notes tagged while Obsidian was closed when unloaded while following the moves', async () => {
    const follow = makeFollowReceiver();
    let followed!: () => void;
    follow.claimMovedFiles.mockReturnValueOnce(
      new Promise<void>((resolve) => (followed = resolve))
    );

    followMovedNotes(follow);
    follow.finishIndexing();
    await vi.waitFor(() => expect(follow.claimMovedFiles).toHaveBeenCalled());
    follow.unload();
    followed();
    await settle();

    expect(follow.runCatchUpScan).not.toHaveBeenCalled();
  });

  it('looks for no leftovers once unloaded', async () => {
    const follow = makeFollowReceiver();

    followMovedNotes(follow);
    follow.unload();
    follow.finishIndexing();
    await settle();

    expect(follow.startupScan).not.toHaveBeenCalled();
  });

  it('waits for the resolved event where Obsidian has no onCleanCache', async () => {
    const follow = makeFollowReceiver({ indexingSignal: false });

    followMovedNotes(follow);
    await settle();
    expect(follow.metadataCache.on).toHaveBeenCalledWith(
      'resolved',
      expect.any(Function)
    );
    expect(follow.repo.query).not.toHaveBeenCalled();

    follow.finishIndexing();

    await vi.waitFor(() => expect(follow.repo.transaction).toHaveBeenCalled());
    // `resolved` fires again on every later change; one scan is enough
    expect(follow.metadataCache.offref).toHaveBeenCalledWith(
      follow.resolvedRef
    );
  });

  it('refreshes highlights and the item on screen once notes have moved', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const follow = makeFollowReceiver();

    followMovedNotes(follow);
    follow.finishIndexing();

    await vi.waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['current-review-item'],
      })
    );
    expect(follow.refreshAllHighlights).toHaveBeenCalledTimes(1);
  });

  it("points the source links of the moved items' snippets and cards at where they went", async () => {
    const follow = makeFollowReceiver();

    followMovedNotes(follow);
    follow.finishIndexing();

    await vi.waitFor(() =>
      expect(follow.followChildSources).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({
          id: 'a',
          from: 'one.md',
          to: 'moved/one.md',
        }),
      ])
    );
    // And gives them whatever was taken from where they went meanwhile
    await vi.waitFor(() =>
      expect(follow.claimMovedFiles).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({
          id: 'a',
          from: 'one.md',
          to: 'moved/one.md',
        }),
      ])
    );
  });

  it('leaves highlights and review alone when nothing moved', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const follow = makeFollowReceiver({ moved: false });

    followMovedNotes(follow);
    follow.finishIndexing();
    await vi.waitFor(() =>
      expect(follow.receiver.app.vault.getFileByPath).toHaveBeenCalled()
    );
    await settle();

    expect(follow.refreshAllHighlights).not.toHaveBeenCalled();
    expect(follow.followChildSources).not.toHaveBeenCalled();
    expect(follow.claimMovedFiles).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'warns once, in a notice that stays, of item paths that already break links, after following moves (moved: %s)',
    async (moved) => {
      Notice.reset();
      const notify = vi.spyOn(Obsidian, 'notify');
      const paths = ['a|b.md', 'x>y/c.md'];
      const follow = makeFollowReceiver({ moved, refusedPaths: paths });

      followMovedNotes(follow);
      follow.finishIndexing();

      await vi.waitFor(() =>
        expect(Notice.messages).toStrictEqual([refusedPathsWarning(paths)])
      );
      expect(notify).toHaveBeenCalledExactlyOnceWith(
        refusedPathsWarning(paths),
        { persist: true }
      );
      expect(follow.itemPathsWithRefusedChars).toHaveBeenCalledOnce();
      if (moved) {
        expect(
          follow.itemPathsWithRefusedChars.mock.invocationCallOrder[0]
        ).toBeGreaterThan(follow.claimMovedFiles.mock.invocationCallOrder[0]);
      }
    }
  );

  it('warns again only when a path the user has not heard of appears, keeping the list when it changes', async () => {
    const notify = vi.spyOn(Obsidian, 'notify');
    const heard = makeFollowReceiver({
      refusedPaths: ['a|b.md'],
      warned: ['a|b.md', 'gone#.md'],
    });

    followMovedNotes(heard);
    heard.finishIndexing();
    await vi.waitFor(() =>
      expect(heard.saveLocalStorage).toHaveBeenCalledExactlyOnceWith(
        WARNED_PATHS_KEY,
        ['a|b.md']
      )
    );
    expect(heard.saveData).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();

    const same = makeFollowReceiver({
      refusedPaths: ['a|b.md'],
      warned: ['a|b.md'],
    });
    followMovedNotes(same);
    same.finishIndexing();
    await vi.waitFor(() =>
      expect(same.itemPathsWithRefusedChars).toHaveBeenCalled()
    );
    await settle();
    expect(same.saveLocalStorage).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();

    const fresh = makeFollowReceiver({
      refusedPaths: ['a|b.md', 'c>.md'],
      warned: ['a|b.md'],
    });
    followMovedNotes(fresh);
    fresh.finishIndexing();
    await vi.waitFor(() =>
      expect(fresh.saveLocalStorage).toHaveBeenCalledExactlyOnceWith(
        WARNED_PATHS_KEY,
        ['a|b.md', 'c>.md']
      )
    );
    expect(fresh.saveData).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      refusedPathsWarning(['a|b.md', 'c>.md']),
      { persist: true }
    );
  });

  it('says nothing when no item path breaks links', async () => {
    Notice.reset();
    const follow = makeFollowReceiver();

    followMovedNotes(follow);
    follow.finishIndexing();
    await vi.waitFor(() =>
      expect(follow.itemPathsWithRefusedChars).toHaveBeenCalled()
    );
    await settle();

    expect(Notice.messages).toStrictEqual([]);
  });

  it('abandons the scan when the plugin unloads', async () => {
    const follow = makeFollowReceiver();

    followMovedNotes(follow);
    follow.unload();
    follow.finishIndexing();
    await settle();

    expect(follow.repo.query).not.toHaveBeenCalled();
    expect(follow.repo.mutate).not.toHaveBeenCalled();
  });

  it('still warns of item paths that break links when following the moves fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const notify = vi.spyOn(Obsidian, 'notify');
    const follow = makeFollowReceiver({ refusedPaths: ['a|b.md'] });
    follow.claimMovedFiles.mockRejectedValue(new Error('disk full'));

    followMovedNotes(follow);
    follow.finishIndexing();

    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledExactlyOnceWith(
        refusedPathsWarning(['a|b.md']),
        { persist: true }
      )
    );
  });

  it('reports a failed look for item paths that break links rather than letting it escape', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('no database');
    const follow = makeFollowReceiver({ moved: false });
    follow.itemPathsWithRefusedChars.mockRejectedValue(failure);

    followMovedNotes(follow);
    follow.finishIndexing();

    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        'Incremental Reading - failed to look for item paths that break links:',
        failure
      )
    );
  });

  it('looks for no item paths once the plugin unloads', async () => {
    const follow = makeFollowReceiver({ refusedPaths: ['a|b.md'] });

    followMovedNotes(follow);
    follow.unload();
    follow.finishIndexing();
    await settle();

    expect(follow.itemPathsWithRefusedChars).not.toHaveBeenCalled();
  });

  it('reports a failed scan rather than letting it escape', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('disk full');
    const follow = makeFollowReceiver();
    follow.repo.transaction.mockRejectedValue(failure);

    followMovedNotes(follow);
    follow.finishIndexing();

    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        'Incremental Reading - failed to follow moved notes:',
        failure
      )
    );
    expect(follow.refreshAllHighlights).not.toHaveBeenCalled();
  });
});

describe('IncrementalReadingPlugin renames', () => {
  it('hears no rename before the review manager is up', async () => {
    const { rename, follow } = await startRenames(['a.md']);

    rename(tFileAt('a|b.md'), 'a.md');

    expect(follow).not.toHaveBeenCalled();
  });

  it.each(['rename', 'delete'] as const)(
    'follows a %s heard during a merge once the merge ends, and none heard while saving is paused',
    async (kind) => {
      const renames = await startRenames(['a.md']);
      await renames.start();
      const heard = kind === 'rename' ? renames.follow : renames.deletion;
      const hear = (file: TFile) =>
        kind === 'rename' ? renames.rename(file, 'a.md') : renames.remove(file);
      const merged = tFileAt('b.md');

      renames.becomes('merging');
      hear(merged);
      await Promise.resolve();
      expect(heard).not.toHaveBeenCalled();
      renames.becomes('ready');
      await Promise.resolve();
      expect(heard).toHaveBeenCalledOnce();

      renames.becomes('starting');
      hear(tFileAt('c.md'));
      renames.becomes('ready');
      await Promise.resolve();
      expect(heard).toHaveBeenCalledOnce();
      expect(renames.notify).not.toHaveBeenCalled();
    }
  );

  it('follows a renamed file, but not a folder, when the rename breaks no link', async () => {
    const renames = await startRenames(['a.md']);
    await renames.start();
    const file = tFileAt('b.md');

    renames.rename(file, 'a.md');
    renames.rename(Object.assign(new TFolder(), { path: 'x|y' }), 'xy');

    expect(renames.follow).toHaveBeenCalledExactlyOnceWith(file, 'a.md');
    expect(renames.vaultRename).not.toHaveBeenCalled();
  });

  it('puts back a rename that breaks links to an item, following neither it nor its undo', async () => {
    const renames = await startRenames(['a.md']);
    await renames.start();
    const file = tFileAt('a|b.md');

    renames.rename(file, 'a.md');

    await vi.waitFor(() => expect(renames.notify).toHaveBeenCalledOnce());
    expect(file.path).toBe('a.md');
    expect(renames.notify).toHaveBeenCalledWith(expect.stringContaining('|'));
    expect(renames.follow).not.toHaveBeenCalled();
  });

  it("follows each file of a folder holding an item, from where it was, when the folder couldn't be put back", async () => {
    const renames = await startRenames(['notes/card.md']);
    renames.vaultRename.mockRejectedValue(new Error('taken'));
    await renames.start();
    const folder = Object.assign(new TFolder(), {
      path: 'no|tes',
      name: 'no|tes',
    });
    const card = Object.assign(tFileAt('notes/card.md'), { parent: folder });
    folder.children.push(card);

    renames.rename(folder, 'notes');
    card.path = 'no|tes/card.md';
    renames.rename(card, 'notes/card.md');

    await vi.waitFor(() =>
      expect(renames.follow).toHaveBeenCalledExactlyOnceWith(
        card,
        'notes/card.md'
      )
    );
    expect(renames.notify).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('no|tes'),
      { kind: 'error' }
    );
  });

  it('marks a deleted file deleted where it was, or, while its rename was being put back, where the database has it', async () => {
    const renames = await startRenames(['a.md']);
    const plain = tFileAt('b.md');
    renames.remove(plain);
    expect(renames.deletion).not.toHaveBeenCalled();

    await renames.start();
    renames.vaultRename.mockImplementation(() => new Promise(() => {}));
    renames.remove(plain);
    const file = tFileAt('a|b.md');
    renames.rename(file, 'a.md');
    renames.remove(file);

    expect(renames.deletion.mock.calls).toStrictEqual([
      [plain, 'b.md'],
      [file, 'a.md'],
    ]);
  });
});

describe('IncrementalReadingPlugin.watchCreations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tells once of the items a burst brought to paths that break links, and counts them as heard of', async () => {
    vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
    const notify = vi.spyOn(Obsidian, 'notify');
    const watch = makeCreationReceiver(['a|.md', null, 'b#.md']);

    watch.create({ path: 'early.md' });
    expect(watch.handleCreation).not.toHaveBeenCalled();
    watch.receiver.reviewManager = { handleCreation: watch.handleCreation };
    for (const path of ['a|.md', 'plain.md', 'b#.md']) watch.create({ path });
    await vi.waitFor(() =>
      expect(watch.handleCreation).toHaveBeenCalledTimes(3)
    );
    await settle();
    expect(notify).not.toHaveBeenCalled();
    watch.fire();

    expect(notify).toHaveBeenCalledExactlyOnceWith(
      refusedPathsWarning(['a|.md', 'b#.md'])
    );
    await vi.waitFor(() =>
      expect(
        watch.receiver.app.saveLocalStorage
      ).toHaveBeenCalledExactlyOnceWith(WARNED_PATHS_KEY, [
        'old|.md',
        'a|.md',
        'b#.md',
      ])
    );
    expect(watch.receiver.saveData).not.toHaveBeenCalled();
  });

  it('drops a waiting notice when the plugin unloads', async () => {
    vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
    const notify = vi.spyOn(Obsidian, 'notify');
    const watch = makeCreationReceiver(['a|.md']);
    watch.receiver.reviewManager = { handleCreation: watch.handleCreation };
    watch.create({ path: 'a|.md' });
    await vi.waitFor(() => expect(watch.handleCreation).toHaveBeenCalled());
    await settle();

    watch.unload();
    watch.fire();

    expect(notify).not.toHaveBeenCalled();
  });
});

describe('IncrementalReadingPlugin.watchAutoImports', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The watcher waits through `window`
    vi.stubGlobal('window', globalThis);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('imports a note whose frontmatter gains a trigger tag where it is, at the default priority, once it settles', async () => {
    const watch = makeAutoImportReceiver();
    watch.startReviewManager();
    watch.receiver.settings.defaultPriority = 17;

    const file = watch.change('inbox/clip.md', { tags: [AUTO_IMPORT_TAG] });
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);

    expect(watch.importTaggedNotes).toHaveBeenCalledExactlyOnceWith(
      [{ file, matchedTags: [AUTO_IMPORT_TAG] }],
      { priority: 17, mode: 'inPlace' }
    );
  });

  it('leaves nothing on the undo stack for what it imports', async () => {
    const watch = makeAutoImportReceiver();
    watch.startReviewManager();
    watch.importTaggedNotes.mockImplementation(async (entries) =>
      entries.map(({ file }) => ({
        file,
        status: 'imported',
        articleId: 'made',
        effect: 'created',
      }))
    );

    watch.change('inbox/clip.md', { tags: [AUTO_IMPORT_TAG] });
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);

    expect(watch.importTaggedNotes).toHaveBeenCalledOnce();
    expect(watch.recordImport).not.toHaveBeenCalled();
  });

  it('imports in the way of importing tagged notes set when the batch is imported', async () => {
    for (const mode of ['inPlace', 'copy', 'inherit'] as const) {
      const watch = makeAutoImportReceiver();
      watch.startReviewManager();
      const { settings } = watch.receiver;

      watch.change('inbox/clip.md', { tags: [AUTO_IMPORT_TAG] });
      settings.autoImportMode = mode;
      await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);

      expect(watch.importTaggedNotes).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        { priority: settings.defaultPriority, mode }
      );
    }
  });

  it('imports a note whose ir-id the review manager finds no row for, and not one whose ir-id it does', async () => {
    const watch = makeAutoImportReceiver();
    watch.startReviewManager();
    watch.hasItemRow.mockImplementation((id) => Promise.resolve(id === 'kept'));

    const orphan = watch.change('orphan.md', {
      'ir-id': 'gone',
      tags: [AUTO_IMPORT_TAG],
    });
    watch.change('known.md', { 'ir-id': 'kept', tags: [AUTO_IMPORT_TAG] });
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);

    expect(watch.hasItemRow.mock.calls).toEqual([['gone'], ['kept']]);
    expect(watch.importTaggedNotes).toHaveBeenCalledExactlyOnceWith(
      [{ file: orphan, matchedTags: [AUTO_IMPORT_TAG] }],
      expect.anything()
    );
  });

  it('ignores changes until the review manager is up', async () => {
    const watch = makeAutoImportReceiver();

    watch.change('a.md', { tags: [AUTO_IMPORT_TAG] });
    watch.startReviewManager();
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_MAX_WAIT_MS);

    expect(watch.importTaggedNotes).not.toHaveBeenCalled();
  });

  it('follows the settings as they are at each change, with no reload', async () => {
    const watch = makeAutoImportReceiver();
    watch.startReviewManager();
    const { settings } = watch.receiver;

    settings.autoImportOnTag = false;
    watch.change('off.md', { tags: [AUTO_IMPORT_TAG] });
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_MAX_WAIT_MS);
    expect(watch.importTaggedNotes).not.toHaveBeenCalled();

    settings.autoImportOnTag = true;
    settings.autoImportTags = ['to-read'];
    watch.change('old-tag.md', { tags: [AUTO_IMPORT_TAG] });
    const file = watch.change('new-tag.md', { tags: ['to-read'] });
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_MAX_WAIT_MS);

    expect(watch.importTaggedNotes).toHaveBeenCalledExactlyOnceWith(
      [{ file, matchedTags: ['to-read'] }],
      expect.anything()
    );
  });

  it('hands the watcher it makes to the startup scan waiting for it', () => {
    const watch = makeAutoImportReceiver();

    expect(watch.receiver.autoImportWatcher).toBeInstanceOf(AutoImportWatcher);
    expect(
      watch.receiver.autoImportWatcherMade.resolve
    ).toHaveBeenCalledExactlyOnceWith(watch.receiver.autoImportWatcher);
  });

  it('watches from the moment importing by tag is turned on in the settings, until the plugin unloads', async () => {
    const watch = makeAutoImportReceiver();
    const { settings, app } = watch.receiver;
    settings.autoImportOnTag = false;
    watch.saveSettings();
    await vi.advanceTimersByTimeAsync(1000);

    settings.autoImportOnTag = true;
    watch.saveSettings();
    const turnedOn = Date.now();
    expect(loadAutoImportWatermark(app)).toBe(turnedOn);

    expect(watch.settingsListeners()).toBe(1);
    watch.unload();
    expect(watch.settingsListeners()).toBe(0);
  });

  it('listens for as long as the plugin is loaded, and drops what is waiting when it unloads', async () => {
    const watch = makeAutoImportReceiver();
    watch.startReviewManager();

    expect(watch.receiver.registerEvent).toHaveBeenCalledWith(watch.changedRef);
    watch.change('a.md', { tags: [AUTO_IMPORT_TAG] });
    watch.unload();
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_MAX_WAIT_MS);

    expect(watch.importTaggedNotes).not.toHaveBeenCalled();
  });

  it('imports a file created in a watched folder or moved into one where it is, at the default priority, once it settles', async () => {
    const watch = makeAutoImportReceiver();
    watch.startReviewManager();
    Object.assign(watch.receiver.settings, {
      autoImportOnTag: false,
      autoImportOnFolder: true,
      autoImportFolders: ['Inbox'],
      defaultPriority: 23,
    });

    const pdf = watch.arrive('Inbox/paper.pdf');
    const note = watch.arrive('Inbox/note.md', 'note.md');
    watch.arrive('Inbox/sub/within.md', 'Inbox/within.md');
    watch.arrive('Elsewhere/other.pdf');
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);

    expect(watch.importTaggedNotes).toHaveBeenCalledExactlyOnceWith(
      [
        { file: pdf, matchedTags: [] },
        { file: note, matchedTags: [] },
      ],
      { priority: 23, mode: 'inPlace' }
    );
  });

  it('imports a file arriving in a watched folder in the way of importing tagged notes set', async () => {
    for (const mode of ['inPlace', 'copy', 'inherit'] as const) {
      const watch = makeAutoImportReceiver();
      watch.startReviewManager();
      Object.assign(watch.receiver.settings, {
        autoImportOnTag: false,
        autoImportOnFolder: true,
        autoImportFolders: ['Inbox'],
        autoImportMode: mode,
      });

      const file = watch.arrive('Inbox/paper.pdf');
      await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);

      expect(watch.importTaggedNotes).toHaveBeenCalledExactlyOnceWith(
        [{ file, matchedTags: [] }],
        { priority: watch.receiver.settings.defaultPriority, mode }
      );
    }
  });

  it('ignores arrivals until the review manager is up, and follows the watched folders as they are at each', async () => {
    const watch = makeAutoImportReceiver();
    const { settings } = watch.receiver;
    settings.autoImportOnFolder = true;
    settings.autoImportFolders = ['Inbox'];

    watch.arrive('Inbox/early.pdf');
    watch.arrive('Inbox/early.md', 'early.md');
    watch.startReviewManager();
    settings.autoImportOnFolder = false;
    watch.arrive('Inbox/off.pdf');
    settings.autoImportOnFolder = true;
    settings.autoImportFolders = ['Clips'];
    watch.arrive('Inbox/unwatched.pdf');
    const file = watch.arrive('Clips/clip.pdf');
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_MAX_WAIT_MS);

    expect(watch.importTaggedNotes).toHaveBeenCalledExactlyOnceWith(
      [{ file, matchedTags: [] }],
      expect.anything()
    );
  });

  it('listens for arrivals for as long as the plugin is loaded, and drops those waiting when it unloads', async () => {
    const watch = makeAutoImportReceiver();
    watch.startReviewManager();
    Object.assign(watch.receiver.settings, {
      autoImportOnFolder: true,
      autoImportFolders: ['Inbox'],
    });

    expect(watch.receiver.registerEvent).toHaveBeenCalledWith(
      watch.arrivalRefs.create
    );
    expect(watch.receiver.registerEvent).toHaveBeenCalledWith(
      watch.arrivalRefs.rename
    );
    watch.arrive('Inbox/a.pdf');
    watch.unload();
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_MAX_WAIT_MS);

    expect(watch.importTaggedNotes).not.toHaveBeenCalled();
  });

  it('has the watcher forget each file deleted from a watched folder, the review manager up or not', async () => {
    const watch = makeAutoImportReceiver();
    const { app, settings } = watch.receiver;
    Object.assign(settings, {
      autoImportOnFolder: true,
      autoImportFolders: ['Inbox'],
    });
    saveWatchedFolderLedger(app, {
      folders: ['Inbox'],
      paths: ['Inbox/a.pdf', 'Inbox/b.pdf'],
    });

    watch.remove('Inbox/a.pdf');
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);

    expect(watch.receiver.registerEvent).toHaveBeenCalledWith(
      watch.arrivalRefs.delete
    );
    expect(loadWatchedFolderLedger(app)).toEqual({
      folders: ['Inbox'],
      paths: ['Inbox/b.pdf'],
    });
  });
});

describe('IncrementalReadingPlugin database reload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('re-checks the action bars on open tabs when the database is swapped in from disk', async () => {
    const resync = vi.fn();
    const { reload } = await startDatabase(resync);
    expect(resync).not.toHaveBeenCalled();

    await reload();

    expect(resync).toHaveBeenCalledOnce();
  });

  it('reloads without error before the action bars are registered', async () => {
    const { reload } = await startDatabase(undefined);

    await expect(reload()).resolves.toBeUndefined();
  });

  it('tells the user why changes are no longer saved, until they are again', async () => {
    Notice.reset();
    const { blockWrites, resumeWrites } = await startDatabase(undefined);

    blockWrites(new Error('The file could not be loaded.'));

    expect(Notice.messages).toEqual([
      expect.stringContaining('The file could not be loaded.'),
    ]);
    const [blocked] = Notice.instances;
    expect(blocked.hides).toBe(0);

    resumeWrites();

    expect(blocked.hides).toBe(1);
  });

  it('saves the highlight offsets held back while saving was paused, once it resumes', async () => {
    const persist = vi
      .spyOn(SnippetManager.prototype, 'persistPendingOffsets')
      .mockResolvedValue(undefined);
    const { blockWrites, resumeWrites } = await startDatabase(undefined);
    blockWrites(new Error('The file could not be loaded.'));
    expect(persist).not.toHaveBeenCalled();

    resumeWrites();

    expect(persist).toHaveBeenCalledOnce();
  });

  it('resumes quietly when no notice is up', async () => {
    const hide = vi.spyOn(Notice.prototype, 'hide');
    const { resumeWrites } = await startDatabase(undefined);

    resumeWrites();

    expect(hide).not.toHaveBeenCalled();
  });

  it('refetches the queue when the database is swapped in from disk', async () => {
    const { reload } = await startDatabase(undefined);
    // The spy `startDatabase` set up, handed back rather than replaced
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await reload();

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['queue'] });
  });
});

describe('IncrementalReadingPlugin database reload: the item under review', () => {
  afterEach(() => {
    store.dispatch(resetSession());
    vi.restoreAllMocks();
  });

  it('moves review off an item another device deleted for good, before refetching it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.boolean(),
        fc.constantFrom<ReviewPage>('home', 'review'),
        async (currentId, rowKept, page) => {
          store.dispatch(resetSession());
          store.dispatch(setCurrentItemId(currentId));
          store.dispatch(setPage(page));
          const hasItemRow = vi
            .spyOn(ReviewManager.prototype, 'hasItemRow')
            .mockResolvedValue(rowKept);
          const { reload } = await startDatabase(undefined);
          // The spy `startDatabase` set up, handed back rather than replaced
          const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
          /** Which item review held as each refetch of the item started. */
          const heldAtRefetch: (string | null)[] = [];
          invalidate.mockImplementation(async (filters) => {
            if (filters?.queryKey?.[0] === 'current-review-item') {
              heldAtRefetch.push(store.getState().currentItemId);
            }
          });

          await reload();

          const expected = rowKept ? currentId : null;
          expect(hasItemRow).toHaveBeenCalledWith(currentId);
          expect(store.getState().currentItemId).toBe(expected);
          expect(store.getState().page).toBe(page);
          expect(heldAtRefetch.length).toBeGreaterThan(0);
          for (const held of heldAtRefetch) expect(held).toBe(expected);
          vi.restoreAllMocks();
        }
      ),
      { numRuns: 30 }
    );
  });

  it('reloads without error while review holds an item and the review manager is not up yet', async () => {
    store.dispatch(setCurrentItemId('held'));
    let reloaded: Promise<unknown> = Promise.resolve();
    vi.spyOn(SQLJSRepository, 'start').mockImplementation((params) => {
      // The repository reloading before `start` has handed it back
      reloaded = Promise.resolve(params.onReloadFromDisk?.());
      return Promise.resolve({
        onDataChange: vi.fn(() => () => {}),
        handleFileChange: vi.fn(async () => {}),
      } as unknown as SQLJSRepository);
    });
    vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
    await (
      IncrementalReadingPlugin.prototype as unknown as {
        initReviewManager(): Promise<void>;
      }
    ).initReviewManager.call({
      app: { vault: { on: vi.fn() } },
      register: vi.fn(),
      registerEvent: vi.fn(),
      followMovedNotes: vi.fn(),
      createLeftoverWatch: vi.fn(),
    });

    await expect(reloaded).resolves.toBeUndefined();
    expect(store.getState().currentItemId).toBe('held');
  });

  it('looks no row up while review holds no item', async () => {
    store.dispatch(resetSession());
    const hasItemRow = vi.spyOn(ReviewManager.prototype, 'hasItemRow');
    const { reload } = await startDatabase(undefined);

    await reload();

    expect(hasItemRow).not.toHaveBeenCalled();
    expect(store.getState().currentItemId).toBeNull();
  });
});

describe('IncrementalReadingPlugin review reminders', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A desktop or mobile plugin with its database up, and the reminder it starts. */
  function startReminder(isMobile: boolean) {
    const reminder = { refresh: vi.fn(), dispose: vi.fn() };
    const start = vi
      .spyOn(ReviewReminder, 'startReviewReminder')
      .mockReturnValue(reminder);
    const statusBarItem = { statusBarItem: true };
    const unsubscribe = vi.fn();
    const receiver = {
      app: { isMobile },
      addStatusBarItem: vi.fn(() => statusBarItem),
      reviewManager: { repo: { onDataChange: vi.fn(() => unsubscribe) } },
      settings: { reviewReminders: true },
      onSettingsChange: vi.fn(),
      learn: vi.fn(() => Promise.resolve()),
      register: vi.fn(),
      reviewReminder: undefined as unknown,
    };
    (
      IncrementalReadingPlugin.prototype as unknown as {
        showReviewReminders(): void;
      }
    ).showReviewReminders.call(receiver);
    return { start, reminder, receiver, statusBarItem, unsubscribe };
  }

  it('puts a reminder in the status bar on desktop, over the plugin settings and database', () => {
    const { start, receiver, statusBarItem, unsubscribe } =
      startReminder(false);

    expect(start).toHaveBeenCalledOnce();
    const [options] = start.mock.calls[0];
    expect(options.el).toBe(statusBarItem);
    expect(options.icon).toBe(PLUGIN_ICON);
    expect(options.reviewManager).toBe(receiver.reviewManager);
    expect(options.getSettings()).toBe(receiver.settings);
    expect(options.onSettingsChange).toBe(receiver.onSettingsChange);

    const listener = vi.fn();
    expect(options.onDataChange(listener)).toBe(unsubscribe);
    const [[heard]] = receiver.reviewManager.repo.onDataChange.mock
      .calls as unknown as [[() => void]];
    heard();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('opens review from the reminder as the ribbon does', () => {
    const { start, receiver } = startReminder(false);

    start.mock.calls[0][0].open();

    expect(receiver.learn).toHaveBeenCalledExactlyOnceWith();
  });

  it('takes the reminder down when the plugin unloads', () => {
    const { reminder, receiver } = startReminder(false);
    expect(receiver.reviewReminder).toBe(reminder);
    expect(reminder.dispose).not.toHaveBeenCalled();

    for (const [cleanup] of receiver.register.mock.calls as unknown as [
      () => void,
    ][]) {
      cleanup();
    }

    expect(reminder.dispose).toHaveBeenCalledOnce();
  });

  it('shows no reminder on mobile, which has no status bar', () => {
    const { start, receiver } = startReminder(true);

    expect(start).not.toHaveBeenCalled();
    expect(receiver.addStatusBarItem).not.toHaveBeenCalled();
  });

  it('checks the reminder again when the database is swapped in from disk', async () => {
    const refresh = vi.fn();
    const { reload } = await startDatabase(undefined, {
      reviewReminder: { refresh },
    });
    expect(refresh).not.toHaveBeenCalled();

    await reload();

    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe('IncrementalReadingPlugin database file events', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['modify', 'create'])(
    'hands the database a file the vault reports as %s',
    async (event) => {
      const { fireVault, handleFileChange } = await startDatabase(undefined);
      const file = { path: 'any/path.sqlite' };

      fireVault(event, file);

      expect(handleFileChange).toHaveBeenCalledWith(file);
    }
  );
});

describe('IncrementalReadingPlugin database startup and Sync', () => {
  beforeEach(() => {
    // `holdForSync` keeps its timers on `window`, which the node environment
    // lacks
    vi.stubGlobal('window', globalThis);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * Start the database as {@link startDatabase} does, over `app`, with
   * `whileStarting` run as the repository starts.
   */
  function startWith(
    app: ReturnType<typeof appWithSync>,
    whileStarting?: (unload: () => void) => void
  ) {
    let hold: SyncHold | undefined;
    let signal: AbortSignal | undefined;
    const unloaders: (() => void)[] = [];
    const unload = () => unloaders.forEach((run) => run());
    const dispose = vi.fn();
    vi.spyOn(SQLJSRepository, 'start').mockImplementation((params) => {
      hold = params.holdForSync;
      signal = params.signal;
      whileStarting?.(unload);
      return Promise.resolve({
        onDataChange: vi.fn(() => () => {}),
        handleFileChange: vi.fn(),
        dispose,
      } as unknown as SQLJSRepository);
    });
    const receiver = {
      app,
      register: vi.fn((run: () => void) => unloaders.push(run)),
      registerEvent: vi.fn(),
      followMovedNotes: vi.fn(),
      createLeftoverWatch: vi.fn(),
    };
    const started = (
      IncrementalReadingPlugin.prototype as unknown as {
        initReviewManager(): Promise<void>;
      }
    ).initReviewManager.call(receiver) as Promise<void>;
    return {
      started,
      hold: () => hold!,
      signal: () => signal!,
      unload,
      receiver,
      dispose,
    };
  }

  it('gives the database a signal that aborts once the plugin unloads', async () => {
    const { started, signal, unload } = startWith(appWithSync(null));
    await started;
    expect(signal().aborted).toBe(false);

    unload();

    expect(signal().aborted).toBe(true);
  });

  it('gives up, disposing of the database and registering nothing, when the plugin unloads as the database starts', async () => {
    const { started, receiver, dispose } = startWith(
      appWithSync(null),
      (unload) => unload()
    );

    await expect(started).rejects.toBeInstanceOf(StartupCancelledError);
    expect(dispose).toHaveBeenCalledOnce();
    expect(receiver.registerEvent).not.toHaveBeenCalled();
  });

  it("holds the database's startup on this vault's Sync", async () => {
    const notify = vi.spyOn(Obsidian, 'notify');
    const app = appWithSync(fakeSync({ pause: true, status: 'paused' }));
    const { started, hold } = startWith(app);
    await started;

    await expect(hold()('migrate')).resolves.toBe('at-once');

    expect(app.internalPlugins.getEnabledPluginById).toHaveBeenCalledWith(
      'sync'
    );
    expect(notify).toHaveBeenCalledWith(
      SYNC_HOLD_MESSAGES.paused.migrate,
      undefined
    );
  });

  it('stops holding, and says not to go ahead, once the plugin unloads', async () => {
    const app = appWithSync(fakeSync({ ready: false }));
    const { started, hold, unload } = startWith(app);
    await started;

    const held = hold()('migrate');
    unload();

    await expect(held).resolves.toBe('cancelled');
  });

  it('goes ahead without waiting when Sync is off', async () => {
    const notify = vi.spyOn(Obsidian, 'notify');
    const { started, hold } = startWith(appWithSync(null));
    await started;

    await expect(hold()('migrate')).resolves.toBe('at-once');
    expect(notify).not.toHaveBeenCalled();
  });

  describe('waiting out Sync', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it.each([
      [3000, 3000],
      ['3000', SYNC_WAIT_TIMEOUT_MS],
      [undefined, SYNC_WAIT_TIMEOUT_MS],
    ])(
      'waits for Sync as long as an e2e test set (%s), or 60 s',
      async (testTimeout, waitsMs) => {
        vi.spyOn(Obsidian, 'notify').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.stubGlobal('window', {
          ...globalThis,
          setTimeout: globalThis.setTimeout,
          clearTimeout: globalThis.clearTimeout,
          setInterval: globalThis.setInterval,
          clearInterval: globalThis.clearInterval,
          __irSyncWaitTimeoutMs: testTimeout,
        });
        const { started, hold } = startWith(
          appWithSync(fakeSync({ ready: false }))
        );
        await started;
        const settled = vi.fn();

        void hold()('migrate').then(settled);
        await vi.advanceTimersByTimeAsync(waitsMs - 1);
        expect(settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        expect(settled).toHaveBeenCalledWith('waited');
      }
    );
  });
});

describe('the notice for review opened before the database is up', () => {
  it('says the plugin is still starting', () => {
    expect(STILL_STARTING_NOTICE).toBe(
      'Incremental reading: still starting. Try again in a moment.'
    );
  });
});

describe('IncrementalReadingPlugin.verifySyncSettings', () => {
  beforeEach(() => {
    vi.stubGlobal('window', globalThis);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Run the check with `app`, its unload hooks going into `unloaders`. */
  function verify(
    app: ReturnType<typeof appWithSync>,
    unloaders: (() => void)[] = []
  ) {
    return (
      IncrementalReadingPlugin.prototype as unknown as {
        verifySyncSettings(): Promise<void>;
      }
    ).verifySyncSettings.call({
      app,
      register: (run: () => void) => unloaders.push(run),
    }) as Promise<void>;
  }

  it('asks to remove the excluded folder when one keeps the database out', async () => {
    const notify = vi.spyOn(Obsidian, 'notify');

    await verify(
      appWithSync(
        fakeSync({
          allowed: false,
          ignoreFolders: ['notes', DATA_DIRECTORY],
          allowTypes: ['unsupported'],
        })
      )
    );

    expect(notify).toHaveBeenCalledExactlyOnceWith(
      syncExclusionMessage({ cause: 'folder', folder: DATA_DIRECTORY }),
      { persist: true }
    );
  });

  it('asks for "Sync all other types" when that keeps the database out', async () => {
    const notify = vi.spyOn(Obsidian, 'notify');

    await verify(
      appWithSync(fakeSync({ allowed: false, allowTypes: ['image', 'pdf'] }))
    );

    expect(notify).toHaveBeenCalledExactlyOnceWith(
      syncExclusionMessage({ cause: 'type' }),
      { persist: true }
    );
  });

  it('asks for both when both keep the database out', async () => {
    const notify = vi.spyOn(Obsidian, 'notify');

    await verify(
      appWithSync(
        fakeSync({
          allowed: false,
          ignoreFolders: [DATA_DIRECTORY],
          allowTypes: ['image', 'pdf'],
        })
      )
    );

    expect(notify.mock.calls).toEqual([
      [
        syncExclusionMessage({ cause: 'folder', folder: DATA_DIRECTORY }),
        { persist: true },
      ],
      [syncExclusionMessage({ cause: 'type' }), { persist: true }],
    ]);
  });

  it.each([
    [
      'Sync syncs the database',
      fakeSync({ ignoreFolders: ['notes'], allowTypes: ['unsupported'] }),
    ],
    [
      'Sync is not set up',
      fakeSync({ status: 'disconnected', allowed: false, allowTypes: [] }),
    ],
    ['Sync is off', null],
  ])('says nothing when %s', async (_case, sync) => {
    const notify = vi.spyOn(Obsidian, 'notify');

    await verify(appWithSync(sync));

    expect(notify).not.toHaveBeenCalled();
  });

  describe('while Sync is starting', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('stops waiting for Sync, saying nothing, once the plugin unloads', async () => {
      const notify = vi.spyOn(Obsidian, 'notify');
      const unloaders: (() => void)[] = [];
      const settled = vi.fn();
      const app = appWithSync(
        fakeSync({ status: 'uninitialized', allowTypes: [] })
      );
      void verify(app, unloaders).then(settled);
      await vi.advanceTimersByTimeAsync(1000);
      expect(settled).not.toHaveBeenCalled();

      unloaders.forEach((run) => run());
      await vi.advanceTimersByTimeAsync(0);

      expect(settled).toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });
  });
});

describe('startupFailureMessage', () => {
  it('property: says a database file that would not load was left as it was', () => {
    fc.assert(
      fc.property(fc.string(), (path) => {
        expect(startupFailureMessage(new DatabaseLoadError(path))).toBe(
          `Incremental reading: the database file ${path} could not be ` +
            'loaded, so the plugin did not start. The file was left ' +
            'unchanged. See the console for details.'
        );
      })
    );
  });

  it.each([new Error('boom'), 'not an error', undefined])(
    'falls back to a general message for %s',
    (error) => {
      expect(startupFailureMessage(error)).toBe(
        'Failed to initialize plugin. See the console for details.'
      );
    }
  );
});

describe('IncrementalReadingPlugin unload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('disposes the database repository', () => {
    const dispose = vi.fn();
    const receiver = { reviewManager: { repo: { dispose } } };

    IncrementalReadingPlugin.prototype.onunload.call(
      receiver as unknown as IncrementalReadingPlugin
    );

    expect(dispose).toHaveBeenCalledOnce();
  });

  it('shows every success again once unloaded, whatever its levels said', () => {
    const receiver = {
      reviewManager: undefined,
      settings: {
        successNoticesInReview: 'none' as const,
        successNoticesOutsideReview: 'none' as const,
      },
      getActiveReviewView: () => null,
    };
    configureSuccessNotices(receiver);
    Notice.reset();

    IncrementalReadingPlugin.prototype.onunload.call(
      receiver as unknown as IncrementalReadingPlugin
    );
    notify('done', { kind: 'success' });

    expect(Notice.messages).toEqual(['done']);
  });

  it('unloads when the database never started', () => {
    const receiver = { reviewManager: undefined };

    expect(() => {
      IncrementalReadingPlugin.prototype.onunload.call(
        receiver as unknown as IncrementalReadingPlugin
      );
    }).not.toThrow();
  });
});

describe('IncrementalReadingPlugin as the success notice source', () => {
  afterEach(() => {
    configureSuccessNotices(null);
    vi.restoreAllMocks();
  });

  it('counts a success as raised inside review only while the review tab is the active view', () => {
    const views = {
      review: Object.create(ReviewView.prototype) as object,
      note: Object.create(MarkdownView.prototype) as object,
      none: null,
    };
    fc.assert(
      fc.property(
        fc.constantFrom(...(Object.keys(views) as (keyof typeof views)[])),
        (where) => {
          Notice.reset();
          const active = views[where];
          const receiver = {
            settings: {
              successNoticesInReview: 'none' as const,
              successNoticesOutsideReview: 'all' as const,
            },
            app: {
              workspace: {
                // Obsidian's lookup: the active view, if it is one of `type`
                getActiveViewOfType: (type: abstract new () => unknown) =>
                  active instanceof type ? active : null,
              },
            },
            getActiveReviewView(): object | null {
              // `.call` answers `any` without `strictBindCallApply`
              return IncrementalReadingPlugin.prototype.getActiveReviewView.call(
                this as unknown as IncrementalReadingPlugin
              ) as ReviewView | null;
            },
          };
          configureSuccessNotices(receiver);

          notify('done', { kind: 'success' });

          expect(Notice.messages).toEqual(where === 'review' ? [] : ['done']);
        }
      )
    );
  });
});

describe('IncrementalReadingPlugin.createLeftoverWatch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Build the watch on a bare receiver whose workspace holds `leaves`. */
  function createWatch(leaves: { view: unknown }[] = []) {
    const getLeavesOfType = vi.fn(() => leaves);
    const receiver = {
      app: { workspace: { getLeavesOfType } },
      reviewManager: { articles: {}, snippets: {}, cards: {} },
    };
    const repo = { query: vi.fn() };
    const watch = (
      IncrementalReadingPlugin.prototype as unknown as {
        createLeftoverWatch(repo: unknown): LeftoverWatch;
      }
    ).createLeftoverWatch.call(receiver, repo) as LeftoverWatch;
    return { watch, receiver, repo, getLeavesOfType };
  }

  it('is built over the database once it is up, before startup looks for moved notes', async () => {
    const watch = { startupScan: vi.fn() };
    const createLeftoverWatch = vi.fn(() => watch);
    let watchAtScan: unknown;
    const followMovedNotes = vi.fn(function (
      this: { leftovers?: unknown },
      _repo: unknown
    ) {
      watchAtScan = this.leftovers;
    });

    const { handleFileChange } = await startDatabase(undefined, {
      createLeftoverWatch,
      followMovedNotes,
    });

    // The database started, known by the stub's own file handler
    const [repo] = followMovedNotes.mock.calls[0];
    expect(repo).toHaveProperty('handleFileChange', handleFileChange);
    expect(createLeftoverWatch).toHaveBeenCalledExactlyOnceWith(repo);
    expect(watchAtScan).toBe(watch);
  });

  it('watches the vault and database it is given, with the review manager, and refreshes the queue once a leftover is resolved', async () => {
    const { watch, receiver, repo } = createWatch();
    const invalidate = vi
      .spyOn(queryClient, 'invalidateQueries')
      .mockResolvedValue(undefined);

    expect(watch).toBeInstanceOf(LeftoverWatch);
    expect(watch.deps).toMatchObject({ app: receiver.app, repo });
    expect(watch.deps.managers()).toBe(receiver.reviewManager);
    await watch.deps.onResolved();
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ['queue'] });
  });

  it.each([
    { tabs: [], open: false },
    // A tab restored in the background, not yet shown: Obsidian defers its view
    { tabs: ['deferred'], open: false },
    { tabs: ['loaded'], open: true },
    { tabs: ['deferred', 'loaded'], open: true },
  ] as const)(
    'counts review as open with review tabs $tabs: $open',
    ({ tabs, open }) => {
      const leaves = tabs.map((tab) => ({
        view:
          tab === 'loaded'
            ? (Object.create(ReviewView.prototype) as ReviewView)
            : {},
      }));
      const { watch, getLeavesOfType } = createWatch(leaves);

      expect(watch.deps.isReviewOpen()).toBe(open);
      expect(getLeavesOfType).toHaveBeenCalledWith(ReviewView.viewType);
    }
  );
});
