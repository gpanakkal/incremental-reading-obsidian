// @vitest-environment jsdom

import type ReviewManager from '#/lib/items/ReviewManager';
import type { ExtractedMarkdownEditor } from '#/lib/obsidian-editor';
import type { ReviewPage } from '#/lib/store';
import type IncrementalReadingPlugin from '#/main';
import ReviewView, { REVIEW_VIEW_DEFAULT_TITLE } from '#/views/ReviewView';
import fc from 'fast-check';
import { WorkspaceWindow, type TFile, type WorkspaceLeaf } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

/** Cleanups the view handed to `Component.register`, run on unload. */
function unload(view: ReviewView): void {
  const { registered } = view as unknown as { registered: (() => unknown)[] };
  registered.forEach((cleanup) => cleanup());
}

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
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
    expect(Object.prototype.hasOwnProperty.call(view, 'showSearch')).toBe(false);
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
    const svg = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'svg'
    );
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
      fc.property(pageArb, fc.constantFrom(null, makeFile('')), (page, file) => {
        const receiver = makeTitleReceiver(page, file);

        asView(receiver).renderTitleParent();

        expect(receiver.titleParentEl.empty).toHaveBeenCalledTimes(1);
        expect(receiver.renderBreadcrumbs).not.toHaveBeenCalled();
      })
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
    const receiver = makeTitleReceiver('review', makeFile('Security Principles'));

    asView(receiver).setTitle();

    expect(receiver.renderBreadcrumbs).toHaveBeenCalledTimes(1);
    expect(receiver.titleEl.setText).toHaveBeenCalledWith('Security Principles');
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
    const receiver = makeTitleReceiver('review', makeFile('Security Principles'));

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
