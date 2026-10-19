// @vitest-environment jsdom

import * as ReviewInterface from '#/components/ReviewInterface';
import {
  CONTROL_TITLE_CHARS,
  FORBIDDEN_TITLE_CHARS,
  PLUGIN_ICON,
} from '#/lib/constants';
import type ReviewManager from '#/lib/items/ReviewManager';
import type { ExtractedMarkdownEditor } from '#/lib/obsidian-editor';
import type { PdfViewer } from '#/lib/pdf/obsidian-pdf';
import {
  goToReviewPlace,
  isDestination,
  placeOf,
  placeToEphemeralState,
  readPlace,
  REVIEW_PLACE_KEY,
  samePlace,
  type ReviewPlace,
} from '#/lib/review-history';
import type { IRPluginSettings, ReviewTitleBar } from '#/lib/settings';
import {
  resetCurrentItem,
  resetSession,
  setCurrentItemId,
  setPage,
  setSelectionMode,
  setShowAnswer,
  store,
  type ReviewPage,
  type SelectionKind,
} from '#/lib/store';
import { NOTE_TYPES, type NoteType, type ReviewItem } from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
// The mock is what `obsidian` resolves to at runtime (see vitest.config.ts), so
// importing it by path is the same module — but with the stub's own surface
// visible to TypeScript, which is where the recorded menu contents live.
import {
  FileView,
  Menu,
  Notice,
  Platform,
  Scope,
  type MenuItem,
} from '#/test/__mocks__/obsidian';
import ReviewView, {
  HEADER_HIDDEN_CLASS,
  HEADER_SHOWN_CLASS,
  NON_TEXT_ITEM_CLASS,
  REVIEW_VIEW_DEFAULT_TITLE,
} from '#/views/ReviewView';
import fc from 'fast-check';
import {
  WorkspaceWindow,
  type OpenViewState,
  type TFile,
  type WorkspaceLeaf,
} from 'obsidian';
import type { WorkspaceLeafHistoryState } from 'obsidian-typings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #region HELPERS

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
 * `showSearch` reads only `activeEditor`, so it can be exercised against a bare
 * receiver. Constructing a real ReviewView is not possible under the obsidian
 * mock, whose `FileView` is an empty class with no `register`.
 */
function callShowSearch(
  activeEditor: unknown,
  ...args: [replace?: boolean]
): void {
  ReviewView.prototype.showSearch.call(
    { activeEditor } as unknown as ReviewView,
    ...args
  );
}

function makeActiveEditor() {
  return { showSearch: vi.fn() };
}

/** Bare receiver for `setActiveEditor`, which touches only these two slots. */
function makeSetActiveEditorReceiver() {
  const receiver = {
    activeEditor: null as unknown,
    app: { workspace: { activeEditor: 'someone else' as unknown } },
  };
  return receiver;
}

function callSetActiveEditor(
  receiver: ReturnType<typeof makeSetActiveEditorReceiver>,
  owner: unknown
): void {
  ReviewView.prototype.setActiveEditor.call(
    receiver as unknown as ReviewView,
    owner as ExtractedMarkdownEditor['owner']
  );
}

/**
 * `refocusWithoutScroll` reads its element from the argument and touches no
 * other slot, so a bare receiver is enough.
 */
function callRefocusWithoutScroll(el: Element | null): void {
  ReviewView.prototype.refocusWithoutScroll.call({} as ReviewView, el);
}

/**
 * A file as the title paths see it: they read `basename` for the name and
 * `extension` for whether it is text. A note unless told otherwise.
 */
function makeFile(basename: string, extension = 'md'): TFile {
  return { basename, extension } as TFile;
}

const pageArb = fc.constantFrom<ReviewPage[]>('home', 'review');
/** Any file the queue can hand the view, plus the no-item case. */
const fileArb = fc.option(
  fc.string().map((name) => makeFile(name)),
  { nil: null }
);

/**
 * Receiver for the title methods, carrying the workspace surfaces they touch.
 * Its prototype is set so `setTitle` reaches `getDisplayText` the way a real
 * instance does; the obsidian mock cannot produce a constructed view that has a
 * `leaf` and a `titleEl`.
 */
function makeTitleReceiver(
  page: ReviewPage,
  file: TFile | null,
  container: object = {}
) {
  const state = { page };
  const receiver = {
    file,
    plugin: { store: { getState: () => state } },
    titleEl: { setText: vi.fn(), setAttribute: vi.fn() },
    // The two halves of the view header FileView keeps in step from `loadFile`:
    // the folder breadcrumb (`titleParentEl`, filled by `renderBreadcrumbs`) and
    // the name (`titleEl`). Stubbed on the receiver because the obsidian mock's
    // `FileView` has neither.
    titleParentEl: { empty: vi.fn() },
    renderBreadcrumbs: vi.fn(),
    // The tab's `.workspace-leaf-content`, which carries the view's state
    // classes for styles.css
    containerEl: document.createElement('div'),
    leaf: { updateHeader: vi.fn(), getContainer: () => container },
    app: { workspace: { updateTitle: vi.fn() } },
    /** Move between the home screen and an item, as the store would. */
    setPage: (next: ReviewPage) => {
      state.page = next;
    },
  };
  Object.setPrototypeOf(receiver, ReviewView.prototype);
  return receiver;
}

/** The receiver already carries ReviewView's prototype, so it answers as one. */
function asView(receiver: ReturnType<typeof makeTitleReceiver>): ReviewView {
  return receiver as unknown as ReviewView;
}

/** Redux-shaped store: subscribers are notified on every dispatch. */
function makeFakeStore(initial: ReviewPage) {
  let page = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => ({ page }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatchPage(next: ReviewPage) {
      page = next;
      listeners.forEach((listener) => listener());
    },
  };
}

/**
 * The slice of `plugin.app` the constructor reaches for: the vault config that
 * seeds {@link ReviewView.sourceMode}. Every construction needs it, so it is
 * shared rather than restated at each one.
 */
function makePluginApp(livePreview = true) {
  return {
    vault: {
      getConfig: (key: string) =>
        key === 'livePreview' ? livePreview : undefined,
    },
  };
}

/**
 * The slice of `plugin.settings` the constructor reads: the title bar choice
 * it marks the tab with. Every construction needs it, like {@link makePluginApp}.
 */
function makePluginSettings(
  reviewTitleBar: ReviewTitleBar = 'obsidian'
): Pick<IRPluginSettings, 'reviewTitleBar'> {
  return { reviewTitleBar };
}

function makeView(
  store: ReturnType<typeof makeFakeStore>,
  livePreview = true,
  settings = makePluginSettings()
): ReviewView {
  return new ReviewView(
    {} as WorkspaceLeaf,
    {
      store,
      settings,
      app: makePluginApp(livePreview),
    } as unknown as IncrementalReadingPlugin,
    {} as ReviewManager
  );
}

/**
 * Receiver for the menu methods, carrying the app surfaces they reach for.
 * Its prototype is set for the same reason {@link makeTitleReceiver} sets one,
 * and with the added effect that `super.onPaneMenu` resolves to the mock's
 * `FileView` — standing in for the tab-level entries Obsidian contributes there.
 */
/**
 * The editor `IREditor` publishes while an item is on screen, seen the way the
 * view sees it: as the controller sitting in `activeEditor`, with the editor
 * itself on its `editMode`. `toggleSource` flips the editor's own flag, which
 * is the half of the switch Obsidian owns.
 */
function makeMountedEditor(sourceMode = false) {
  const editMode = {
    sourceMode,
    toggleSource: vi.fn(() => {
      editMode.sourceMode = !editMode.sourceMode;
    }),
  };
  return { editMode };
}

function makeMenuReceiver({
  page = 'review',
  file = makeFile('Chapter 1'),
  type = 'article',
  editor = null,
  sourceMode = false,
  anyArticle = true,
}: {
  page?: ReviewPage;
  file?: TFile | null;
  /** The type of the item `file` belongs to. */
  type?: NoteType;
  /** The mounted review editor, or `null` for a page that has none. */
  editor?: ReturnType<typeof makeMountedEditor> | null;
  /** The mode the tab is already in, as the constructor would have left it. */
  sourceMode?: boolean;
  /** Whether any live article row is there to un-import. */
  anyArticle?: boolean;
} = {}) {
  const openFile = vi.fn();
  const revealInFolder = vi.fn();
  const openBulkUnimport = vi.fn();
  const leaf = { id: 'review-leaf' };
  const receiver = {
    file,
    fileType: type,
    leaf,
    activeEditor: editor,
    sourceMode,
    plugin: {
      store: { getState: () => ({ page }) },
      reviewManager: {
        hasArticleUnder: (folder: string) => folder === '/' && anyArticle,
      },
      openBulkUnimport,
    },
    app: {
      workspace: {
        trigger: vi.fn(),
        getLeaf: vi.fn(() => ({ openFile })),
      },
      fileManager: {
        promptForFileRename: vi.fn(),
        promptForDeletion: vi.fn(),
      },
      internalPlugins: {
        getEnabledPluginById: vi.fn(() => ({ revealInFolder })),
      },
    },
  };
  Object.setPrototypeOf(receiver, ReviewView.prototype);
  return {
    view: receiver as unknown as ReviewView,
    app: receiver.app,
    leaf,
    file,
    editor,
    openFile,
    revealInFolder,
    openBulkUnimport,
  };
}

/** Build a menu the way Obsidian's header does, and let the view fill it. */
function paneMenu(view: ReviewView, source = 'more-options'): Menu {
  const menu = new Menu();
  view.onPaneMenu(menu as never, source);
  return menu;
}

function itemTitled(menu: Menu, title: string): MenuItem | undefined {
  return menu.items.find((item) => item.title === title);
}

/** Fire an entry's callback the way clicking it would. */
function click(item: MenuItem | undefined): void {
  if (!item) throw new Error('menu entry not present');
  item.callback?.(new MouseEvent('click'));
}

/** The arguments of the one `workspace.trigger` call for `name`. */
function triggered(
  app: ReturnType<typeof makeMenuReceiver>['app'],
  name: string
): unknown[] | undefined {
  return app.workspace.trigger.mock.calls.find(
    (call: unknown[]) => call[0] === name
  );
}

/** The menu `showMoreOptionsMenu` built, taken from the event it fired. */
function shownMenu(app: ReturnType<typeof makeMenuReceiver>['app']): Menu {
  const call = triggered(app, 'leaf-menu');
  if (!call) throw new Error('the menu was never handed to leaf-menu');
  return call[1] as Menu;
}

/**
 * Run one assertion against a chosen platform. `Platform` is a plain object in
 * the mock, so nothing restores it automatically.
 */
function onPlatform(isMobile: boolean, run: () => void): void {
  const previous = Platform.isMobile;
  Platform.isMobile = isMobile;
  try {
    run();
  } finally {
    Platform.isMobile = previous;
  }
}

/** A button with a known box, since jsdom measures every element as zero. */
function makeAnchor(rect: { x: number; bottom: number; width: number }) {
  const button = document.createElement('button');
  button.getBoundingClientRect = () => rect as DOMRect;
  return button;
}

/** Cleanups the view handed to `Component.register`, run on unload. */
function unload(view: ReviewView): void {
  const { registered } = view as unknown as { registered: (() => unknown)[] };
  registered.forEach((cleanup) => cleanup());
}

/**
 * `isOnlyReviewTab` reads only the workspace's leaves of its own type and the
 * leaf it is mounted in, so a bare receiver is enough.
 */
function callIsOnlyReviewTab(openLeaves: WorkspaceLeaf[], leaf: WorkspaceLeaf) {
  const getLeavesOfType = vi.fn((_type: string): WorkspaceLeaf[] => openLeaves);
  const result = ReviewView.prototype.isOnlyReviewTab.call({
    app: { workspace: { getLeavesOfType } },
    leaf,
  } as unknown as ReviewView) as boolean;
  return { result, getLeavesOfType };
}

const makeLeaf = () => ({}) as WorkspaceLeaf;

/**
 * Receiver for `resumeUnclaimedSession`, which reaches the plugin's resume, the
 * home-screen setting, the count of open review tabs, and the real store. The
 * store is the module's own, so the page it lands on is read back from there.
 */
function makeResumeReceiver({
  resumed = true,
  initialItem = null,
  skipHomeScreen = false,
  onlyTab = true,
}: {
  resumed?: boolean;
  initialItem?: unknown;
  skipHomeScreen?: boolean;
  onlyTab?: boolean;
} = {}) {
  const resumeSession = vi.fn((): Promise<boolean> => Promise.resolve(resumed));
  const isOnlyReviewTab = vi.fn(() => onlyTab);
  const receiver = {
    initialItem,
    isOnlyReviewTab,
    plugin: { resumeSession, store, settings: { skipHomeScreen } },
  };
  return { receiver, resumeSession, isOnlyReviewTab };
}

function callResumeUnclaimedSession(
  receiver: ReturnType<typeof makeResumeReceiver>['receiver']
): Promise<void> {
  return ReviewView.prototype.resumeUnclaimedSession.call(
    receiver as unknown as ReviewView
  ) as Promise<void>;
}

/** Any item id the store can hold, the empty string included. */
const itemIdArb = fc.string();
/** Every place review can be on, between items included. */
const placeArb: fc.Arbitrary<ReviewPlace> = fc.oneof(
  fc.constant<ReviewPlace>({ page: 'home', itemId: null }),
  fc.record<ReviewPlace>({
    page: fc.constant('review'),
    itemId: fc.option(itemIdArb, { nil: null }),
  })
);
/** The places a history entry can be written for. */
const destinationArb: fc.Arbitrary<ReviewPlace> = fc.oneof(
  fc.constant<ReviewPlace>({ page: 'home', itemId: null }),
  fc.record<ReviewPlace>({ page: fc.constant('review'), itemId: itemIdArb })
);
/** Everything the store's page and item can be, without the normalising. */
const storeStateArb = fc.record({
  page: pageArb,
  currentItemId: fc.option(itemIdArb, { nil: null }),
});

/**
 * Put the real store on `place` in a single place change: the item first, which
 * changes no place while the home screen is up, then the page. The home screen
 * keeps whatever item the store holds, as the home button does.
 */
function moveStore(place: ReviewPlace): void {
  if (place.page === 'review' || place.itemId !== null) {
    store.dispatch(setCurrentItemId(place.itemId));
  }
  store.dispatch(setPage(place.page));
}

/**
 * A leaf with the surface review's history reaches for. `recordHistory` pushes
 * the entry it is given, as Obsidian's does for one that is not a repeat of the
 * top entry; `getViewState` answers with a title from the store, as Obsidian's
 * reads `getDisplayText` — which by the time an entry is written already names
 * the next place.
 */
function makeHistoryLeaf() {
  const listeners: Record<string, (() => void)[]> = {};
  const history = {
    backHistory: [] as WorkspaceLeafHistoryState[],
    forwardHistory: [] as WorkspaceLeafHistoryState[],
  };
  return {
    history,
    /** Obsidian's own, which loads a file into the leaf in place of review. */
    openFile: vi.fn(
      async (_file: TFile, _openState?: OpenViewState): Promise<void> => {}
    ),
    recordHistory: vi.fn((entry: WorkspaceLeafHistoryState) => {
      history.backHistory.push(entry);
    }),
    getViewState: vi.fn(() => ({
      type: ReviewView.viewType,
      state: { file: 'Articles/Chapter 1.md' },
      icon: PLUGIN_ICON,
      title: 'Title for the place already arrived at',
    })),
    on: (name: string, callback: () => void) => {
      (listeners[name] ??= []).push(callback);
      return { name, callback };
    },
    trigger: vi.fn((name: string) => {
      listeners[name]?.forEach((callback) => callback());
    }),
  };
}

/**
 * Construct a view over the real store and run its `onOpen`, which is what
 * starts it recording. The interface is not rendered: nothing here reads it,
 * and mounting it would fetch.
 *
 * Unload the view when done, or its store subscription outlives the test and
 * records into a leaf nobody reads.
 */
