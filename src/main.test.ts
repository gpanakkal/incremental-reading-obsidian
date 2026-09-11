import type { ReviewSession } from '#/lib/plugin-data';
import { resetSession, setPage, store, type ReviewPage } from '#/lib/store';
import type { ReviewItem } from '#/lib/types';
import IncrementalReadingPlugin from '#/main';
// The Vitest alias points `obsidian` at this same file, so the `Menu` built
// here is the one the plugin fills — importing it by path is what gives TS the
// stub's recorded `items`, which the real class does not expose.
import { Menu, type MenuItem } from '#/test/__mocks__/obsidian';
import ReviewView from '#/views/ReviewView';
import type { TFile, WorkspaceLeaf } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `main.ts` pulls the schema in as a raw `.sql` import, which Vite cannot parse
// as a module. Mocking it is the documented way around that — see
// `src/db/migrations.test.ts` — and the contents are irrelevant here, since
// nothing in this file opens a database.
vi.mock('./db/schema.sql', () => ({ default: '' }));

// #region HELPERS

/** The menu entries read only `path` off the file they were raised on. */
function makeFile(path = 'notes/Chapter 1.md'): TFile {
  return { path } as TFile;
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
} = {}) {
  const importArticle = vi.fn();
  const receiver = {
    settings: { showAdvancedImportMenuItems: advanced },
    // Truthy stands for a plugin that finished loading; the menu is suppressed
    // until then, since importing needs the manager.
    reviewManager: imported ? {} : undefined,
    app: { vault: { getFileByPath: vi.fn(() => file) } },
    importArticle,
  };
  return { receiver, importArticle, file };
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
  leaf?: WorkspaceLeaf
): Menu {
  const menu = new Menu();
  IncrementalReadingPlugin.prototype.addIRMenuItems.call(
    receiver as unknown as IncrementalReadingPlugin,
    menu as never,
    makeFile(),
    leaf
  );
  return menu;
}

/**
 * Entry titles, in the order they were added. Left at `MenuItem['title']`
 * rather than coerced: Obsidian allows a `DocumentFragment` there, and an
 * entry that grew one should fail the comparison rather than stringify into
 * something unreadable.
 */
function titles(menu: Menu): MenuItem['title'][] {
  return menu.items.map((item) => item.title);
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
  const saveSession = vi.fn(() => Promise.resolve());
  const getReviewItemFromId = vi.fn(() => Promise.resolve(item));
  const forget = vi.fn();
  const receiver = {
    data: { session },
    app: { loadLocalStorage: vi.fn(() => DEVICE), saveLocalStorage: vi.fn() },
    reviewManager: { getReviewItemFromId },
    sessionTracker:
      tracked === undefined ? undefined : { itemId: tracked, forget },
    saveSession,
  };
  return { receiver, saveSession, getReviewItemFromId, forget };
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
 * Bare receiver for `learn` with no review tab open, which is the branch that
 * picks the landing page. The store is the module's own, so the page it lands
 * on is read back from there.
 */
function makeLearnReceiver({
  resumed = false,
  skipHomeScreen = false,
}: { resumed?: boolean; skipHomeScreen?: boolean } = {}) {
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
    getOpenReviewLeaf: vi.fn(() => null),
    getActiveReviewView: vi.fn(() => null),
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
  initialItem?: ReviewItem
): Promise<void> {
  return IncrementalReadingPlugin.prototype.learn.call(
    receiver as unknown as IncrementalReadingPlugin,
    initialItem
  ) as Promise<void>;
}

/** Only the id is read off an item handed to `learn`. */
const item = (id: string) => ({ data: { id } }) as unknown as ReviewItem;

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IncrementalReadingPlugin.addIRMenuItems', () => {
  it('offers the import from a menu raised without a leaf', () => {
    // The file explorer's context menu passes none.
    const { receiver } = makeReceiver();

    const menu = raiseMenu(receiver);

    expect(titles(menu)).toContain('Import article');
    expect(menu.items[0]?.section).toBe('incremental-reading');
  });

  it("still offers the import from a plain note's own menu", () => {
    // The discriminator for the guard below: a note's ⋮ menu reports the same
    // `more-options` source the review tab's does, so only the leaf tells them
    // apart.
    const { receiver } = makeReceiver();

    const menu = raiseMenu(receiver, otherLeaf());

    expect(titles(menu)).toContain('Import article');
  });

  it('stays out of the review tab, where the note is already an item', () => {
    const { receiver } = makeReceiver();

    const menu = raiseMenu(receiver, reviewLeaf());

    expect(menu.items).toHaveLength(0);
  });

  it('keeps the advanced entries behind their setting', () => {
    const plain = makeReceiver({ advanced: false });
    const advanced = makeReceiver({ advanced: true });

    expect(titles(raiseMenu(plain.receiver))).toEqual(['Import article']);
    expect(titles(raiseMenu(advanced.receiver))).toEqual([
      'Import article',
      'Import a copy',
      'Import in place',
      'Open import dialog...',
      'Quick import',
    ]);
  });

  it('imports the note the menu was raised on', () => {
    const { receiver, importArticle, file } = makeReceiver();
    const menu = raiseMenu(receiver);

    click(menu.items[0]);

    expect(importArticle).toHaveBeenCalledWith(file);
  });

  it('says nothing about a path that resolves to no file', () => {
    // Folders reach the same event, and folder imports are not built yet.
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
    const { receiver, pageAtMount } = makeLearnReceiver({ skipHomeScreen: false });

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
    // `data.json`; resuming from the file would reopen what review just left.
    const { receiver, getReviewItemFromId } = makeResumeReceiver({
      session: { deviceId: DEVICE, itemId: 'item-1' },
      tracked: null,
    });

    await expect(resumeSession(receiver)).resolves.toBe(false);
    expect(store.getState().currentItemId).toBeNull();
    expect(getReviewItemFromId).not.toHaveBeenCalled();
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
    const { receiver, getReviewItemFromId } = makeResumeReceiver({
      tracked: 'item-1',
    });
    await resumeSession(receiver);
    getReviewItemFromId.mockClear();

    await expect(resumeSession(receiver)).resolves.toBe(false);
    expect(getReviewItemFromId).not.toHaveBeenCalled();
  });
});
