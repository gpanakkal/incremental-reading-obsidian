// @vitest-environment jsdom

import type ReviewManager from '#/lib/items/ReviewManager';
import type { ExtractedMarkdownEditor } from '#/lib/obsidian-editor';
import { resetSession, store, type ReviewPage } from '#/lib/store';
import type IncrementalReadingPlugin from '#/main';
// The mock is what `obsidian` resolves to at runtime (see vitest.config.ts), so
// importing it by path is the same module — but with the stub's own surface
// visible to TypeScript, which is where the recorded menu contents live.
import {
  FileView,
  Menu,
  Platform,
  type MenuItem,
} from '#/test/__mocks__/obsidian';
import ReviewView, { REVIEW_VIEW_DEFAULT_TITLE } from '#/views/ReviewView';
import fc from 'fast-check';
import { WorkspaceWindow, type TFile, type WorkspaceLeaf } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #region HELPERS

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

/** Every title path reads `basename` and nothing else off the file. */
function makeFile(basename: string): TFile {
  return { basename } as TFile;
}

const pageArb = fc.constantFrom<ReviewPage[]>('home', 'review');
/** Any file the queue can hand the view, plus the no-item case. */
const fileArb = fc.option(fc.string().map(makeFile), { nil: null });

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
    titleEl: { setText: vi.fn() },
    // The two halves of the view header FileView keeps in step from `loadFile`:
    // the folder breadcrumb (`titleParentEl`, filled by `renderBreadcrumbs`) and
    // the name (`titleEl`). Stubbed on the receiver because the obsidian mock's
    // `FileView` has neither.
    titleParentEl: { empty: vi.fn() },
    renderBreadcrumbs: vi.fn(),
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

function makeView(store: ReturnType<typeof makeFakeStore>): ReviewView {
  return new ReviewView(
    {} as WorkspaceLeaf,
    { store } as unknown as IncrementalReadingPlugin,
    {} as ReviewManager
  );
}

/**
 * Receiver for the menu methods, carrying the app surfaces they reach for.
 * Its prototype is set for the same reason {@link makeTitleReceiver} sets one,
 * and with the added effect that `super.onPaneMenu` resolves to the mock's
 * `FileView` — standing in for the tab-level entries Obsidian contributes there.
 */
function makeMenuReceiver({
  page = 'review',
  file = makeFile('Chapter 1'),
}: { page?: ReviewPage; file?: TFile | null } = {}) {
  const openFile = vi.fn();
  const revealInFolder = vi.fn();
  const leaf = { id: 'review-leaf' };
  const receiver = {
    file,
    leaf,
    plugin: { store: { getState: () => ({ page }) } },
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
    openFile,
    revealInFolder,
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
 * `isLastReviewTab` reads only the workspace's leaves of its own type and the
 * leaf it is mounted in, so a bare receiver is enough.
 */
function callIsLastReviewTab(openLeaves: WorkspaceLeaf[], leaf: WorkspaceLeaf) {
  const getLeavesOfType = vi.fn((_type: string): WorkspaceLeaf[] => openLeaves);
  const result = ReviewView.prototype.isLastReviewTab.call({
    app: { workspace: { getLeavesOfType } },
    leaf,
  } as unknown as ReviewView) as boolean;
  return { result, getLeavesOfType };
}

const makeLeaf = () => ({}) as WorkspaceLeaf;

/**
 * Receiver for `resumeUnclaimedSession`, which reaches only the plugin's resume
 * and the real store. The store is the module's own, so the page it lands on is
 * read back from there.
 */
function makeResumeReceiver({
  resumed = true,
  initialItem = null,
}: { resumed?: boolean; initialItem?: unknown } = {}) {
  const resumeSession = vi.fn((): Promise<boolean> => Promise.resolve(resumed));
  const receiver = {
    initialItem,
    plugin: { resumeSession, store },
  };
  return { receiver, resumeSession };
}

function callResumeUnclaimedSession(
  receiver: ReturnType<typeof makeResumeReceiver>['receiver']
): Promise<void> {
  return ReviewView.prototype.resumeUnclaimedSession.call(
    receiver as unknown as ReviewView
  ) as Promise<void>;
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
    // `learn(item)` sets the item and the page itself, after the view mounts.
    const { receiver, resumeSession } = makeResumeReceiver({
      resumed: true,
      initialItem: { data: { id: 'item-1' } },
    });

    await callResumeUnclaimedSession(receiver);

    expect(resumeSession).not.toHaveBeenCalled();
    expect(store.getState().page).toBe('home');
  });
});

describe('ReviewView.isLastReviewTab', () => {
  it('reports the only review tab open as the last one', () => {
    const leaf = makeLeaf();

    expect(callIsLastReviewTab([leaf], leaf).result).toBe(true);
  });

  it('reports a split pane as not the last while its twin is open', () => {
    // Closing one half of a split must leave the other on its item: the review
    // session is one shared store, so ending it here empties it for both.
    const leaf = makeLeaf();

    expect(callIsLastReviewTab([leaf, makeLeaf()], leaf).result).toBe(false);
  });

  it('still sees the twin once the workspace has dropped the closing leaf', () => {
    // Obsidian may detach before or after calling onClose; only the leaves that
    // remain matter either way.
    expect(callIsLastReviewTab([makeLeaf()], makeLeaf()).result).toBe(false);
  });

  it('is the last tab when the workspace has already dropped it and none remain', () => {
    expect(callIsLastReviewTab([], makeLeaf()).result).toBe(true);
  });

  it('counts review tabs, not tabs in general', () => {
    const leaf = makeLeaf();

    const { getLeavesOfType } = callIsLastReviewTab([leaf], leaf);

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

  it('names the plugin the way the rest of the UI does', () => {
    // Pinned to the literal, not the constant: the user-visible defect is a tab
    // and a taskbar entry reading anything other than this.
    expect(asView(makeTitleReceiver('home', null)).getDisplayText()).toBe(
      'Incremental reading'
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

        asView(receiver).setFile(file);

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

    asView(receiver).setFile(makeFile('Chunking'));

    expect(receiver.renderBreadcrumbs).toHaveBeenCalledTimes(1);
  });

  it('drops back to the plugin name when the queue hands over no file', () => {
    const receiver = makeTitleReceiver('review', makeFile('Chunking'));

    asView(receiver).setFile(null);

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

describe('ReviewView.onPaneMenu', () => {
  it("puts the view's own entries in the section that renders first", () => {
    // Menu.sort groups by section instead of following the order entries were
    // added, and `pane` precedes `open` — where Split right and Split down land
    // — in the order the view header registers.
    const { view } = makeMenuReceiver();

    const menu = paneMenu(view);

    expect(itemTitled(menu, 'Open in new tab')?.section).toBe('pane');
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

        expect(menu.items).toHaveLength(0);
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

    expect(shownMenu(app).submenuConfigs['info.copy']).toEqual({
      title: 'Copy path',
      icon: 'lucide-clipboard',
    });
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