async function openHistoryView({
  file = null,
  initialItem = null,
  resume = async () => {},
  mobileNavbar = { onLeafChange: vi.fn() },
  itemExists = true,
  items = new Map(),
  leftovers,
}: {
  /** The plugin's watch over notes left without review data, if it has one. */
  leftovers?: { reviewOpened: () => void };
  file?: TFile | null;
  /** The item the tab was asked to open on, as `learn` hands it one. */
  initialItem?: ReviewItem | null;
  /** Stands in for the page and item a mounting tab settles on. */
  resume?: () => Promise<void>;
  mobileNavbar?: { onLeafChange: () => void } | null;
  itemExists?: boolean;
  /** The item each note is the file of, for the database to answer with. */
  items?: Map<TFile, ReviewItem>;
} = {}) {
  vi.spyOn(ReviewInterface, 'createReviewInterface').mockReturnValue(
    null as never
  );
  // Page changes retitle the tab, which reaches header elements the obsidian
  // mock's FileView does not have. The title paths have tests of their own.
  vi.spyOn(ReviewView.prototype, 'setTitle').mockImplementation(() => {});
  const resumeUnclaimedSession = vi
    .spyOn(ReviewView.prototype, 'resumeUnclaimedSession')
    .mockImplementation(resume);
  const leaf = makeHistoryLeaf();
  const reviewManager = {
    getItemOrMissingFromId: vi.fn(async (id: string) => {
      for (const item of items.values()) {
        if (item.data.id === id) return item;
      }
      return itemExists ? { data: { id } } : null;
    }),
    getReviewItemFromFile: vi.fn(
      async (note: TFile): Promise<ReviewItem | null> => items.get(note) ?? null
    ),
    liveItemIdAt: vi.fn(async (reference: string): Promise<string | null> => {
      for (const [note, item] of items) {
        if (note.path === reference) return item.data.id;
      }
      return null;
    }),
  };
  const sessionTracker = { commit: vi.fn() };
  const view = new ReviewView(
    leaf as unknown as WorkspaceLeaf,
    {
      store,
      sessionTracker,
      settings: makePluginSettings(),
      app: makePluginApp(),
      leftovers,
    } as unknown as IncrementalReadingPlugin,
    reviewManager as unknown as ReviewManager
  );
  Object.assign(view, {
    leaf,
    file,
    initialItem,
    contentEl: document.createElement('div'),
    titleEl: document.createElement('div'),
    app: {
      isMobile: true,
      mobileNavbar,
      workspace: {
        on: () => ({}),
        getLeavesOfType: () => [leaf],
        setActiveLeaf: vi.fn(),
      },
    },
  });
  // Taken before `onOpen`, which may put a wrapper of its own in its place
  const obsidianOpenFile = leaf.openFile;
  await view.onOpen();
  resumeUnclaimedSession.mockRestore();
  return {
    view,
    leaf,
    reviewManager,
    sessionTracker,
    mobileNavbar,
    obsidianOpenFile,
  };
}

/** The places a leaf's back stack holds, oldest first. */
function backPlaces(leaf: ReturnType<typeof makeHistoryLeaf>) {
  return leaf.history.backHistory.map((entry) => readPlace(entry.eState));
}

/** Let a lookup `leaveIfGone` started settle. */
const flushLookups = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * An item's note, with the folder its rename has to stay in. `parentPath` of
 * `null` is a file with no parent at all; `'/'` is one at the vault root.
 */
function makeItemFile(basename: string, parentPath: string | null): TFile {
  return {
    basename,
    extension: 'md',
    parent: parentPath === null ? null : { path: parentPath },
  } as TFile;
}

/** Where renaming `file` to `name` should put it: the same folder, new name. */
function renamedPath(file: TFile, name: string): string {
  const folder = file.parent?.path;
  return folder && folder !== '/' ? `${folder}/${name}.md` : `${name}.md`;
}

/**
 * A constructed view with a real header title in the document, so focus, blur
 * and keys reach the rename wiring the way they do in the app. Constructed
 * rather than a prototype receiver because the rename holds its file in a
 * private field, which only a constructed instance carries.
 *
 * `setText` is Obsidian's DOM extension, which jsdom lacks.
 */
function makeRenameView({
  page = 'review',
  file = makeItemFile('Chapter 1', 'Articles'),
  type = 'article',
  isMobileApp = false,
  renameFile = vi.fn(async (_file: TFile, _path: string) => {}),
}: {
  page?: ReviewPage;
  file?: TFile | null;
  /** The type of the item `file` belongs to. */
  type?: NoteType;
  isMobileApp?: boolean;
  renameFile?: (file: TFile, path: string) => Promise<void>;
} = {}) {
  const store = makeFakeStore(page);
  const view = makeView(store);
  const titleEl = document.createElement('div');
  titleEl.setText = (text: string | DocumentFragment) => {
    titleEl.textContent = typeof text === 'string' ? text : text.textContent;
  };
  document.body.appendChild(titleEl);
  Object.assign(view, {
    titleEl,
    titleParentEl: { empty: vi.fn() },
    renderBreadcrumbs: vi.fn(),
    leaf: { updateHeader: vi.fn(), getContainer: () => ({}) },
    app: {
      fileManager: { renameFile },
      workspace: { updateTitle: vi.fn() },
    },
  });
  const previous = Platform.isMobileApp;
  Platform.isMobileApp = isMobileApp;
  try {
    view.setFile(file, file && type);
    view.wireTitleRename();
  } finally {
    Platform.isMobileApp = previous;
  }
  return { view, store, titleEl, renameFile };
}

/**
 * Give a {@link makeRenameView} view a real breadcrumb element, drawn the way
 * Obsidian's `FileView.renderBreadcrumbs` draws it: one segment per folder of
 * `file.parent.path`, each followed by a `/`, nothing for the vault root.
 * `empty` is Obsidian's DOM extension, which jsdom lacks.
 *
 * @returns the breadcrumb element, whose text is what the header shows
 */
function drawBreadcrumbs(view: ReviewView): HTMLElement {
  const titleParentEl = document.createElement('div');
  titleParentEl.empty = () => titleParentEl.replaceChildren();
  Object.assign(view, {
    titleParentEl,
    renderBreadcrumbs(this: ReviewView) {
      this.titleParentEl.empty();
      const folder = this.file?.parent?.path;
      if (!folder || folder === '/') return;
      for (const segment of folder.split('/')) {
        titleParentEl.append(segment, '/');
      }
    },
  });
  return titleParentEl;
}

/**
 * The breadcrumb {@link drawBreadcrumbs} shows over `file` as review's article
 * or snippet: none for a file with an empty basename, which counts as no item.
 */
function breadcrumbsOf(file: TFile): string {
  const folder = file.parent?.path;
  if (file.basename === '' || !folder || folder === '/') return '';
  return `${folder}/`;
}

/**
 * Type `text` over the title and end the edit the way a user would: by leaving
 * the title, or with a key. Waits out the rename the commit starts.
 */
async function editTitle(
  titleEl: HTMLElement,
  text: string,
  end: 'blur' | 'Enter' | 'Tab' | 'Escape' = 'blur'
): Promise<void> {
  titleEl.focus();
  titleEl.textContent = text;
  if (end === 'blur') {
    titleEl.blur();
  } else {
    titleEl.dispatchEvent(
      new KeyboardEvent('keydown', { key: end, cancelable: true })
    );
  }
  await flushLookups();
}

/**
 * A name a note can take: no forbidden, control or invisible character, no leading
 * dot, no trailing dot or space.
 */
function isValidName(name: string): boolean {
  return (
    name.trim() === name &&
    name !== '' &&
    !name.startsWith('.') &&
    !name.endsWith('.') &&
    ![...name].some(
      (char) =>
        FORBIDDEN_TITLE_CHARS.has(char) ||
        CONTROL_TITLE_CHARS.has(char) ||
        /\p{Default_Ignorable_Code_Point}/u.test(char)
    )
  );
}

const validNameArb = fc.string({ minLength: 1 }).filter(isValidName);
/** Whitespace a title can pick up around the name, which the rename ignores. */
const paddingArb = fc.constantFrom('', ' ', '  ', '\t', ' \n');
/** No parent, the vault root, or a folder any number of levels deep. */
const parentPathArb = fc.oneof(
  fc.constant(null),
  fc.constant('/'),
  fc
    .array(
      fc.string({ minLength: 1 }).filter((seg) => !seg.includes('/')),
      {
        minLength: 1,
        maxLength: 3,
      }
    )
    .map((segments) => segments.join('/'))
);
const itemFileArb = fc
  .tuple(fc.string(), parentPathArb)
  .map(([basename, parent]) => makeItemFile(basename, parent));

/**
 * A view over the real store, with the app's keymap scope and the one action
 * selection mode's keys reach for. `hotkey` stands in for the app's hotkey
 * manager, which Obsidian registers on that scope for every key.
 *
 * Unload the view when done, or its store subscription outlives the test.
 */
function makeKeyedView() {
  const hotkey = vi.fn((): unknown => undefined);
  const appScope = new Scope();
  appScope.register(null, null, hotkey);
  const cancelSelection = vi.fn();
  const view = new ReviewView(
    {} as WorkspaceLeaf,
    {
      store,
      settings: makePluginSettings(),
      app: { ...makePluginApp(), scope: appScope },
      actions: { cancelSelection },
    } as unknown as IncrementalReadingPlugin,
    {} as ReviewManager
  );
  return { view, appScope, hotkey, cancelSelection };
}

const MODIFIER_FLAGS = [
  ['Ctrl', 'ctrlKey'],
  ['Meta', 'metaKey'],
  ['Alt', 'altKey'],
  ['Shift', 'shiftKey'],
] as const;

/**
 * Press a key with the review tab as the active leaf, routed as Obsidian's
 * keymap routes it: the workspace's scope hands the key to the active view's
 * `scope` when it has one, and otherwise answers from its parent, the app's.
 * `consumed` is whether the keymap then prevents the key's default and stops
 * it, which it does when the answer is `false`.
 */
function pressKey(
  keyed: ReturnType<typeof makeKeyedView>,
  init: KeyboardEventInit,
  target: EventTarget = document.body
) {
  const evt = new KeyboardEvent('keydown', init);
  Object.defineProperty(evt, 'target', { value: target });
  const modifiers = MODIFIER_FLAGS.filter(([, flag]) => evt[flag])
    .map(([name]) => name)
    .join(',');
  const scope = (keyed.view.scope as Scope | null) ?? keyed.appScope;
  const answer = scope.handleKey(evt, { modifiers, key: evt.key });
  return { consumed: answer === false };
}

/** Elements whose own keys edit text, focused when Escape is pressed. */
const editableTargetArb = fc.constantFrom(
  () => document.createElement('input'),
  () => document.createElement('textarea'),
  () => {
    const title = document.createElement('div');
    title.setAttribute('contenteditable', 'plaintext-only');
    return title;
  },
  () => {
    const title = document.createElement('div');
    title.setAttribute('contenteditable', 'true');
    // Where the key lands is the text inside the editable element.
    return title.appendChild(document.createElement('span'));
  }
);

/**
 * A PDF viewer whose scope answers Escape, as Obsidian's does, parented on
 * `appScope` as Obsidian parents it on the app's.
 */
function makePdfViewer(appScope?: Scope) {
  const scope = new Scope(appScope);
  const escape = vi.fn((): unknown => false);
  scope.register([], 'Escape', escape);
  const viewer = {
    containerEl: document.createElement('div'),
    scope,
    load: vi.fn(),
    unload: vi.fn(),
    open: vi.fn(),
    showSearch: vi.fn(),
    selectedText: vi.fn(() => 'selected in the PDF'),
  };
  return { viewer: viewer as unknown as PdfViewer, escape, raw: viewer };
}

/** What Obsidian hands `openFile` alongside the file, or nothing. */
const openStateArb: fc.Arbitrary<OpenViewState | undefined> = fc.option(
  fc.record(
    {
      active: fc.boolean(),
      eState: fc.option(
        fc.oneof(
          fc.record({ subpath: fc.string() }),
          fc.record({ focus: fc.boolean() })
        ),
        { nil: undefined }
      ),
    },
    { requiredKeys: [] }
  ),
  { nil: undefined }
);

/** Where in a note a link can open it, as Obsidian hands it over. */
const positionalArb = fc.oneof(
  fc.record({ subpath: fc.string() }),
  fc.record({
    match: fc.record({
      content: fc.string(),
      matches: fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 2 }),
    }),
  }),
  fc.record({ subpath: fc.string(), focus: fc.boolean() })
);
/** Ephemeral state that puts the note nowhere in particular. */
const unpositionalArb = fc.option(
  fc.oneof(fc.record({ focus: fc.boolean() }), fc.constant({})),
  { nil: undefined }
);

/** A note in the vault at `path`. */
const noteAt = (path: string) =>
  ({ path, basename: path, extension: 'md' }) as unknown as TFile;

/** The snippet `id`, whose note is `file`. */
const itemOf = (id: string, file: TFile) =>
  ({ data: { id, type: 'snippet' }, file }) as unknown as ReviewItem;

/** The live item `id` whose note is missing from `path`. */
const missingAt = (path: string, id: string) =>
  new Map([
    [
      { path } as unknown as TFile,
      { data: { id, type: 'snippet' } } as unknown as ReviewItem,
    ],
  ]);

/**
 * An open review tab over the snippet `id` at `Snippets/target.md`, and a way
 * to follow a link to it there carrying `eState`.
 */
async function openWithTarget(id: string) {
  const note = noteAt('Snippets/target.md');
  const opened = await openHistoryView({
    items: new Map([[note, itemOf(id, note)]]),
  });
  const follow = (eState: unknown) =>
    (opened.leaf as unknown as WorkspaceLeaf).openFile(note, {
      eState: eState as Record<string, unknown>,
    });
  return { ...opened, note, follow };
}

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ReviewView.resumeUnclaimedSession', () => {
  beforeEach(() => {
    store.dispatch(resetSession());
  });

  it('lands a reopened tab back on the item it was closed on', async () => {
    // Reopening a closed tab, or restoring one with the workspace, mounts the
    // view without going through `learn`: nothing else will put it on the item.
    const { receiver } = makeResumeReceiver({ resumed: true });

    await callResumeUnclaimedSession(receiver);

    expect(store.getState().page).toBe('review');
  });

  it('leaves the tab on the home screen when there is nothing to resume', async () => {
    const { receiver } = makeResumeReceiver({ resumed: false });

    await callResumeUnclaimedSession(receiver);

    expect(store.getState().page).toBe('home');
  });

  it('says nothing about the page for a tab opened on an explicit item', async () => {
    // `learn(item)` puts the item in the store before the view mounts, and the
    // field is set right after; either one is enough to stand back.
    const { receiver, resumeSession } = makeResumeReceiver({
      resumed: true,
      initialItem: { data: { id: 'item-1' } },
    });

    await callResumeUnclaimedSession(receiver);

    expect(resumeSession).not.toHaveBeenCalled();
    expect(store.getState().page).toBe('home');
  });

  it('skips the home screen on a restored tab with nothing to resume', async () => {
    // Obsidian's own reopen, and a tab restored with the workspace, never reach
    // `learn` — so nothing else applies the setting to them.
    const { receiver } = makeResumeReceiver({
      resumed: false,
      skipHomeScreen: true,
    });

    await callResumeUnclaimedSession(receiver);

    expect(store.getState().page).toBe('review');
  });

  it('leaves the page alone while another review tab is open', async () => {
    // The page is one shared store: skipping the home screen here would move
    // the tab that is already up, off whatever it was showing.
    const { receiver } = makeResumeReceiver({
      resumed: false,
      skipHomeScreen: true,
      onlyTab: false,
    });

    await callResumeUnclaimedSession(receiver);

    expect(store.getState().page).toBe('home');
  });

  it('restores the item ahead of the home-screen setting', async () => {
    // Both branches land on review, so the tab count is what tells them apart:
    // a resumed item is not the setting's business and is never held back by it.
    const { receiver, isOnlyReviewTab } = makeResumeReceiver({
      resumed: true,
      skipHomeScreen: true,
      onlyTab: false,
    });

    await callResumeUnclaimedSession(receiver);

    expect(store.getState().page).toBe('review');
    expect(isOnlyReviewTab).not.toHaveBeenCalled();
  });
});

describe('ReviewView.isOnlyReviewTab', () => {
  it('reports the only review tab open as the only one', () => {
    const leaf = makeLeaf();

    expect(callIsOnlyReviewTab([leaf], leaf).result).toBe(true);
  });

  it('reports a split pane as not alone while its twin is open', () => {
    // Closing one half of a split must leave the other on its item: the review
    // session is one shared store, so ending it here empties it for both.
    const leaf = makeLeaf();

    expect(callIsOnlyReviewTab([leaf, makeLeaf()], leaf).result).toBe(false);
  });

  it('still sees the twin once the workspace has dropped the closing leaf', () => {
    // Obsidian may detach before or after calling onClose, and a leaf being
    // mounted has no view to count yet; only the leaves that remain matter.
    expect(callIsOnlyReviewTab([makeLeaf()], makeLeaf()).result).toBe(false);
  });

  it('is alone when the workspace has already dropped it and none remain', () => {
    expect(callIsOnlyReviewTab([], makeLeaf()).result).toBe(true);
  });

  it('counts review tabs, not tabs in general', () => {
    const leaf = makeLeaf();

    const { getLeavesOfType } = callIsOnlyReviewTab([leaf], leaf);

    expect(getLeavesOfType).toHaveBeenCalledWith(ReviewView.viewType);
  });
});

describe('ReviewView.showSearch', () => {
  it("forwards the requested mode to the review view's active editor", () => {
    fc.assert(
      fc.property(fc.boolean(), (replace) => {
        const activeEditor = makeActiveEditor();

        callShowSearch(activeEditor, replace);

        expect(activeEditor.showSearch).toHaveBeenCalledTimes(1);
        expect(activeEditor.showSearch).toHaveBeenCalledWith(replace);
      })
    );
  });

  it('opens plain find, not find-and-replace, when called with no argument', () => {
    // Obsidian's activeLeaf.view fallback calls showSearch(false); a caller
    // omitting the argument must not land in replace mode either.
    const activeEditor = makeActiveEditor();

    callShowSearch(activeEditor);

    expect(activeEditor.showSearch).toHaveBeenCalledWith(false);
  });

  it('does nothing when no editor is mounted', () => {
    // True on the home screen, the queue table, and un-revealed cards, and after
    // IREditor unmounts and clears the reference.
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.constantFrom(null, undefined),
        (replace, absent) => {
          expect(() => callShowSearch(absent, replace)).not.toThrow();
        }
      )
    );
  });

  it('is defined on the prototype so spreading the view does not copy it', () => {
    // getMarkdownController builds its controller with `{...view}`, which copies
    // own enumerable properties. A class-field arrow here would be copied and
    // would shadow the controller's own forwarder, re-creating the no-op bug.
    expect(
      Object.getOwnPropertyDescriptor(ReviewView.prototype, 'showSearch')?.value
    ).toBeTypeOf('function');

    const activeEditor = makeActiveEditor();
    const view = { activeEditor } as unknown as ReviewView;
    expect(Object.prototype.hasOwnProperty.call(view, 'showSearch')).toBe(
      false
    );
    expect({ ...view }).not.toHaveProperty('showSearch');
  });

  it('satisfies the duck-type check Obsidian uses to enable the search command', () => {
    // editor:open-search does: `var t = e.showSearch; return t && typeof t == "function"`
    // against activeLeaf.view, so an actual instance must answer through its
    // prototype chain. Object.create stands in for a constructed view, which the
    // obsidian mock cannot produce.
    const view = Object.create(ReviewView.prototype) as ReviewView;
    // Reading the method off the instance unbound is precisely what Obsidian does,
    // so the lint rule's concern is the behaviour under test.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const candidate = (view as unknown as ExtractedMarkdownEditor).showSearch;

    expect(candidate && typeof candidate === 'function').toBe(true);
  });
});

describe('ReviewView.setActiveEditor', () => {
  it('publishes the editor to the workspace so search resolves before any click', () => {
    // The bug this fixes: publishing only from CodeMirror's focus handler left
    // workspace.activeEditor null at the start of a review, so editor:open-search
    // found nothing and dropped out of the command palette entirely.
    const owner = makeActiveEditor();
    const receiver = makeSetActiveEditorReceiver();

    callSetActiveEditor(receiver, owner);

    expect(receiver.activeEditor).toBe(owner);
    expect(receiver.app.workspace.activeEditor).toBe(owner);
  });

  it('keeps the view and the workspace pointing at the same editor', () => {
    fc.assert(
      fc.property(fc.integer(), (id) => {
        const owner = { showSearch: vi.fn(), id };
        const receiver = makeSetActiveEditorReceiver();

        callSetActiveEditor(receiver, owner);

        expect(receiver.activeEditor).toBe(receiver.app.workspace.activeEditor);
      })
    );
  });

  it('releases the workspace slot when handed no editor', () => {
    // Reactivating the tab with no editor mounted must not leave a previous
    // owner installed as the workspace's active editor.
    const receiver = makeSetActiveEditorReceiver();

    callSetActiveEditor(receiver, null);

    expect(receiver.activeEditor).toBeNull();
    expect(receiver.app.workspace.activeEditor).toBeNull();
  });

  it('feeds showSearch, so a freshly published editor is searchable', () => {
    fc.assert(
      fc.property(fc.boolean(), (replace) => {
        const owner = makeActiveEditor();
        const receiver = makeSetActiveEditorReceiver();

        callSetActiveEditor(receiver, owner);
        ReviewView.prototype.showSearch.call(
          receiver as unknown as ReviewView,
          replace
        );

        expect(owner.showSearch).toHaveBeenCalledWith(replace);
      })
    );
  });
});

describe('ReviewView.refocusWithoutScroll', () => {
  it('refocuses the element without scrolling it into view', () => {
    // The whole point of the fix: focus() defaults to scrolling the element into
    // view, which pulls the editor to the top on every tab reactivation.
    const el = document.createElement('button');
    document.body.appendChild(el);
    const focusSpy = vi.spyOn(el, 'focus');

    callRefocusWithoutScroll(el);

    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });

    el.remove();
  });

  it('does nothing when there is no last-focused element (null)', () => {
    expect(() => callRefocusWithoutScroll(null)).not.toThrow();
  });

  it('does nothing for a non-HTMLElement (e.g. an SVG element)', () => {
    // #lastFocusedEl is typed Element; only HTMLElement has focus() with options.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    // jsdom SVGElement lacks a focus method; the guard must skip it, not throw.
    expect(() => callRefocusWithoutScroll(svg)).not.toThrow();
  });
});

describe('ReviewView.currentItemName', () => {
  it('names the item on the review page and nothing on the home screen', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (basename) => {
        const receiver = makeTitleReceiver('review', makeFile(basename));
        expect(asView(receiver).currentItemName()).toBe(basename);

        receiver.setPage('home');

        expect(asView(receiver).currentItemName()).toBeNull();
      })
    );
  });

  it('reports no item when the queue has handed over none', () => {
    fc.assert(
      fc.property(fc.constantFrom(null, makeFile('')), (file) => {
        const view = asView(makeTitleReceiver('review', file));

        expect(view.currentItemName()).toBeNull();
      })
    );
  });

  it('separates an item named after the plugin from having no item at all', () => {
    // getDisplayText answers the same string in both cases, so a caller that
    // needs to know whether an item is showing — renderTitleParent — cannot
    // infer it from the title, and must ask here instead.
    const withItem = makeTitleReceiver(
      'review',
      makeFile(REVIEW_VIEW_DEFAULT_TITLE)
    );
    const withoutItem = makeTitleReceiver('home', null);

    expect(asView(withItem).getDisplayText()).toBe(
      asView(withoutItem).getDisplayText()
    );
    expect(asView(withItem).currentItemName()).toBe(REVIEW_VIEW_DEFAULT_TITLE);
    expect(asView(withoutItem).currentItemName()).toBeNull();
  });
});

describe('ReviewView.getDisplayText', () => {
  // Obsidian derives the tab header, the OS window title, the mobile tab
  // switcher labels and the saved layout from this one method.
  it('titles the tab after the item being reviewed', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (basename) => {
        const view = asView(makeTitleReceiver('review', makeFile(basename)));

        expect(view.getDisplayText()).toBe(basename);
      })
    );
  });

  it('never shows an item name while the home screen is up', () => {
    // The reported bug. `file` legitimately stays pointed at the last item on
    // the home screen, so only the page can decide the title — and the desktop
    // taskbar and the iOS tab switcher both read it.
    fc.assert(
      fc.property(fileArb, (file) => {
        const view = asView(makeTitleReceiver('home', file));

        expect(view.getDisplayText()).toBe(REVIEW_VIEW_DEFAULT_TITLE);
      })
    );
  });

  it('falls back to the plugin name when no item is loaded', () => {
    fc.assert(
      fc.property(pageArb, (page) => {
        const view = asView(makeTitleReceiver(page, null));

        expect(view.getDisplayText()).toBe(REVIEW_VIEW_DEFAULT_TITLE);
      })
    );
  });

  it('falls back to the plugin name instead of blanking the tab for an empty basename', () => {
    fc.assert(
      fc.property(pageArb, (page) => {
        const view = asView(makeTitleReceiver(page, makeFile('')));

        expect(view.getDisplayText()).toBe(REVIEW_VIEW_DEFAULT_TITLE);
      })
    );
  });

  it('hides a card behind the plugin name, on every page', () => {
    // A card note's basename is the start of its text, so naming the tab after
    // it shows the question, or the answer, before the card is read.
    fc.assert(
      fc.property(pageArb, fc.string(), (page, basename) => {
        const view = asView(makeTitleReceiver(page, null));

        view.setFile(makeFile(basename), 'card');

        expect(view.getDisplayText()).toBe(REVIEW_VIEW_DEFAULT_TITLE);
      })
    );
  });

  it('titles the tab after an article or a snippet as before', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<NoteType[]>('article', 'snippet'),
        fc.string({ minLength: 1 }),
        (type, basename) => {
          const view = asView(makeTitleReceiver('review', null));

          view.setFile(makeFile(basename), type);

          expect(view.getDisplayText()).toBe(basename);
        }
      )
    );
  });

  it('re-reads the page on every call rather than trusting a cached copy', () => {
    // Obsidian calls this from paths the store subscription does not drive
    // (updateHeader, getViewState, tab tooltips), so a stale page here would
    // resurrect the bug on whichever surface asked first.
    const receiver = makeTitleReceiver('review', makeFile('Chunking'));
    expect(asView(receiver).getDisplayText()).toBe('Chunking');

    receiver.setPage('home');

    expect(asView(receiver).getDisplayText()).toBe(REVIEW_VIEW_DEFAULT_TITLE);
  });
});

describe('ReviewView.renderTitleParent', () => {
  it('redraws the folder breadcrumb for the item being reviewed', () => {
    // FileView draws the breadcrumb only from loadFile, which setFile bypasses,
    // so nothing repointed it after startup: the header named each new item in
    // turn while still showing the folder of whichever item the saved workspace
    // layout restored — an article under sources/ shown beneath cards/.
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (basename) => {
        const receiver = makeTitleReceiver('review', makeFile(basename));

        asView(receiver).renderTitleParent();

        expect(receiver.renderBreadcrumbs).toHaveBeenCalledTimes(1);
        expect(receiver.titleParentEl.empty).not.toHaveBeenCalled();
      })
    );
  });

  it('clears the breadcrumb on the home screen, which names no item', () => {
    // `file` stays pointed at the last item here, so rendering it would put a
    // folder path next to a title that is deliberately not about that item.
    fc.assert(
      fc.property(fileArb, (file) => {
        const receiver = makeTitleReceiver('home', file);

        asView(receiver).renderTitleParent();

        expect(receiver.titleParentEl.empty).toHaveBeenCalledTimes(1);
        expect(receiver.renderBreadcrumbs).not.toHaveBeenCalled();
      })
    );
  });

  it('clears the breadcrumb when no item is loaded', () => {
    fc.assert(
      fc.property(
        pageArb,
        fc.constantFrom(null, makeFile('')),
        (page, file) => {
          const receiver = makeTitleReceiver(page, file);

          asView(receiver).renderTitleParent();

          expect(receiver.titleParentEl.empty).toHaveBeenCalledTimes(1);
          expect(receiver.renderBreadcrumbs).not.toHaveBeenCalled();
        }
      )
    );
  });
});

describe('ReviewView.setTitle', () => {
  it('pushes the current title to the view header, the tab header and the window title', () => {
    fc.assert(
      fc.property(pageArb, fileArb, (page, file) => {
        const receiver = makeTitleReceiver(page, file);
        const expected = asView(receiver).getDisplayText();

        asView(receiver).setTitle();

        expect(receiver.titleEl.setText).toHaveBeenCalledWith(expected);
        expect(receiver.leaf.updateHeader).toHaveBeenCalledTimes(1);
        expect(receiver.app.workspace.updateTitle).toHaveBeenCalledTimes(1);
      })
    );
  });

  it('lets the title be edited exactly while it names an item', () => {
    fc.assert(
      fc.property(pageArb, fileArb, (page, file) => {
        const receiver = makeTitleReceiver(page, file);

        asView(receiver).setTitle();

        const onScreen = page === 'review' && !!file?.basename;
        expect(receiver.titleEl.setAttribute).toHaveBeenLastCalledWith(
          'contenteditable',
          onScreen ? 'plaintext-only' : 'false'
        );
      })
    );
  });

  it('shows the plugin name once a review returns to the home screen with a file still loaded', () => {
    // Nothing recomputes document.title on a page change — that is neither a
    // leaf change nor a layout change — so the taskbar kept the item name.
    const receiver = makeTitleReceiver('review', makeFile('Chunking'));
    asView(receiver).setTitle();
    expect(receiver.titleEl.setText).toHaveBeenLastCalledWith('Chunking');

    receiver.setPage('home');
    asView(receiver).setTitle();

    expect(receiver.titleEl.setText).toHaveBeenLastCalledWith(
      REVIEW_VIEW_DEFAULT_TITLE
    );
    expect(receiver.app.workspace.updateTitle).toHaveBeenCalledTimes(2);
  });

  it('redraws the folder breadcrumb on the same call that sets the name', () => {
    // Both halves of the view header have to describe one item. FileView keeps
    // them in step inside loadFile; this view never goes through it, so leaving
    // the breadcrumb out here is what let the header name one item and point at
    // another item's folder.
    const receiver = makeTitleReceiver(
      'review',
      makeFile('Security Principles')
    );

    asView(receiver).setTitle();

    expect(receiver.renderBreadcrumbs).toHaveBeenCalledTimes(1);
    expect(receiver.titleEl.setText).toHaveBeenCalledWith(
      'Security Principles'
    );
  });

  it('clears the folder breadcrumb once a review returns to the home screen', () => {
    const receiver = makeTitleReceiver('review', makeFile('Chunking'));
    asView(receiver).setTitle();

    receiver.setPage('home');
    asView(receiver).setTitle();

    expect(receiver.renderBreadcrumbs).toHaveBeenCalledTimes(1);
    expect(receiver.titleParentEl.empty).toHaveBeenCalledTimes(1);
  });

  it('marks the tab exactly while it shows an item whose file is not text', () => {
    // Only a text item gets an inline title above its body; styles.css keeps
    // the phone header title for the rest, as a PDF tab keeps its own.
    const cases: [ReviewPage, TFile | null, boolean][] = [
      ['review', makeFile('Paper', 'pdf'), true],
      ['review', makeFile('Diagram', 'png'), true],
      ['review', makeFile('Notes', 'md'), false],
      ['review', null, false],
      ['home', makeFile('Paper', 'pdf'), false],
    ];
    for (const [page, file, marked] of cases) {
      const receiver = makeTitleReceiver(page, file);

      asView(receiver).setTitle();

      expect(
        receiver.containerEl.classList.contains(NON_TEXT_ITEM_CLASS),
        `${page} ${file?.extension ?? 'no file'}`
      ).toBe(marked);
    }
  });

  it('unmarks the tab once review moves from a PDF on to a note, or home', () => {
    const receiver = makeTitleReceiver('review', makeFile('Paper', 'pdf'));
    asView(receiver).setTitle();
    expect(receiver.containerEl.classList).toContain(NON_TEXT_ITEM_CLASS);

    asView(receiver).setFile(makeFile('Notes'), 'snippet');
    expect(receiver.containerEl.classList).not.toContain(NON_TEXT_ITEM_CLASS);

    asView(receiver).setFile(makeFile('Paper', 'pdf'), 'article');
    expect(receiver.containerEl.classList).toContain(NON_TEXT_ITEM_CLASS);
    receiver.setPage('home');
    asView(receiver).setTitle();
    expect(receiver.containerEl.classList).not.toContain(NON_TEXT_ITEM_CLASS);
  });

  it('retitles the popout window instead of the main one when the tab is popped out', () => {
    // Workspace.updateTitle only ever retitles the main window; a popout owns
    // its own. This is the branch Obsidian's own setActiveLeaf takes.
    fc.assert(
      fc.property(pageArb, fileArb, (page, file) => {
        const popout = new WorkspaceWindow();
        const updateTitle = vi
          .spyOn(popout, 'updateTitle')
          .mockImplementation(() => {});
        const receiver = makeTitleReceiver(page, file, popout);

        asView(receiver).setTitle();

        expect(updateTitle).toHaveBeenCalledTimes(1);
        expect(receiver.app.workspace.updateTitle).not.toHaveBeenCalled();
        expect(receiver.leaf.updateHeader).toHaveBeenCalledTimes(1);
        updateTitle.mockRestore();
      })
    );
  });
});

describe('ReviewView.setFile', () => {
  it('takes the item name into the tab as soon as the review loads a file', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (basename) => {
        const receiver = makeTitleReceiver('review', null);
        const file = makeFile(basename);

        asView(receiver).setFile(file, 'article');

        expect(receiver.file).toBe(file);
        expect(receiver.titleEl.setText).toHaveBeenCalledWith(basename);
        expect(receiver.app.workspace.updateTitle).toHaveBeenCalledTimes(1);
      })
    );
  });

  it('repoints the folder breadcrumb when the queue swaps in the next item', () => {
    // The reported symptom, from the user's side: consecutive items live in
    // different folders (sources/ vs cards/), and only the name was following
    // along.
    const receiver = makeTitleReceiver(
      'review',
      makeFile('Security Principles')
    );

    asView(receiver).setFile(makeFile('Chunking'), 'snippet');

    expect(receiver.renderBreadcrumbs).toHaveBeenCalledTimes(1);
  });

  it('retitles the tab and the window as review moves between cards and other items', () => {
    // Each move has to reach every surface: the header, and the taskbar and tab
    // switcher, which Obsidian only re-reads when told to.
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.constantFrom(...NOTE_TYPES), fc.string({ minLength: 1 })),
          { minLength: 1, maxLength: 6 }
        ),
        (items) => {
          const receiver = makeTitleReceiver('review', null);

          items.forEach(([type, basename], i) => {
            asView(receiver).setFile(makeFile(basename), type);

            const title =
              type === 'card' ? REVIEW_VIEW_DEFAULT_TITLE : basename;
            expect(receiver.titleEl.setText).toHaveBeenLastCalledWith(title);
            expect(receiver.leaf.updateHeader).toHaveBeenCalledTimes(i + 1);
            expect(receiver.app.workspace.updateTitle).toHaveBeenCalledTimes(
              i + 1
            );
          });
        }
      )
    );
  });

  it('drops back to the plugin name when the queue hands over no file', () => {
    const receiver = makeTitleReceiver('review', makeFile('Chunking'));

    asView(receiver).setFile(null, null);

    expect(receiver.file).toBeNull();
    expect(receiver.titleEl.setText).toHaveBeenLastCalledWith(
      REVIEW_VIEW_DEFAULT_TITLE
    );
  });
});

describe('ReviewView construction', () => {
  it('opens with no file, so the home screen can show before any item loads', () => {
    // FileView refuses to open on a null file unless allowNoFile is set, and the
    // home screen — the page this fix is about — is exactly that state.
    const view = makeView(makeFakeStore('home'));

    expect(view.allowNoFile).toBe(true);
  });
});

describe('ReviewView title bar', () => {
  const choiceArb = fc.constantFrom<ReviewTitleBar[]>(
    'obsidian',
    'show',
    'hide'
  );

  /** Classes the tab carries for other reasons: Obsidian's, and the view's own. */
  const otherClassesArb = fc
    .uniqueArray(
      fc.oneof(
        fc.constantFrom(NON_TEXT_ITEM_CLASS, 'workspace-leaf-content', 'is-x'),
        fc.stringMatching(/^[a-z][a-z-]{0,10}$/)
      ),
      { maxLength: 4 }
    )
    .map((classes) =>
      classes.filter(
        (name) => name !== HEADER_SHOWN_CLASS && name !== HEADER_HIDDEN_CLASS
      )
    );

  /** The tab's classes styles.css reads the title bar choice from. */
  const titleBarClasses = (view: ReviewView) => ({
    shown: view.containerEl.classList.contains(HEADER_SHOWN_CLASS),
    hidden: view.containerEl.classList.contains(HEADER_HIDDEN_CLASS),
  });

  const expected = (choice: ReviewTitleBar) => ({
    shown: choice === 'show',
    hidden: choice === 'hide',
  });

  it('marks the tab with the title bar choice it opens with', () => {
    fc.assert(
      fc.property(choiceArb, (choice) => {
        const view = makeView(
          makeFakeStore('home'),
          true,
          makePluginSettings(choice)
        );

        expect(titleBarClasses(view)).toEqual(expected(choice));
        unload(view);
      })
    );
  });

  it('follows each new choice it is told of, leaving its other classes alone', () => {
    fc.assert(
      fc.property(
        choiceArb,
        otherClassesArb,
        fc.array(choiceArb, { maxLength: 6 }),
        (initial, others, choices) => {
          const settings = makePluginSettings(initial);
          const view = makeView(makeFakeStore('home'), true, settings);
          view.containerEl.classList.add(...others);

          for (const choice of choices) {
            settings.reviewTitleBar = choice;
            view.syncTitleBar();

            expect(titleBarClasses(view)).toEqual(expected(choice));
            for (const name of others) {
              expect(view.containerEl.classList).toContain(name);
            }
          }
          unload(view);
        }
      )
    );
  });

  it('uses the class names styles.css keys on', () => {
    expect([HEADER_SHOWN_CLASS, HEADER_HIDDEN_CLASS]).toEqual([
      'ir-header-shown',
      'ir-header-hidden',
    ]);
  });
});

describe('ReviewView page subscription', () => {
  it('retitles once per page change and not on unrelated dispatches', () => {
    // The store notifies on every dispatch. Retitling on each would run
    // updateHeader and updateTitle on unrelated state changes.
    fc.assert(
      fc.property(
        pageArb,
        fc.array(pageArb, { maxLength: 12 }),
        (initial, dispatches) => {
          const setTitle = vi
            .spyOn(ReviewView.prototype, 'setTitle')
            .mockImplementation(() => {});
          const store = makeFakeStore(initial);
          makeView(store);

          let previous = initial;
          let changes = 0;
          for (const page of dispatches) {
            if (page !== previous) changes += 1;
            previous = page;
            store.dispatchPage(page);
          }

          expect(setTitle).toHaveBeenCalledTimes(changes);
          setTitle.mockRestore();
        }
      )
    );
  });

  it('stops retitling once the view unloads', () => {
    // A leaked subscription would retitle a detached tab on every page change.
    const setTitle = vi
      .spyOn(ReviewView.prototype, 'setTitle')
      .mockImplementation(() => {});
    const store = makeFakeStore('home');
    const view = makeView(store);

    unload(view);
    store.dispatchPage('review');

    expect(setTitle).not.toHaveBeenCalled();
  });
});

/** Every source Obsidian opens a view's pane menu from. */
const menuSourceArb = fc.constantFrom(
  'more-options',
  'tab-header',
  'sidebar-context-menu'
);

describe('ReviewView header title rename', () => {
  beforeEach(() => {
    Notice.reset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  const commitArb = fc.constantFrom(
    'blur' as const,
    'Enter' as const,
    'Tab' as const
  );

  it('renames the note on screen to the edited title, keeping it in its folder', async () => {
    await fc.assert(
      fc.asyncProperty(
        pageArb,
        itemFileArb,
        validNameArb,
        paddingArb,
        paddingArb,
        commitArb,
        async (page, file, name, before, after, end) => {
          const { view, titleEl, renameFile } = makeRenameView({ page, file });

          await editTitle(titleEl, `${before}${name}${after}`, end);

          const onScreen = page === 'review' && file.basename !== '';
          if (onScreen && name !== file.basename) {
            expect(renameFile).toHaveBeenCalledTimes(1);
            expect(renameFile).toHaveBeenCalledWith(
              file,
              renamedPath(file, name)
            );
          } else {
            // The home screen's title is the plugin's name, and an unchanged
            // name is nothing to rename; either way the title reads as before.
            expect(renameFile).not.toHaveBeenCalled();
            expect(titleEl.textContent).toBe(view.getDisplayText());
          }
          expect(Notice.messages).toEqual([]);
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('ends the edit on Enter or Tab without letting the key through', () => {
    for (const key of ['Enter', 'Tab']) {
      const { titleEl } = makeRenameView();
      titleEl.focus();
      const event = new KeyboardEvent('keydown', { key, cancelable: true });

      titleEl.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).not.toBe(titleEl);
    }
  });

  it('drops the edit on Escape, putting the name back', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (text) => {
        const { titleEl, renameFile } = makeRenameView();
        titleEl.focus();
        titleEl.textContent = text;
        const event = new KeyboardEvent('keydown', {
          key: 'Escape',
          cancelable: true,
        });

        titleEl.dispatchEvent(event);
        await flushLookups();

        expect(event.defaultPrevented).toBe(true);
        expect(renameFile).not.toHaveBeenCalled();
        expect(titleEl.textContent).toBe('Chapter 1');
        expect(document.activeElement).not.toBe(titleEl);
        document.body.innerHTML = '';
      })
    );
  });

  it('leaves the edit open while an input method is composing', () => {
    // Enter there picks a candidate, and must not commit half a word.
    const { titleEl, renameFile } = makeRenameView();
    titleEl.focus();
    titleEl.textContent = 'Chapter 2';
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      cancelable: true,
      isComposing: true,
    });

    titleEl.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(titleEl);
    expect(renameFile).not.toHaveBeenCalled();
  });

  it('leaves other keys to the title', () => {
    const { titleEl } = makeRenameView();
    titleEl.focus();
    const event = new KeyboardEvent('keydown', { key: 'a', cancelable: true });

    titleEl.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(titleEl);
  });

  it('renames nothing for a blank title, and puts the name back', async () => {
    await fc.assert(
      fc.asyncProperty(paddingArb, commitArb, async (blank, end) => {
        const { titleEl, renameFile } = makeRenameView();

        await editTitle(titleEl, blank, end);

        expect(renameFile).not.toHaveBeenCalled();
        expect(titleEl.textContent).toBe('Chapter 1');
        document.body.innerHTML = '';
      })
    );
  });

  it('renames nothing when the title ends the edit saying what it said before', async () => {
    await fc.assert(
      fc.asyncProperty(
        validNameArb,
        parentPathArb,
        paddingArb,
        paddingArb,
        commitArb,
        async (basename, parent, before, after, end) => {
          const { titleEl, renameFile } = makeRenameView({
            file: makeItemFile(basename, parent),
          });

          await editTitle(titleEl, `${before}${basename}${after}`, end);

          expect(renameFile).not.toHaveBeenCalled();
          expect(titleEl.textContent).toBe(basename);
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('refuses a name a note cannot take, says why, and puts the name back', async () => {
    const forbiddenArb = fc.constantFrom(
      ...[...FORBIDDEN_TITLE_CHARS].filter((char) => char !== '\n')
    );
    const badNameArb = fc.oneof(
      fc
        .tuple(validNameArb, forbiddenArb, fc.string())
        .map(([name, char, rest]) => `${name}${char}${rest}`),
      validNameArb.map((name) => `.${name}`),
      validNameArb.map((name) => `${name}.`)
    );
    await fc.assert(
      fc.asyncProperty(badNameArb, commitArb, async (name, end) => {
        Notice.reset();
        const { titleEl, renameFile } = makeRenameView();

        await editTitle(titleEl, name, end);

        expect(renameFile).not.toHaveBeenCalled();
        expect(Notice.messages).toHaveLength(1);
        expect(Notice.messages[0]).toContain('Chapter 1');
        expect(titleEl.textContent).toBe('Chapter 1');
        document.body.innerHTML = '';
      })
    );
  });

  it('says why when the vault refuses the rename, and puts the name back', async () => {
    const failures: [unknown, string][] = [
      [
        new Error('Destination file already exists!'),
        'Destination file already exists!',
      ],
      ['disk full', 'disk full'],
    ];
    for (const [failure, reason] of failures) {
      Notice.reset();
      const { titleEl } = makeRenameView({
        renameFile: vi.fn(async () => {
          throw failure;
        }),
      });

      await editTitle(titleEl, 'Chapter 2');

      expect(Notice.messages).toHaveLength(1);
      expect(Notice.messages[0]).toContain('Chapter 1');
      expect(Notice.messages[0]).toContain(reason);
      expect(titleEl.textContent).toBe('Chapter 1');
    }
  });

  it('leaves the old note alone when review moves on mid-edit', async () => {
    // By the time the edit ends the title names the next item, and renaming
    // the previous note after it would be the wrong note under the wrong name.
    const { view, titleEl, renameFile } = makeRenameView();
    titleEl.focus();
    titleEl.textContent = 'Chapter 2';

    view.setFile(makeItemFile('Chapter 3', 'Articles'), 'article');
    titleEl.blur();
    await flushLookups();

    expect(renameFile).not.toHaveBeenCalled();
    expect(titleEl.textContent).toBe('Chapter 3');
  });

  it('leaves the note alone when review goes home mid-edit', async () => {
    const { store, titleEl, renameFile } = makeRenameView();
    titleEl.focus();
    titleEl.textContent = 'Chapter 2';

    store.dispatchPage('home');
    titleEl.blur();
    await flushLookups();

    expect(renameFile).not.toHaveBeenCalled();
    expect(titleEl.textContent).toBe(REVIEW_VIEW_DEFAULT_TITLE);
  });

  it('keeps the title out of the tab order', () => {
    const { titleEl } = makeRenameView();

    expect(titleEl.tabIndex).toBe(-1);
  });

  it('makes the title editable exactly while it names an item, on desktop', () => {
    fc.assert(
      fc.property(
        pageArb,
        fc.option(itemFileArb, { nil: null }),
        (page, file) => {
          const { titleEl } = makeRenameView({ page, file });

          const onScreen = page === 'review' && !!file?.basename;
          expect(titleEl.getAttribute('contenteditable')).toBe(
            onScreen ? 'plaintext-only' : 'false'
          );
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('on the mobile app, makes the title editable only from a touch until the edit ends', async () => {
    // Obsidian's own header title does the same, so that nothing else putting
    // focus in the header raises the keyboard.
    await fc.assert(
      fc.asyncProperty(
        pageArb,
        fc.option(itemFileArb, { nil: null }),
        async (page, file) => {
          const { titleEl } = makeRenameView({
            page,
            file,
            isMobileApp: true,
          });
          const onScreen = page === 'review' && !!file?.basename;
          const editable = () => titleEl.getAttribute('contenteditable');
          expect(editable()).toBe('false');

          titleEl.dispatchEvent(new Event('touchstart'));
          expect(editable()).toBe(onScreen ? 'plaintext-only' : 'false');

          const previous = Platform.isMobileApp;
          Platform.isMobileApp = true;
          try {
            titleEl.focus();
            titleEl.blur();
            await flushLookups();
          } finally {
            Platform.isMobileApp = previous;
          }
          expect(editable()).toBe('false');
          document.body.innerHTML = '';
        }
      )
    );
  });

  it("never lets a card's title be edited, on desktop or from a touch", () => {
    // The title shows the plugin's name over a card, not the card's note name,
    // so there is nothing there to rename.
    for (const isMobileApp of [false, true]) {
      const { titleEl } = makeRenameView({ type: 'card', isMobileApp });

      titleEl.dispatchEvent(new Event('touchstart'));

      expect(titleEl.getAttribute('contenteditable'), `${isMobileApp}`).toBe(
        'false'
      );
      document.body.innerHTML = '';
    }
  });

  it('never renames a card to whatever its title is made to say', async () => {
    await fc.assert(
      fc.asyncProperty(
        itemFileArb,
        validNameArb,
        commitArb,
        async (file, name, end) => {
          const { titleEl, renameFile } = makeRenameView({
            file,
            type: 'card',
          });

          await editTitle(titleEl, name, end);

          expect(renameFile).not.toHaveBeenCalled();
          expect(titleEl.textContent).toBe(REVIEW_VIEW_DEFAULT_TITLE);
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('never listens for touch on desktop', () => {
    const { titleEl } = makeRenameView();
    titleEl.setAttribute('contenteditable', 'false');

    titleEl.dispatchEvent(new Event('touchstart'));

    expect(titleEl.getAttribute('contenteditable')).toBe('false');
  });
});

describe('ReviewView header breadcrumb', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const textTypeArb = fc.constantFrom<NoteType[]>('article', 'snippet');

  it('shows no folder over a card, as over the home screen', () => {
    // The card's folder in front of the plugin's name read as a note called
    // "Incremental reading" in the cards folder.
    fc.assert(
      fc.property(itemFileArb, (file) => {
        const { view, titleEl } = makeRenameView({ file });
        const breadcrumb = drawBreadcrumbs(view);

        view.setFile(file, 'card');
        expect(breadcrumb.textContent).toBe('');
        expect(titleEl.textContent).toBe(REVIEW_VIEW_DEFAULT_TITLE);

        view.setTitle();
        expect(breadcrumb.textContent).toBe('');
        document.body.innerHTML = '';
      })
    );
  });

  it("shows an article's or a snippet's folder, also after a card", () => {
    fc.assert(
      fc.property(itemFileArb, itemFileArb, textTypeArb, (card, file, type) => {
        const { view } = makeRenameView({ file: card, type: 'card' });
        const breadcrumb = drawBreadcrumbs(view);

        view.setFile(file, type);
        expect(breadcrumb.textContent).toBe(breadcrumbsOf(file));

        view.setTitle();
        expect(breadcrumb.textContent).toBe(breadcrumbsOf(file));
        document.body.innerHTML = '';
      })
    );
  });

  it("keeps a card's folder out of the header when its note is renamed", async () => {
    // Obsidian's own rename handler redraws the breadcrumb and writes the new
    // name into the header before handing over.
    vi.spyOn(FileView.prototype, 'onRename').mockImplementation(async function (
      this: ReviewView,
      renamed: TFile
    ) {
      this.renderBreadcrumbs();
      this.titleEl.setText(renamed.basename);
    });
    await fc.assert(
      fc.asyncProperty(
        itemFileArb,
        fc.constantFrom<NoteType[]>(...NOTE_TYPES),
        async (file, type) => {
          const { view, titleEl } = makeRenameView({ file, type });
          const breadcrumb = drawBreadcrumbs(view);

          await view.onRename(file);

          const card = type === 'card';
          expect(breadcrumb.textContent).toBe(card ? '' : breadcrumbsOf(file));
          expect(titleEl.textContent).toBe(
            card
              ? REVIEW_VIEW_DEFAULT_TITLE
              : file.basename || REVIEW_VIEW_DEFAULT_TITLE
          );
          document.body.innerHTML = '';
        }
      )
    );
  });
});

describe('ReviewView.onRename', () => {
  it('retitles the header from the page when the file it holds is renamed', async () => {
    // FileView's own handler writes the file's name into the header whatever
    // the page, which on the home screen names a note the tab is not showing.
    await fc.assert(
      fc.asyncProperty(pageArb, itemFileArb, async (page, file) => {
        const { view, titleEl } = makeRenameView({ page, file });
        const superRename = vi.spyOn(FileView.prototype, 'onRename');
        titleEl.textContent = 'stale';

        await view.onRename(file);

        expect(superRename).toHaveBeenCalledWith(file);
        expect(titleEl.textContent).toBe(view.getDisplayText());
        superRename.mockRestore();
        document.body.innerHTML = '';
      })
    );
  });

  it("keeps a card's name out of the header when its note is renamed", async () => {
    // FileView's own handler writes the new name into the header first.
    await fc.assert(
      fc.asyncProperty(pageArb, itemFileArb, async (page, file) => {
        const { view, titleEl } = makeRenameView({ page, file, type: 'card' });
        titleEl.textContent = file.basename;

        await view.onRename(file);

        expect(titleEl.textContent).toBe(REVIEW_VIEW_DEFAULT_TITLE);
        document.body.innerHTML = '';
      })
    );
  });

  it('leaves the header alone when some other file is renamed', async () => {
    const { view, titleEl } = makeRenameView();
    titleEl.textContent = 'untouched';

    await view.onRename(makeItemFile('Other', 'Articles'));

    expect(titleEl.textContent).toBe('untouched');
  });
});

describe('ReviewView.onOpen with an item to open on', () => {
  afterEach(() => {
    store.dispatch(resetSession());
    vi.restoreAllMocks();
  });

  it.each(NOTE_TYPES)(
    'titles the tab for the %s it opens on the way it would for one the queue reached',
    async (type) => {
      store.dispatch(setPage('review'));
      const file = makeFile('Opening item');
      const { view } = await openHistoryView({
        initialItem: { data: { type, id: 'item-1' }, file } as ReviewItem,
      });
      try {
        expect(view.file).toBe(file);
        expect(view.getDisplayText()).toBe(
          type === 'card' ? REVIEW_VIEW_DEFAULT_TITLE : 'Opening item'
        );
      } finally {
        unload(view);
      }
    }
  );
});

describe('ReviewView.onPaneMenu', () => {
  it("puts the view's own entries in the section that renders first", () => {
    // Menu.sort groups by section instead of following the order entries were
    // added, and `pane` precedes `open` — where Split right and Split down land
    // — in the order the view header registers.
    const { view } = makeMenuReceiver();

    const menu = paneMenu(view);

    expect(itemTitled(menu, 'Open in new tab')?.section).toBe('pane');
  });

  it('offers the bulk un-import on the home screen alone, while any article is there, among its own entries, opening the dialog for it', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<ReviewPage>('home', 'review'),
        fc.boolean(),
        menuSourceArb,
        (page, anyArticle, source) => {
          const { view, openBulkUnimport } = makeMenuReceiver({
            page,
            anyArticle,
          });

          const menu = paneMenu(view, source);

          const entry = menu.items.find(({ icon }) => icon === 'lucide-file-x');
          if (page !== 'home' || !anyArticle) {
            expect(entry).toBeUndefined();
            return;
          }
          expect(entry?.section).toBe('pane');
          expect(openBulkUnimport).not.toHaveBeenCalled();
          click(entry);
          expect(openBulkUnimport).toHaveBeenCalledOnce();
        }
      )
    );
  });

  it("opens the item's note in a markdown tab of its own", () => {
    // The review tab keeps reviewing; the note opens beside it, which is the
    // whole point of the entry.
    const { view, app, file, openFile } = makeMenuReceiver();

    click(itemTitled(paneMenu(view), 'Open in new tab'));

    expect(app.workspace.getLeaf).toHaveBeenCalledWith('tab');
    expect(openFile).toHaveBeenCalledWith(file, { active: true });
  });

  it('offers the rename and delete that FileView leaves out', () => {
    const { view } = makeMenuReceiver();

    const menu = paneMenu(view);

    expect(itemTitled(menu, 'Rename...')?.section).toBe('action');
    expect(itemTitled(menu, 'Delete')?.section).toBe('danger');
    // Obsidian paints warning entries red, as it does for deleting a note.
    expect(itemTitled(menu, 'Delete')?.warning).toBe(true);
  });

  it('renames and deletes the note the tab is showing', () => {
    const { view, app, file } = makeMenuReceiver();
    const menu = paneMenu(view);

    click(itemTitled(menu, 'Rename...'));
    click(itemTitled(menu, 'Delete'));

    expect(app.fileManager.promptForFileRename).toHaveBeenCalledWith(file);
    expect(app.fileManager.promptForDeletion).toHaveBeenCalledWith(file);
  });

  it("leaves rename out for a card, whose prompt would show the card's text", () => {
    // A card note is named after the start of its text, and the rename prompt
    // opens with that name filled in.
    fc.assert(
      fc.property(menuSourceArb, (source) => {
        const { view, app, leaf, file } = makeMenuReceiver({ type: 'card' });

        const menu = paneMenu(view, source);

        expect(itemTitled(menu, 'Rename...')).toBeUndefined();
        // The rest of the file's menu is still the card's to use.
        expect(itemTitled(menu, 'Delete')).toBeDefined();
        expect(triggered(app, 'file-menu')).toEqual([
          'file-menu',
          menu,
          file,
          source,
          leaf,
        ]);
      })
    );
  });

  it('fires file-menu, which is where the rest of the menu comes from', () => {
    // Move file to, Bookmark, Copy path, Reveal in navigation and every
    // community plugin's entries all arrive on this event. FileView never fires
    // it, which is what left the menu looking broken.
    fc.assert(
      fc.property(menuSourceArb, (source) => {
        const { view, app, leaf, file } = makeMenuReceiver();

        const menu = paneMenu(view, source);

        expect(triggered(app, 'file-menu')).toEqual([
          'file-menu',
          menu,
          file,
          source,
          leaf,
        ]);
      })
    );
  });

  it('delegates to FileView for the tab-level entries', () => {
    // Split right, Split down, and Close and Pin on a phone come from there.
    const onPaneMenu = vi.spyOn(FileView.prototype, 'onPaneMenu');
    const { view } = makeMenuReceiver();

    const menu = paneMenu(view, 'tab-header');

    expect(onPaneMenu).toHaveBeenCalledWith(menu, 'tab-header');
  });

  it('greys out the split entries, which would duplicate the review tab', () => {
    // They belong to ItemView, so there is no way to leave them unadded — they
    // have to be found afterwards and switched off. Found by title, since the
    // entry another class added exposes nothing else to key on.
    vi.spyOn(FileView.prototype, 'onPaneMenu').mockImplementation((menu) => {
      for (const title of ['Split right', 'Split down', 'Pin']) {
        menu.addItem((item) => item.setTitle(title).setSection('open'));
      }
    });
    const { view } = makeMenuReceiver();

    const menu = paneMenu(view);

    expect(itemTitled(menu, 'Split right')?.disabled).toBe(true);
    expect(itemTitled(menu, 'Split down')?.disabled).toBe(true);
    // Everything else ItemView contributes is left alone.
    expect(itemTitled(menu, 'Pin')?.disabled).toBe(false);
  });

  it('says nothing about a file the tab is not showing', () => {
    // `file` legitimately still points at the last item while the home screen
    // is up, so a menu built from it alone would rename or delete a note the
    // tab is not displaying.
    fc.assert(
      fc.property(pageArb, fileArb, menuSourceArb, (page, file, source) => {
        fc.pre(page !== 'review' || !file?.basename);
        const { view, app } = makeMenuReceiver({ page, file });

        const menu = paneMenu(view, source);

        // The home screen's bulk un-import, which is about no file, aside
        expect(
          menu.items.filter(({ icon }) => icon !== 'lucide-file-x')
        ).toHaveLength(0);
        expect(triggered(app, 'file-menu')).toBeUndefined();
      })
    );
  });

  it("adds a reveal entry only where Obsidian's file explorer does not", () => {
    // The file explorer contributes Reveal file in navigation to every
    // `file-menu`, but its handler is guarded by `!Platform.isMobile`, so
    // adding ours unconditionally would list the action twice on desktop.
    const { view } = makeMenuReceiver();

    onPlatform(true, () => {
      expect(
        itemTitled(paneMenu(view), 'Reveal file in navigation')?.section
      ).toBe('pane');
    });
    onPlatform(false, () => {
      expect(
        itemTitled(paneMenu(view), 'Reveal file in navigation')
      ).toBeUndefined();
    });
  });

  it("reveals the item's note in the file explorer", () => {
    const { view, file, revealInFolder } = makeMenuReceiver();

    onPlatform(true, () => {
      click(itemTitled(paneMenu(view), 'Reveal file in navigation'));
    });

    expect(revealInFolder).toHaveBeenCalledWith(file);
  });

  it('offers the context of the item the tab is showing', () => {
    const { view } = makeMenuReceiver();

    const entry = itemTitled(paneMenu(view), 'Go to context');

    expect(entry?.section).toBe('pane');
    expect(entry?.icon).toBe('lucide-locate');
  });

  it("goes to the context of the tab's item in place, or where a modified click asks", () => {
    fc.assert(
      fc.property(menuClickArb, (init) => {
        const goToContext = vi.fn().mockResolvedValue(undefined);
        const { view, file } = makeMenuReceiver();
        Object.assign(view.plugin, { actions: { goToContext } });

        itemTitled(paneMenu(view), 'Go to context')?.callback?.(init);

        expect(goToContext).toHaveBeenCalledExactlyOnceWith(
          file,
          paneFor(init)
        );
      })
    );
  });
});

describe('ReviewView source mode', () => {
  it("opens reading the way a note does, seeded from the vault's live preview setting", () => {
    // Obsidian seeds every markdown editor from this same config, and source
    // mode is its inverse: live preview on means source mode off.
    fc.assert(
      fc.property(pageArb, fc.boolean(), (page, livePreview) => {
        const view = makeView(makeFakeStore(page), livePreview);

        expect(view.sourceMode).toBe(!livePreview);
      })
    );
  });

  it('switches the editor on screen rather than waiting for the next item', () => {
    const editor = makeMountedEditor(false);
    const { view } = makeMenuReceiver({ editor, sourceMode: false });

    view.toggleSourceMode();

    expect(editor.editMode.toggleSource).toHaveBeenCalledTimes(1);
    expect(editor.editMode.sourceMode).toBe(true);
  });

  it('remembers the choice with no editor mounted, for the editor still to come', () => {
    // `ReviewItem` keys the editor on the item id, so every advance through the
    // queue builds a fresh one; a card still asking its question has none at
    // all. The flag has to survive both, or the toggle lasts one item.
    const { view } = makeMenuReceiver({ editor: null, sourceMode: false });

    view.toggleSourceMode();

    expect(view.sourceMode).toBe(true);
  });

  it('lands back where it started after an even number of toggles', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.nat({ max: 12 }), (sourceMode, toggles) => {
        const editor = makeMountedEditor(sourceMode);
        const { view } = makeMenuReceiver({ editor, sourceMode });

        for (let i = 0; i < toggles; i++) view.toggleSourceMode();

        const flipped = toggles % 2 === 1;
        expect(view.sourceMode).toBe(flipped ? !sourceMode : sourceMode);
        // The tab and the editor it is driving must never disagree, or the menu
        // would show a checkmark the text on screen contradicts.
        expect(editor.editMode.sourceMode).toBe(view.sourceMode);
      })
    );
  });
});

describe('ReviewView source mode menu entry', () => {
  it("carries Obsidian's own title, icon and section", () => {
    // The entry stands in for the one a markdown tab's menu has, so it has to
    // read as that entry — `pane` is also what puts it above Split right.
    const { view } = makeMenuReceiver({ editor: makeMountedEditor() });

    const item = itemTitled(paneMenu(view), 'Source mode');

    expect(item?.icon).toBe('lucide-code-2');
    expect(item?.section).toBe('pane');
  });

  it('is absent on a page with no editor to act on', () => {
    // Obsidian hides it in reading view for the same reason. Here that is a
    // card still asking its question: rendered markdown, no editor.
    const { view } = makeMenuReceiver({ editor: null });

    expect(itemTitled(paneMenu(view), 'Source mode')).toBeUndefined();
  });

  it('is checked exactly when source mode is on', () => {
    fc.assert(
      fc.property(fc.boolean(), (sourceMode) => {
        const { view } = makeMenuReceiver({
          editor: makeMountedEditor(sourceMode),
          sourceMode,
        });

        expect(itemTitled(paneMenu(view), 'Source mode')?.checked).toBe(
          sourceMode
        );
      })
    );
  });

  it('switches the mode when clicked', () => {
    const editor = makeMountedEditor(false);
    const { view } = makeMenuReceiver({ editor, sourceMode: false });

    click(itemTitled(paneMenu(view), 'Source mode'));

    expect(view.sourceMode).toBe(true);
    expect(editor.editMode.toggleSource).toHaveBeenCalledTimes(1);
  });
});

describe('ReviewView.showMoreOptionsMenu', () => {
  it("registers the section order Obsidian's view header uses", () => {
    // Copied from ItemView.onMoreOptions. Order is what decides where every
    // entry lands, so a menu built by hand has to declare the same one.
    const { view, app } = makeMenuReceiver();

    view.showMoreOptionsMenu(makeAnchor({ x: 0, bottom: 0, width: 0 }));

    expect(shownMenu(app).sections).toEqual([
      'close',
      'pane',
      'open',
      'action',
      'find',
      'info',
      'info.copy',
      'view',
      'view.linked',
      'system',
      '',
      'danger',
    ]);
  });

  it('groups the copy entries into a submenu, as the header does', () => {
    const { view, app } = makeMenuReceiver();

    view.showMoreOptionsMenu(makeAnchor({ x: 0, bottom: 0, width: 0 }));

    const config = shownMenu(app).submenuConfigs['info.copy'];
    expect(typeof config?.title).toBe('string');
    expect(config?.icon).toBe('lucide-clipboard');
  });

  it('fires leaf-menu, which is what adds Open in new window', () => {
    const { view, app, leaf } = makeMenuReceiver();

    view.showMoreOptionsMenu(makeAnchor({ x: 0, bottom: 0, width: 0 }));

    expect(triggered(app, 'leaf-menu')?.slice(2)).toEqual([leaf]);
  });

  it('carries the file entries the header button would have shown', () => {
    // The desktop button stands in for a header Obsidian never draws here, so
    // it has to arrive at the same menu.
    const { view, app } = makeMenuReceiver();

    view.showMoreOptionsMenu(makeAnchor({ x: 0, bottom: 0, width: 0 }));

    expect(itemTitled(shownMenu(app), 'Open in new tab')).toBeDefined();
    expect(itemTitled(shownMenu(app), 'Rename...')).toBeDefined();
  });

  it('hangs the menu under the button it was given', () => {
    // Anchored the way ItemView.onMoreOptions anchors it: left-aligned under
    // the button, overlapping it, and parented to it so the button reads as
    // active while the menu is open.
    const { view, app } = makeMenuReceiver();
    const anchor = makeAnchor({ x: 120, bottom: 48, width: 24 });

    view.showMoreOptionsMenu(anchor);

    expect(shownMenu(app).parentEl).toBe(anchor);
    expect(shownMenu(app).shownAt).toEqual({
      x: 120,
      y: 48,
      width: 24,
      overlap: true,
      left: true,
    });
  });
});

describe('ReviewView history recording', () => {
  beforeEach(() => {
    store.dispatch(resetSession());
  });

  it('records the place review leaves, not the one it arrives at', async () => {
    // Back has to return to where the user was. By the time the store notifies,
    // it already names where they are going.
    await fc.assert(
      fc.asyncProperty(destinationArb, placeArb, async (from, to) => {
        fc.pre(!samePlace(from, to));
        store.dispatch(resetSession());
        moveStore(from);
        const { view, leaf } = await openHistoryView();
        try {
          moveStore(to);

          expect(leaf.recordHistory).toHaveBeenCalledTimes(1);
          expect(backPlaces(leaf)).toEqual([from]);
        } finally {
          unload(view);
        }
      })
    );
  });

  it('never records review between items, which is nowhere to come back to', async () => {
    await fc.assert(
      fc.asyncProperty(placeArb, async (to) => {
        store.dispatch(resetSession());
        moveStore({ page: 'review', itemId: null });
        const { view, leaf } = await openHistoryView();
        try {
          moveStore(to);

          expect(leaf.recordHistory).not.toHaveBeenCalled();
        } finally {
          unload(view);
        }
      })
    );
  });

  it('records nothing for dispatches that leave review where it is', async () => {
    // The store notifies on every dispatch. Revealing a card's answer, or the
    // queue settling on an item behind the home screen, goes nowhere.
    await fc.assert(
      fc.asyncProperty(
        destinationArb,
        fc.boolean(),
        itemIdArb,
        async (from, showAnswer, idBehindHome) => {
          store.dispatch(resetSession());
          moveStore(from);
          const { view, leaf } = await openHistoryView();
          try {
            store.dispatch(setShowAnswer(showAnswer));
            if (from.page === 'home') {
              store.dispatch(setCurrentItemId(idBehindHome));
            }

            expect(leaf.recordHistory).not.toHaveBeenCalled();
          } finally {
            unload(view);
          }
        }
      )
    );
  });

  it('keeps a back stack of every place left, taking back an entry review returns to before settling', async () => {
    // A walk over single store dispatches, against the rule stated as a stack:
    // leaving a place pushes it; arriving from between items at the place just
    // pushed takes it back off, because a back step to where the user already is
    // goes nowhere.
    const stepArb = fc.oneof(
      pageArb.map((page) => setPage(page)),
      fc.option(itemIdArb, { nil: null }).map((id) => setCurrentItemId(id)),
      fc.constant(resetCurrentItem()),
      fc.boolean().map((shown) => setShowAnswer(shown))
    );
    await fc.assert(
      fc.asyncProperty(
        storeStateArb,
        fc.array(stepArb, { maxLength: 16 }),
        async (initial, steps) => {
          store.dispatch(resetSession());
          store.dispatch(setCurrentItemId(initial.currentItemId));
          store.dispatch(setPage(initial.page));
          const { view, leaf } = await openHistoryView();
          const expected: ReviewPlace[] = [];
          let topIsLastPushed = false;
          let pops = 0;
          try {
            let place = placeOf(store.getState());
            for (const step of steps) {
              store.dispatch(step);
              const next = placeOf(store.getState());
              if (samePlace(place, next)) continue;
              const top = expected[expected.length - 1];
              if (isDestination(place)) {
                expected.push(place);
                topIsLastPushed = true;
              } else if (topIsLastPushed && top && samePlace(top, next)) {
                expected.pop();
                topIsLastPushed = false;
                pops += 1;
              }
              place = next;
            }

            expect(backPlaces(leaf)).toEqual(expected);
            expect(leaf.trigger).toHaveBeenCalledTimes(pops);
            leaf.trigger.mock.calls.forEach(([name]) =>
              expect(name).toBe('history-change')
            );
          } finally {
            unload(view);
          }
        }
      )
    );
  });

  it('takes back the entry for an item review advances straight back onto', async () => {
    // Undo does this: review leaves the item, and the queue hands it back.
    await fc.assert(
      fc.asyncProperty(
        fc.array(destinationArb),
        itemIdArb,
        async (earlier, id) => {
          store.dispatch(resetSession());
          const { view, leaf } = await openHistoryView();
          try {
            const older = earlier.map((place) => ({
              title: 'older',
              icon: PLUGIN_ICON,
              state: {},
              eState: placeToEphemeralState(place),
            }));
            leaf.history.backHistory.push(...older);
            // Leaving the home screen for the item records the home screen.
            moveStore({ page: 'review', itemId: id });

            store.dispatch(resetCurrentItem());
            store.dispatch(setCurrentItemId(id));

            expect(backPlaces(leaf)).toEqual([
              ...earlier,
              { page: 'home', itemId: null },
            ]);
            expect(leaf.history.backHistory.slice(0, older.length)).toEqual(
              older
            );
            expect(leaf.trigger).toHaveBeenCalledTimes(1);
            expect(leaf.trigger).toHaveBeenCalledWith('history-change');
          } finally {
            unload(view);
          }
        }
      )
    );
  });

  it('leaves an entry something else has since been pushed over', async () => {
    // Whatever went on top is the user having moved on; the entry below it is
    // still somewhere they were.
    store.dispatch(setCurrentItemId('a'));
    store.dispatch(setPage('review'));
    const { view, leaf } = await openHistoryView();
    try {
      store.dispatch(resetCurrentItem());
      const pushedOver = {
        title: 'Some note',
        icon: 'lucide-file',
        state: {},
        eState: placeToEphemeralState({ page: 'review', itemId: 'a' }),
      };
      leaf.history.backHistory.push(pushedOver);

      store.dispatch(setCurrentItemId('a'));

      expect(leaf.history.backHistory).toHaveLength(2);
      expect(leaf.history.backHistory[1]).toBe(pushedOver);
      expect(leaf.trigger).not.toHaveBeenCalled();
    } finally {
      unload(view);
    }
  });

  it('leaves an entry for the same place that it did not push itself', async () => {
    // Obsidian drops an entry that repeats the one on top. The one on top then
    // is not this tab's latest, and the user did go there.
    store.dispatch(setCurrentItemId('a'));
    store.dispatch(setPage('review'));
    const { view, leaf } = await openHistoryView();
    try {
      const existing = {
        title: 'a',
        icon: PLUGIN_ICON,
        state: {},
        eState: placeToEphemeralState({ page: 'review', itemId: 'a' }),
      };
      leaf.history.backHistory.push(existing);
      leaf.recordHistory.mockImplementation(() => {});

      store.dispatch(resetCurrentItem());
      store.dispatch(setCurrentItemId('a'));

      expect(leaf.history.backHistory).toEqual([existing]);
    } finally {
      unload(view);
    }
  });

  it('records nothing for the page and item a tab settles on while it opens', async () => {
    // Resuming a session or skipping the home screen is the tab arriving, not
    // the user leaving the home screen for an item.
    const { view, leaf } = await openHistoryView({
      resume: async () => {
        store.dispatch(setCurrentItemId('resumed'));
        store.dispatch(setPage('review'));
      },
    });
    try {
      expect(leaf.recordHistory).not.toHaveBeenCalled();

      store.dispatch(setPage('home'));

      expect(backPlaces(leaf)).toEqual([{ page: 'review', itemId: 'resumed' }]);
    } finally {
      unload(view);
    }
  });

  it('records nothing before it has opened', () => {
    // Obsidian constructs the next view before closing the one it replaces,
    // whose close then empties the session under the new one.
    store.dispatch(setCurrentItemId('a'));
    store.dispatch(setPage('review'));
    vi.spyOn(ReviewView.prototype, 'setTitle').mockImplementation(() => {});
    const leaf = makeHistoryLeaf();
    const view = new ReviewView(
      leaf as unknown as WorkspaceLeaf,
      {
        store,
        settings: makePluginSettings(),
        app: makePluginApp(),
      } as unknown as IncrementalReadingPlugin,
      {} as ReviewManager
    );
    try {
      store.dispatch(resetSession());

      expect(leaf.recordHistory).not.toHaveBeenCalled();
    } finally {
      unload(view);
    }
  });

  it('records nothing for the session its own close empties', async () => {
    // Closing the last review tab resets the session, which lands on the home
    // screen without the user having gone there.
    store.dispatch(setCurrentItemId('a'));
    store.dispatch(setPage('review'));
    const { view, leaf, sessionTracker } = await openHistoryView();
    try {
      await view.onClose();

      expect(sessionTracker.commit).toHaveBeenCalled();
      expect(store.getState().page).toBe('home');
      expect(leaf.recordHistory).not.toHaveBeenCalled();
    } finally {
      unload(view);
    }
  });
});

describe('ReviewView.historyEntryFor', () => {
  it('describes the place with what the tab showed there', async () => {
    // The title shows in the long-press history menu, and goes into the view
    // state as well, which Obsidian compares to drop a repeated entry.
    await fc.assert(
      fc.asyncProperty(placeArb, fileArb, async (place, file) => {
        store.dispatch(resetSession());
        const { view, leaf } = await openHistoryView({ file });
        try {
          const entry = view.historyEntryFor(place);

          const title =
            place.page === 'review' && file?.basename
              ? file.basename
              : REVIEW_VIEW_DEFAULT_TITLE;
          expect(entry).toEqual({
            title,
            icon: PLUGIN_ICON,
            state: { ...leaf.getViewState(), title },
            eState: { [REVIEW_PLACE_KEY]: place },
          });
        } finally {
          unload(view);
        }
      })
    );
  });

  it("keeps a card's name out of the history menu", async () => {
    await fc.assert(
      fc.asyncProperty(placeArb, fc.string(), async (place, basename) => {
        store.dispatch(resetSession());
        const { view, leaf } = await openHistoryView();
        try {
          view.setFile(makeFile(basename), 'card');

          const entry = view.historyEntryFor(place);

          expect(entry.title).toBe(REVIEW_VIEW_DEFAULT_TITLE);
          expect(entry.state).toEqual({
            ...leaf.getViewState(),
            title: REVIEW_VIEW_DEFAULT_TITLE,
          });
        } finally {
          unload(view);
        }
      })
    );
  });
});

describe('ReviewView.getEphemeralState', () => {
  it("files the store's place alongside what FileView reports", () => {
    fc.assert(
      fc.property(storeStateArb, (state) => {
        vi.spyOn(FileView.prototype, 'getEphemeralState').mockReturnValue({
          scroll: 12,
        });
        store.dispatch(setCurrentItemId(state.currentItemId));
        store.dispatch(setPage(state.page));
        const view = makeView(store as never);
        Object.assign(view, { leaf: { parent: {} } });
        try {
          const eState = view.getEphemeralState();

          expect(eState).toEqual({
            scroll: 12,
            [REVIEW_PLACE_KEY]: placeOf(state),
          });
          expect(readPlace(eState)).toEqual(placeOf(state));
        } finally {
          unload(view);
          vi.restoreAllMocks();
        }
      })
    );
  });

  it('leaves the place out for a tab being closed, which resumes when reopened', () => {
    // Detaching takes the leaf out of its parent before Obsidian snapshots what
    // reopening the tab restores; the reopened tab's own resume decides instead.
    fc.assert(
      fc.property(
        storeStateArb,
        fc.constantFrom(null, undefined),
        (state, parent) => {
          vi.spyOn(FileView.prototype, 'getEphemeralState').mockReturnValue({
            scroll: 12,
          });
          store.dispatch(setCurrentItemId(state.currentItemId));
          store.dispatch(setPage(state.page));
          const view = makeView(store as never);
          Object.assign(view, { leaf: { parent } });
          try {
            expect(view.getEphemeralState()).toEqual({ scroll: 12 });
          } finally {
            unload(view);
            vi.restoreAllMocks();
          }
        }
      )
    );
  });
});

describe('ReviewView.setEphemeralState', () => {
  beforeEach(() => {
    store.dispatch(resetSession());
  });

  it('brings review back to the place a history entry names, without recording the move', async () => {
    await fc.assert(
      fc.asyncProperty(storeStateArb, placeArb, async (initial, target) => {
        store.dispatch(resetSession());
        store.dispatch(setCurrentItemId(initial.currentItemId));
        store.dispatch(setPage(initial.page));
        const { view, leaf } = await openHistoryView();
        try {
          view.setEphemeralState(placeToEphemeralState(target));

          const state = store.getState();
          expect(placeOf(state)).toEqual(target);
          if (target.page === 'home') {
            // The home screen leaves the item where it was.
            expect(state.currentItemId).toBe(initial.currentItemId);
          }
          expect(leaf.recordHistory).not.toHaveBeenCalled();
        } finally {
          unload(view);
        }
      })
    );
  });

  it('hides the answer of a card it brings review back to', async () => {
    store.dispatch(setCurrentItemId('card'));
    store.dispatch(setPage('review'));
    store.dispatch(setShowAnswer(true));
    const { view } = await openHistoryView();
    try {
      view.setEphemeralState(
        placeToEphemeralState({ page: 'review', itemId: 'other card' })
      );

      expect(store.getState().showAnswer).toBe(false);
    } finally {
      unload(view);
    }
  });

  it('leaves review alone for ephemeral state that names no place', async () => {
    // A link's subpath, `focusLeaf`'s focus flag: Obsidian hands any view these.
    const noPlaceArb = fc.oneof(
      fc.anything().filter((value) => readPlace(value) === null),
      fc.constant({ focus: true }),
      fc.constant({ subpath: '#Heading' })
    );
    await fc.assert(
      fc.asyncProperty(noPlaceArb, async (eState) => {
        store.dispatch(resetSession());
        store.dispatch(setCurrentItemId('a'));
        store.dispatch(setPage('review'));
        const { view, reviewManager } = await openHistoryView();
        const before = store.getState();
        try {
          view.setEphemeralState(eState);

          expect(store.getState()).toBe(before);
          expect(reviewManager.getItemOrMissingFromId).not.toHaveBeenCalled();
        } finally {
          unload(view);
        }
      })
    );
  });

  it('passes the ephemeral state on to FileView', async () => {
    const { view } = await openHistoryView();
    const setOnFileView = vi.spyOn(FileView.prototype, 'setEphemeralState');
    const eState = {
      focus: true,
      ...placeToEphemeralState({ page: 'home', itemId: null }),
    };
    try {
      view.setEphemeralState(eState);

      expect(setOnFileView).toHaveBeenCalledWith(eState);
    } finally {
      unload(view);
    }
  });

  it('checks that an item it returns to still exists, and only for an item', async () => {
    await fc.assert(
      fc.asyncProperty(placeArb, async (target) => {
        store.dispatch(resetSession());
        const { view, reviewManager } = await openHistoryView();
        try {
          view.setEphemeralState(placeToEphemeralState(target));

          if (target.itemId === null) {
            expect(reviewManager.getItemOrMissingFromId).not.toHaveBeenCalled();
          } else {
            expect(reviewManager.getItemOrMissingFromId).toHaveBeenCalledWith(
              target.itemId
            );
          }
        } finally {
          unload(view);
        }
      })
    );
  });

  it('goes back to recording once the entry is applied', async () => {
    // Only the move through history itself goes unrecorded; the user leaving
    // the place it brought them to is a move like any other.
    await fc.assert(
      fc.asyncProperty(destinationArb, placeArb, async (target, next) => {
        fc.pre(!samePlace(target, next));
        store.dispatch(resetSession());
        const { view, leaf } = await openHistoryView();
        try {
          view.setEphemeralState(placeToEphemeralState(target));
          moveStore(next);

          expect(backPlaces(leaf)).toEqual([target]);
        } finally {
          unload(view);
        }
      })
    );
  });

  it('keeps an entry the user moved through history past from being taken back off', async () => {
    // Moving through history accounts for the entry. Were it still this tab's
    // latest, the queue later handing over that item would pop an entry that is
    // no longer the one this tab pushed.
    store.dispatch(setCurrentItemId('a'));
    store.dispatch(setPage('review'));
    const { view, leaf } = await openHistoryView();
    try {
      store.dispatch(resetCurrentItem());
      view.setEphemeralState(
        placeToEphemeralState({ page: 'review', itemId: null })
      );

      store.dispatch(setCurrentItemId('a'));

      expect(backPlaces(leaf)).toEqual([{ page: 'review', itemId: 'a' }]);
      expect(leaf.trigger).not.toHaveBeenCalled();
    } finally {
      unload(view);
    }
  });
});

describe('ReviewView.leaveIfGone', () => {
  beforeEach(() => {
    store.dispatch(resetSession());
  });

  it('moves review on from an item history returned to that no longer exists', async () => {
    const { view, leaf } = await openHistoryView({ itemExists: false });
    try {
      view.setEphemeralState(
        placeToEphemeralState({ page: 'review', itemId: 'deleted' })
      );
      await flushLookups();

      expect(placeOf(store.getState())).toEqual({
        page: 'review',
        itemId: null,
      });
      expect(leaf.recordHistory).not.toHaveBeenCalled();
    } finally {
      unload(view);
    }
  });

  it('goes back to recording once it has moved review on', async () => {
    const { view, leaf } = await openHistoryView({ itemExists: false });
    try {
      view.setEphemeralState(
        placeToEphemeralState({ page: 'review', itemId: 'deleted' })
      );
      await flushLookups();
      store.dispatch(setCurrentItemId('next'));

      store.dispatch(setPage('home'));

      expect(backPlaces(leaf)).toEqual([{ page: 'review', itemId: 'next' }]);
    } finally {
      unload(view);
    }
  });

  it('stays on an item that still exists', async () => {
    const { view } = await openHistoryView({ itemExists: true });
    try {
      view.setEphemeralState(
        placeToEphemeralState({ page: 'review', itemId: 'a' })
      );
      await flushLookups();

      expect(store.getState().currentItemId).toBe('a');
    } finally {
      unload(view);
    }
  });

  it('leaves review alone once it has moved off the missing item', async () => {
    const { view } = await openHistoryView({ itemExists: false });
    try {
      store.dispatch(setCurrentItemId('deleted'));
      const lookup = view.leaveIfGone('deleted');
      store.dispatch(setCurrentItemId('picked meanwhile'));
      await lookup;

      expect(store.getState().currentItemId).toBe('picked meanwhile');
    } finally {
      unload(view);
    }
  });
});

describe('ReviewView.setState', () => {
  it('hands FileView everything but the file, which follows the store', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.anything(),
          fc.record(
            { file: fc.string(), other: fc.anything() },
            { requiredKeys: [] }
          )
        ),
        async (state) => {
          const setOnFileView = vi
            .spyOn(FileView.prototype, 'setState')
            .mockResolvedValue(undefined);
          const view = makeView(makeFakeStore('home'));
          const result = { history: false };
          try {
            await view.setState(state, result);

            const expected: Record<string, unknown> =
              typeof state === 'object' && state !== null ? { ...state } : {};
            delete expected.file;
            expect(setOnFileView).toHaveBeenCalledTimes(1);
            const [handed, handedResult] = setOnFileView.mock.calls[0] ?? [];
            expect(handed).toEqual(expected);
            expect(handed).not.toHaveProperty('file');
            expect(handedResult).toBe(result);
          } finally {
            unload(view);
            vi.restoreAllMocks();
          }
        }
      )
    );
  });
});

describe('ReviewView.setState, given no state object', () => {
  it('hands FileView an empty state rather than the pieces of a primitive', async () => {
    // Spread, a string comes apart into one key per character.
    for (const state of ['file', 42, true, null, undefined]) {
      const setOnFileView = vi
        .spyOn(FileView.prototype, 'setState')
        .mockResolvedValue(undefined);
      const view = makeView(makeFakeStore('home'));
      try {
        await view.setState(state, { history: false });

        expect(setOnFileView.mock.calls[0]?.[0]).toEqual({});
      } finally {
        unload(view);
        vi.restoreAllMocks();
      }
    }
  });
});

describe('ReviewView.refreshMobileNavbar', () => {
  it("re-reads the navbar's buttons each time the tab's history changes", async () => {
    await fc.assert(
      fc.asyncProperty(fc.nat({ max: 5 }), async (changes) => {
        const mobileNavbar = { onLeafChange: vi.fn() };
        const { view, leaf } = await openHistoryView({ mobileNavbar });
        try {
          for (let i = 0; i < changes; i++) leaf.trigger('history-change');

          expect(mobileNavbar.onLeafChange).toHaveBeenCalledTimes(changes);
        } finally {
          unload(view);
        }
      })
    );
  });

  it('does nothing where there is no navbar, as on desktop', async () => {
    const { view, leaf } = await openHistoryView({ mobileNavbar: null });
    try {
      expect(() => leaf.trigger('history-change')).not.toThrow();
    } finally {
      unload(view);
    }
  });
});

describe('ReviewView selection mode', () => {
  const selectionKindArb = fc.constantFrom<SelectionKind>('snippet', 'card');

  beforeEach(() => {
    store.dispatch(resetSession());
  });

  afterEach(() => {
    store.dispatch(resetSession());
  });

  it('is over wherever history brings review back to, the place it is already at included', async () => {
    await fc.assert(
      fc.asyncProperty(
        storeStateArb,
        fc.option(placeArb, { nil: null }),
        selectionKindArb,
        async (initial, target, kind) => {
          store.dispatch(resetSession());
          store.dispatch(setCurrentItemId(initial.currentItemId));
          store.dispatch(setPage(initial.page));
          const { view } = await openHistoryView();
          try {
            store.dispatch(setSelectionMode(kind));

            view.setEphemeralState(
              placeToEphemeralState(target ?? placeOf(store.getState()))
            );

            expect(store.getState().selectionMode).toBeNull();
          } finally {
            unload(view);
          }
        }
      )
    );
  });

  it('is over once the tab closes, though another review tab keeps the session', async () => {
    await fc.assert(
      fc.asyncProperty(selectionKindArb, async (kind) => {
        store.dispatch(setCurrentItemId('a'));
        store.dispatch(setPage('review'));
        const { view, leaf, sessionTracker } = await openHistoryView();
        Object.assign(view.app.workspace, {
          getLeavesOfType: () => [leaf, {}],
        });
        try {
          store.dispatch(setSelectionMode(kind));

          await view.onClose();

          expect(store.getState().selectionMode).toBeNull();
          // The session itself is the other tab's, and outlives this one.
          expect(sessionTracker.commit).not.toHaveBeenCalled();
          expect(store.getState().currentItemId).toBe('a');
        } finally {
          unload(view);
        }
      })
    );
  });
});

describe('ReviewView Escape in selection mode', () => {
  const selectionKindArb = fc.constantFrom<SelectionKind>('snippet', 'card');
  /** Entering the mode as either kind, or leaving it. */
  const modeArb = fc.option(selectionKindArb, { nil: null });

  beforeEach(() => {
    store.dispatch(resetSession());
  });

  afterEach(() => {
    store.dispatch(resetSession());
  });

  it('cancels the mode through this tab and takes the key, exactly while review is in it', () => {
    fc.assert(
      fc.property(fc.array(modeArb, { maxLength: 6 }), (modes) => {
        store.dispatch(resetSession());
        const keyed = makeKeyedView();
        try {
          modes.forEach((mode) => store.dispatch(setSelectionMode(mode)));
          const inMode = store.getState().selectionMode !== null;

          const { consumed } = pressKey(keyed, { key: 'Escape' });

          if (inMode) {
            // What the Cancel button does, for the tab the key was pressed in.
            expect(keyed.cancelSelection).toHaveBeenCalledExactlyOnceWith(
              keyed.view
            );
            expect(consumed).toBe(true);
            expect(keyed.hotkey).not.toHaveBeenCalled();
          } else {
            // Nothing changes outside the mode: the key still reaches the
            // app's hotkeys and Obsidian's own Escape handling.
            expect(keyed.cancelSelection).not.toHaveBeenCalled();
            expect(consumed).toBe(false);
            expect(keyed.hotkey).toHaveBeenCalledOnce();
          }
        } finally {
          unload(keyed.view);
        }
      })
    );
  });

  it('leaves every key but a bare Escape to the app in the mode', () => {
    const modifiersArb = fc.record({
      ctrlKey: fc.boolean(),
      metaKey: fc.boolean(),
      altKey: fc.boolean(),
      shiftKey: fc.boolean(),
    });
    fc.assert(
      fc.property(
        selectionKindArb,
        fc.constantFrom('Escape', 'Enter', 'a', 'F3', 'ArrowDown', ' '),
        modifiersArb,
        (kind, key, modifiers) => {
          fc.pre(key !== 'Escape' || Object.values(modifiers).some(Boolean));
          store.dispatch(resetSession());
          const keyed = makeKeyedView();
          try {
            store.dispatch(setSelectionMode(kind));

            pressKey(keyed, { key, ...modifiers });

            expect(keyed.cancelSelection).not.toHaveBeenCalled();
            expect(keyed.hotkey).toHaveBeenCalledOnce();
          } finally {
            unload(keyed.view);
          }
        }
      )
    );
  });

  it('leaves Escape to an element that edits text, such as the header title being renamed', () => {
    fc.assert(
      fc.property(selectionKindArb, editableTargetArb, (kind, makeTarget) => {
        store.dispatch(resetSession());
        const keyed = makeKeyedView();
        try {
          store.dispatch(setSelectionMode(kind));

          const { consumed } = pressKey(keyed, { key: 'Escape' }, makeTarget());

          expect(keyed.cancelSelection).not.toHaveBeenCalled();
          // Not stopped, so the element's own Escape handler still runs.
          expect(consumed).toBe(false);
        } finally {
          unload(keyed.view);
        }
      })
    );
  });

  it('cancels from the editor, which the mode has made read-only', () => {
    const keyed = makeKeyedView();
    try {
      store.dispatch(setSelectionMode('snippet'));
      const content = document.createElement('div');
      content.setAttribute('contenteditable', 'false');

      const { consumed } = pressKey(
        keyed,
        { key: 'Escape' },
        content.appendChild(document.createElement('span'))
      );

      expect(keyed.cancelSelection).toHaveBeenCalledExactlyOnceWith(keyed.view);
      expect(consumed).toBe(true);
    } finally {
      unload(keyed.view);
    }
  });

  it('leaves Escape mid-composition to the input method', () => {
    const keyed = makeKeyedView();
    try {
      store.dispatch(setSelectionMode('card'));

      const { consumed } = pressKey(keyed, {
        key: 'Escape',
        isComposing: true,
      });

      expect(keyed.cancelSelection).not.toHaveBeenCalled();
      expect(consumed).toBe(false);
    } finally {
      unload(keyed.view);
    }
  });
});

describe('ReviewView with a PDF viewer on screen', () => {
  beforeEach(() => {
    store.dispatch(resetSession());
  });

  afterEach(() => {
    store.dispatch(resetSession());
  });

  it("hands the viewer's keys to Obsidian exactly while it is attached", () => {
    const keyed = makeKeyedView();
    const { viewer, escape } = makePdfViewer(keyed.appScope);
    try {
      keyed.view.attachPdfViewer(viewer);
      expect(keyed.view.scope).toBe(viewer.scope);
      expect(pressKey(keyed, { key: 'Escape' }).consumed).toBe(true);
      expect(escape).toHaveBeenCalledOnce();
      expect(keyed.hotkey).not.toHaveBeenCalled();
      // Keys the viewer doesn't bind still reach the app's hotkeys
      pressKey(keyed, { key: 'a' });
      expect(keyed.hotkey).toHaveBeenCalledOnce();

      keyed.view.detachPdfViewer(viewer);
      expect(keyed.view.scope).toBeNull();
      expect(pressKey(keyed, { key: 'Escape' }).consumed).toBe(false);
      expect(escape).toHaveBeenCalledOnce();
    } finally {
      unload(keyed.view);
    }
  });

  it('keeps a newer viewer when an older one detaches late', () => {
    const keyed = makeKeyedView();
    const older = makePdfViewer().viewer;
    const newer = makePdfViewer().viewer;
    try {
      keyed.view.attachPdfViewer(older);
      keyed.view.attachPdfViewer(newer);
      keyed.view.detachPdfViewer(older);

      expect(keyed.view.pdfViewer).toBe(newer);
      expect(keyed.view.scope).toBe(newer.scope);
    } finally {
      unload(keyed.view);
    }
  });

  it("lets selection mode's Escape take over from the viewer's, and hands it back after", () => {
    const keyed = makeKeyedView();
    const { viewer, escape } = makePdfViewer();
    try {
      keyed.view.attachPdfViewer(viewer);
      store.dispatch(setSelectionMode('snippet'));

      pressKey(keyed, { key: 'Escape' });
      expect(keyed.cancelSelection).toHaveBeenCalledOnce();
      expect(escape).not.toHaveBeenCalled();

      store.dispatch(setSelectionMode(null));
      expect(keyed.view.scope).toBe(viewer.scope);
    } finally {
      unload(keyed.view);
    }
  });

  it('reads the selection from the viewer while one is attached', () => {
    const keyed = makeKeyedView();
    const { viewer } = makePdfViewer();
    try {
      keyed.view.attachPdfViewer(viewer);
      expect(keyed.view.getSelection()).toBe('selected in the PDF');

      keyed.view.detachPdfViewer(viewer);
      window.getSelection()?.removeAllRanges();
      expect(keyed.view.getSelection()).toBe('');
    } finally {
      unload(keyed.view);
    }
  });

  it("opens the viewer's find bar rather than the editor's while it is attached", () => {
    const keyed = makeKeyedView();
    const activeEditor = makeActiveEditor();
    const { viewer, raw } = makePdfViewer();
    try {
      keyed.view.activeEditor = activeEditor as never;
      keyed.view.attachPdfViewer(viewer);

      keyed.view.showSearch(true);
      expect(raw.showSearch).toHaveBeenCalledOnce();
      expect(activeEditor.showSearch).not.toHaveBeenCalled();

      keyed.view.detachPdfViewer(viewer);
      keyed.view.showSearch(true);
      expect(raw.showSearch).toHaveBeenCalledOnce();
      expect(activeEditor.showSearch).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      unload(keyed.view);
    }
  });
});

describe('ReviewView links followed in its tab', () => {
  beforeEach(() => {
    store.dispatch(resetSession());
  });

  afterEach(() => {
    store.dispatch(resetSession());
    vi.restoreAllMocks();
  });

  it('shows an item it opens in review, keeping the review view', async () => {
    await fc.assert(
      fc.asyncProperty(
        destinationArb,
        itemIdArb,
        openStateArb,
        async (from, id, openState) => {
          store.dispatch(resetSession());
          moveStore(from);
          const note = noteAt('Snippets/target.md');
          const { view, leaf, obsidianOpenFile } = await openHistoryView({
            items: new Map([[note, itemOf(id, note)]]),
          });
          try {
            await (leaf as unknown as WorkspaceLeaf).openFile(note, openState);

            expect(obsidianOpenFile).not.toHaveBeenCalled();
            expect(placeOf(store.getState())).toEqual({
              page: 'review',
              itemId: id,
            });
          } finally {
            await view.onClose();
            unload(view);
          }
        }
      )
    );
  });

  it('lets Obsidian open anything that is not an item, as it would have', async () => {
    await fc.assert(
      fc.asyncProperty(
        destinationArb,
        openStateArb,
        async (from, openState) => {
          store.dispatch(resetSession());
          moveStore(from);
          const note = noteAt('Notes/plain.md');
          const { view, leaf, obsidianOpenFile } = await openHistoryView();
          try {
            await (leaf as unknown as WorkspaceLeaf).openFile(note, openState);

            expect(obsidianOpenFile).toHaveBeenCalledOnce();
            expect(obsidianOpenFile.mock.calls[0]).toStrictEqual([
              note,
              openState,
            ]);
            expect(obsidianOpenFile.mock.contexts[0]).toBe(leaf);
            expect(placeOf(store.getState())).toEqual(from);
          } finally {
            await view.onClose();
            unload(view);
          }
        }
      )
    );
  });

  it('brings the tab forward when the opener asks for it, as Obsidian would', async () => {
    await fc.assert(
      fc.asyncProperty(openStateArb, async (openState) => {
        store.dispatch(resetSession());
        const note = noteAt('Snippets/target.md');
        const { view, leaf } = await openHistoryView({
          items: new Map([[note, itemOf('target', note)]]),
        });
        const { setActiveLeaf } = (
          view.app as unknown as {
            workspace: { setActiveLeaf: ReturnType<typeof vi.fn> };
          }
        ).workspace;
        try {
          await (leaf as unknown as WorkspaceLeaf).openFile(note, openState);

          if (openState?.active) {
            expect(setActiveLeaf).toHaveBeenCalledExactlyOnceWith(leaf, {
              focus: true,
            });
          } else {
            expect(setActiveLeaf).not.toHaveBeenCalled();
          }
        } finally {
          await view.onClose();
          unload(view);
        }
      })
    );
  });

  it('follows nothing when the tab closes before the item is found', async () => {
    // By then the leaf is gone or showing whatever the user moved on to, which
    // a late open would replace.
    const note = noteAt('Snippets/target.md');
    const { view, leaf, reviewManager, obsidianOpenFile } =
      await openHistoryView({
        items: new Map([[note, itemOf('target', note)]]),
      });
    let found: () => void = () => {};
    reviewManager.getReviewItemFromFile.mockImplementationOnce(
      (file: TFile) =>
        new Promise((resolve) => {
          found = () => resolve(itemOf('target', file));
        })
    );
    const opening = (leaf as unknown as WorkspaceLeaf).openFile(note);
    await view.onClose();
    unload(view);
    found();
    await opening;

    expect(obsidianOpenFile).not.toHaveBeenCalled();
    expect(store.getState().currentItemId).toBeNull();
  });

  it('lets Obsidian open a note once the tab has closed, though something wrapped openFile over it', async () => {
    // Another plugin's wrapper still calls ours; closed, ours must pass through
    const note = noteAt('Snippets/target.md');
    const { view, leaf, obsidianOpenFile } = await openHistoryView({
      items: new Map([[note, itemOf('target', note)]]),
    });
    const ours = leaf.openFile;
    const theirs = vi.fn(
      (file: TFile, openState?: OpenViewState): Promise<void> =>
        ours.call(leaf, file, openState) as Promise<void>
    );
    leaf.openFile = theirs;
    await view.onClose();
    unload(view);

    await (leaf as unknown as WorkspaceLeaf).openFile(note);

    expect(leaf.openFile).toBe(theirs);
    expect(obsidianOpenFile).toHaveBeenCalledExactlyOnceWith(note, undefined);
  });

  it('lets Obsidian open the note when the item cannot be looked up', async () => {
    const note = noteAt('Snippets/target.md');
    const { view, leaf, reviewManager, obsidianOpenFile } =
      await openHistoryView({
        items: new Map([[note, itemOf('target', note)]]),
      });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('database closed');
    reviewManager.getReviewItemFromFile.mockRejectedValueOnce(error);
    try {
      await (leaf as unknown as WorkspaceLeaf).openFile(note);

      expect(obsidianOpenFile).toHaveBeenCalledExactlyOnceWith(note, undefined);
      expect(store.getState().currentItemId).toBeNull();
      expect(logged).toHaveBeenCalledExactlyOnceWith(
        'Incremental Reading: could not look a link up',
        error
      );
    } finally {
      await view.onClose();
      unload(view);
    }
  });

  it('lets Obsidian open a note whose row review would not show as it', async () => {
    // A tombstone at the path, or a row the note's ir-id disowns: review would
    // land on nothing, and the note would never open
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('gone', 'elsewhere', 'missing'),
        async (shown) => {
          store.dispatch(resetSession());
          const note = noteAt('Snippets/target.md');
          const { view, leaf, reviewManager, obsidianOpenFile } =
            await openHistoryView({
              items: new Map([[note, itemOf('target', note)]]),
            });
          reviewManager.getItemOrMissingFromId.mockResolvedValueOnce(
            shown === 'gone'
              ? null
              : shown === 'elsewhere'
                ? itemOf('target', noteAt('Snippets/other.md'))
                : ({ data: { id: 'target' } } as unknown as ReviewItem)
          );
          try {
            await (leaf as unknown as WorkspaceLeaf).openFile(note);

            expect(obsidianOpenFile).toHaveBeenCalledOnce();
            expect(store.getState().currentItemId).toBeNull();
          } finally {
            await view.onClose();
            unload(view);
          }
        }
      )
    );
  });

  it('opens a non-item with whatever openFile the leaf has by then', async () => {
    // Obsidian's is on the prototype, which a plugin can patch after review
    // opened
    const proto = { openFile: vi.fn(async () => {}) };
    const { view, leaf } = await openHistoryView();
    const own = leaf as unknown as Record<string, unknown>;
    delete own.openFile;
    Object.setPrototypeOf(leaf, proto);
    await view.onClose();
    view.interceptOpenFile();
    const patched = vi.fn(async () => {});
    proto.openFile = patched;
    const note = noteAt('Notes/plain.md');
    try {
      await (leaf as unknown as WorkspaceLeaf).openFile(note);

      expect(patched).toHaveBeenCalledExactlyOnceWith(note, undefined);
      expect(patched.mock.contexts[0]).toBe(leaf);
    } finally {
      unload(view);
    }
  });

  it("hands the leaf Obsidian's own openFile back when it closes", async () => {
    const { view, leaf, obsidianOpenFile } = await openHistoryView();
    expect(leaf.openFile).not.toBe(obsidianOpenFile);

    await view.onClose();
    unload(view);

    expect(leaf.openFile).toBe(obsidianOpenFile);
  });
});

describe('ReviewView places in an item a link names', () => {
  beforeEach(() => {
    store.dispatch(resetSession());
  });

  afterEach(() => {
    store.dispatch(resetSession());
    vi.restoreAllMocks();
  });

  it('hands the place to the editor that mounts for the item, once', async () => {
    await fc.assert(
      fc.asyncProperty(itemIdArb, positionalArb, async (id, eState) => {
        store.dispatch(resetSession());
        const { view, follow } = await openWithTarget(id);
        try {
          await follow(eState);
          const position = vi.fn();
          const again = vi.fn();

          view.onArrival(id, position)();
          view.onArrival(id, again)();

          expect(position).toHaveBeenCalledExactlyOnceWith(eState);
          expect(again).not.toHaveBeenCalled();
        } finally {
          await view.onClose();
          unload(view);
        }
      })
    );
  });

  it('hands the place at once to an editor already showing the item', async () => {
    await fc.assert(
      fc.asyncProperty(itemIdArb, positionalArb, async (id, eState) => {
        store.dispatch(resetSession());
        const { view, follow } = await openWithTarget(id);
        const position = vi.fn();
        const stop = view.onArrival(id, position);
        try {
          await follow(eState);
          await follow(eState);
          // Taken: an editor mounting for the item after has nothing to take
          const later = vi.fn();
          view.onArrival(id, later)();

          expect(position).toHaveBeenCalledTimes(2);
          expect(position).toHaveBeenNthCalledWith(1, eState);
          expect(position).toHaveBeenNthCalledWith(2, eState);
          expect(later).not.toHaveBeenCalled();
        } finally {
          stop();
          await view.onClose();
          unload(view);
        }
      })
    );
  });

  it('hands the place to no editor once it has stopped listening', async () => {
    const { view, follow } = await openWithTarget('target');
    const position = vi.fn();
    try {
      view.onArrival('target', position)();
      await follow({ subpath: '#Heading' });

      expect(position).not.toHaveBeenCalled();
    } finally {
      await view.onClose();
      unload(view);
    }
  });

  it("never hands the place to another item's editor", async () => {
    await fc.assert(
      fc.asyncProperty(
        itemIdArb,
        itemIdArb,
        positionalArb,
        async (id, other, eState) => {
          fc.pre(id !== other);
          store.dispatch(resetSession());
          const { view, follow } = await openWithTarget(id);
          const position = vi.fn();
          const stop = view.onArrival(other, position);
          try {
            await follow(eState);
            view.onArrival(other, position)();

            expect(position).not.toHaveBeenCalled();
          } finally {
            stop();
            await view.onClose();
            unload(view);
          }
        }
      )
    );
  });

  it('hands nothing on for a link that names no place in the item', async () => {
    await fc.assert(
      fc.asyncProperty(itemIdArb, unpositionalArb, async (id, eState) => {
        store.dispatch(resetSession());
        const { view, follow } = await openWithTarget(id);
        const live = vi.fn();
        const stop = view.onArrival(id, live);
        try {
          await follow(eState);
          const mounting = vi.fn();
          view.onArrival(id, mounting)();

          expect(live).not.toHaveBeenCalled();
          expect(mounting).not.toHaveBeenCalled();
        } finally {
          stop();
          await view.onClose();
          unload(view);
        }
      })
    );
  });

  it('drops a place no editor took once review moves to another item', async () => {
    await fc.assert(
      fc.asyncProperty(
        itemIdArb,
        itemIdArb,
        positionalArb,
        async (id, other, eState) => {
          fc.pre(id !== other);
          store.dispatch(resetSession());
          const { view, follow } = await openWithTarget(id);
          try {
            await follow(eState);
            goToReviewPlace(store, other);
            goToReviewPlace(store, id);
            const position = vi.fn();
            view.onArrival(id, position)();

            expect(position).not.toHaveBeenCalled();
          } finally {
            await view.onClose();
            unload(view);
          }
        }
      )
    );
  });

  it('drops a place no editor took when history moves review', async () => {
    await fc.assert(
      fc.asyncProperty(destinationArb, positionalArb, async (to, eState) => {
        store.dispatch(resetSession());
        const { view, follow } = await openWithTarget('target');
        try {
          await follow(eState);
          view.setEphemeralState(placeToEphemeralState(to));
          view.setEphemeralState(
            placeToEphemeralState({ page: 'review', itemId: 'target' })
          );
          const position = vi.fn();
          view.onArrival('target', position)();

          expect(position).not.toHaveBeenCalled();
        } finally {
          await view.onClose();
          unload(view);
        }
      })
    );
  });

  it('keeps the place while review is still on its way to the item', async () => {
    // Home first, as Begin Review would leave it, then review between items
    const { view, follow } = await openWithTarget('target');
    try {
      store.dispatch(setPage('home'));
      await follow({ subpath: '#Heading' });
      store.dispatch(resetCurrentItem());
      const position = vi.fn();
      view.onArrival('target', position)();

      expect(position).toHaveBeenCalledExactlyOnceWith({
        subpath: '#Heading',
      });
    } finally {
      await view.onClose();
      unload(view);
    }
  });
});

describe('ReviewView.showMissingInReview', () => {
  beforeEach(() => {
    store.dispatch(resetSession());
  });

  afterEach(() => {
    store.dispatch(resetSession());
    vi.restoreAllMocks();
  });

  it('shows the item a link to a missing file belongs to in review, as review shows a missing item', async () => {
    await fc.assert(
      fc.asyncProperty(destinationArb, itemIdArb, async (from, id) => {
        store.dispatch(resetSession());
        moveStore(from);
        const { view } = await openHistoryView({
          items: missingAt('Snippets/gone.md', id),
        });
        try {
          expect(await view.showMissingInReview('Snippets/gone.md')).toBe(true);
          expect(placeOf(store.getState())).toEqual({
            page: 'review',
            itemId: id,
          });
        } finally {
          await view.onClose();
          unload(view);
        }
      })
    );
  });

  it('shows nothing for a reference no live item has', async () => {
    await fc.assert(
      fc.asyncProperty(destinationArb, async (from) => {
        store.dispatch(resetSession());
        moveStore(from);
        const { view } = await openHistoryView({
          items: missingAt('Snippets/gone.md', 'gone'),
        });
        try {
          expect(await view.showMissingInReview('Snippets/other.md')).toBe(
            false
          );
          expect(placeOf(store.getState())).toEqual(from);
        } finally {
          await view.onClose();
          unload(view);
        }
      })
    );
  });

  it('shows nothing once the tab has closed', async () => {
    const { view } = await openHistoryView({
      items: missingAt('Snippets/gone.md', 'gone'),
    });
    await view.onClose();
    unload(view);

    expect(await view.showMissingInReview('Snippets/gone.md')).toBe(false);
    expect(store.getState().currentItemId).toBeNull();
  });
});

describe('ReviewView.onOpen', () => {
  afterEach(() => {
    store.dispatch(resetSession());
    vi.restoreAllMocks();
  });

  it('tells the plugin that a review tab opened, once its interface is up', async () => {
    const reviewOpened = vi.fn(() => {
      // The interface is rendered before the notice can show over it
      expect(ReviewInterface.createReviewInterface).toHaveBeenCalledOnce();
    });

    const { view } = await openHistoryView({ leftovers: { reviewOpened } });

    expect(reviewOpened).toHaveBeenCalledOnce();
    unload(view);
  });
});
