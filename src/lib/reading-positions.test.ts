// @vitest-environment jsdom
import type { ItemPositionRow } from '#/lib/items/ReviewManager';
import type { Plugin } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_ID_KEY } from './device-id';
import {
  createPositionStore,
  localPositionStorage,
  POSITIONS_KEY,
  registerPositionFlushes,
} from './reading-positions';

// #region HELPERS

/** An app whose localStorage is a map, as `loadLocalStorage` keys it per vault. */
function makeApp(initial: Record<string, unknown> = {}) {
  const stored = new Map(Object.entries(initial));
  return {
    stored,
    loadLocalStorage: vi.fn((key: string) => stored.get(key) ?? null),
    saveLocalStorage: vi.fn((key: string, value: unknown) => {
      if (value) stored.set(key, value);
      else stored.delete(key);
    }),
  };
}

function makeReviewManager(row: ItemPositionRow | null) {
  return {
    readPosition: vi.fn(async (_id: string) => row),
    writePosition: vi.fn(
      async (_id: string, _position: number, _row: ItemPositionRow) => {}
    ),
  };
}

function itemRow(overrides: Partial<ItemPositionRow> = {}): ItemPositionRow {
  return {
    table: 'article',
    position: 1,
    updatedAt: 0,
    updatedBy: 'someone',
    ...overrides,
  };
}

/** A document whose visibility the test sets. */
function makeDocument(): Document & { setHidden(hidden: boolean): void } {
  const doc = document.implementation.createHTMLDocument();
  let state: DocumentVisibilityState = 'visible';
  Object.defineProperty(doc, 'visibilityState', { get: () => state });
  return Object.assign(doc, {
    setHidden(hidden: boolean) {
      state = hidden ? 'hidden' : 'visible';
      doc.dispatchEvent(new Event('visibilitychange'));
    },
  });
}

/**
 * A plugin whose DOM events, workspace events and unload callbacks are
 * recorded, over a workspace with leaves in `leafDocs`.
 */
function makePlugin(leafDocs: Document[] = []) {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const unloads: (() => unknown)[] = [];
  const plugin = {
    app: {
      workspace: {
        on: vi.fn((name: string, handler: (...args: unknown[]) => void) => {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
          return { name };
        }),
        iterateAllLeaves: (visit: (leaf: unknown) => void) => {
          for (const doc of leafDocs) visit({ getContainer: () => ({ doc }) });
        },
      },
    },
    registerEvent: vi.fn(),
    register: vi.fn((callback: () => unknown) => unloads.push(callback)),
  };
  const fire = (name: string, ...args: unknown[]) => {
    for (const handler of handlers.get(name) ?? []) handler(...args);
  };
  return {
    plugin: plugin as unknown as Plugin,
    fire,
    unload: () => {
      for (const callback of unloads) callback();
    },
  };
}

function makeStore() {
  return {
    flushAll: vi.fn(() => Promise.resolve()),
    persist: vi.fn(),
  };
}

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('localPositionStorage', () => {
  it("keeps every entry under the plugin's one key, and drops the key for none", () => {
    const app = makeApp();
    const storage = localPositionStorage(app);
    const entries = { a: { position: 1, at: 2 } };
    storage.save(entries);
    expect(app.saveLocalStorage).toHaveBeenLastCalledWith(
      POSITIONS_KEY,
      entries
    );
    expect(storage.load()).toEqual(entries);
    expect(app.loadLocalStorage).toHaveBeenLastCalledWith(POSITIONS_KEY);

    storage.save(null);
    expect(app.saveLocalStorage).toHaveBeenLastCalledWith(POSITIONS_KEY, null);
    expect(app.stored.has(POSITIONS_KEY)).toBe(false);
  });
});

describe('createPositionStore', () => {
  it("restores from the review manager's row and writes back to it", async () => {
    const app = makeApp();
    const row = itemRow({ position: 7 });
    const reviewManager = makeReviewManager(row);
    const store = createPositionStore(app, reviewManager);

    const handle = store.open('a1');
    await expect(handle.restore()).resolves.toBe(7);
    handle.set(12);
    handle.close();
    await store.flushAll();

    expect(reviewManager.readPosition).toHaveBeenCalledWith('a1');
    expect(reviewManager.writePosition.mock.calls).toEqual([['a1', 12, row]]);
    expect(app.stored.has(POSITIONS_KEY)).toBe(false);
  });

  it("flushes what a killed app left in the vault's localStorage", async () => {
    const app = makeApp({ [POSITIONS_KEY]: { a1: { position: 40, at: 5 } } });
    const row = itemRow({ updatedAt: 9 });
    const reviewManager = makeReviewManager(row);
    // The row is newer than the entry, but this device changed it
    app.stored.set(DEVICE_ID_KEY, row.updatedBy);
    await createPositionStore(app, reviewManager).flushAll();

    expect(reviewManager.writePosition.mock.calls).toEqual([['a1', 40, row]]);
    expect(app.stored.has(POSITIONS_KEY)).toBe(false);
  });

  it('warns, rather than failing, when the database cannot be written', async () => {
    const app = makeApp({ [POSITIONS_KEY]: { a1: { position: 40, at: 5 } } });
    const reviewManager = makeReviewManager(itemRow());
    const error = new Error('disposed');
    reviewManager.writePosition.mockRejectedValue(error);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await createPositionStore(app, reviewManager).flushAll();

    expect(warn).toHaveBeenCalledWith(expect.any(String), error);
    expect(app.stored.has(POSITIONS_KEY)).toBe(true);
  });
});

describe('registerPositionFlushes', () => {
  it('flushes when the main document goes hidden, not when it shows again', () => {
    const store = makeStore();
    const { plugin } = makePlugin();
    let state: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
      () => state
    );
    registerPositionFlushes(plugin, store);

    state = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(store.flushAll).toHaveBeenCalledOnce();
    state = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(store.flushAll).toHaveBeenCalledOnce();
  });

  it('flushes when a popout window goes hidden, open before or after, watching each once', () => {
    const store = makeStore();
    const before = makeDocument();
    const after = makeDocument();
    // Two leaves in the one popout window
    const { plugin, fire } = makePlugin([before, before]);
    const listened = vi.spyOn(before, 'addEventListener');
    registerPositionFlushes(plugin, store);
    fire('window-open', { doc: after });

    before.setHidden(true);
    expect(store.flushAll).toHaveBeenCalledTimes(1);
    after.setHidden(true);
    expect(store.flushAll).toHaveBeenCalledTimes(2);
    expect(listened).toHaveBeenCalledOnce();
  });

  it('stops watching a popout once its window closes', () => {
    const store = makeStore();
    const popout = makeDocument();
    const other = makeDocument();
    const { plugin, fire } = makePlugin([popout, other]);
    registerPositionFlushes(plugin, store);
    fire('window-close', { doc: popout });

    popout.setHidden(true);
    expect(store.flushAll).not.toHaveBeenCalled();
    other.setHidden(true);
    expect(store.flushAll).toHaveBeenCalledOnce();
  });

  it("hands the app's quit a flush to wait for, settled in a task after it", async () => {
    let finish!: () => void;
    const store = makeStore();
    store.flushAll.mockReturnValue(
      new Promise<void>((resolve) => (finish = resolve))
    );
    const { plugin, fire } = makePlugin();
    registerPositionFlushes(plugin, store);
    const addPromise = vi.fn();
    fire('quit', { addPromise });
    expect(store.flushAll).toHaveBeenCalledOnce();
    expect(addPromise).toHaveBeenCalledOnce();
    const handed = addPromise.mock.calls[0][0] as Promise<void>;
    let settled = false;
    void handed.then(() => {
      settled = true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    finish();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(settled).toBe(false);
    await handed;
    expect(settled).toBe(true);
  });

  it('writes waiting moves to localStorage at unload', () => {
    const store = makeStore();
    const { plugin, unload } = makePlugin();
    registerPositionFlushes(plugin, store);
    expect(store.persist).not.toHaveBeenCalled();
    unload();
    expect(store.persist).toHaveBeenCalledOnce();
    expect(store.flushAll).not.toHaveBeenCalled();
  });

  it.each([
    ['the main document', () => document],
    ['a popout', (popout: Document) => popout],
  ])(
    'writes waiting moves to localStorage, not the database, when %s goes hidden as the page goes away',
    (_, hiddenDoc) => {
      const store = makeStore();
      const popout = makeDocument();
      const { plugin } = makePlugin([popout]);
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      registerPositionFlushes(plugin, store);

      window.dispatchEvent(new Event('pagehide'));
      expect(store.persist).toHaveBeenCalledOnce();
      const doc = hiddenDoc(popout);
      if (doc === document) doc.dispatchEvent(new Event('visibilitychange'));
      else popout.setHidden(true);
      expect(store.flushAll).not.toHaveBeenCalled();
    }
  );

  it('flushes on hiding again once a page that went away comes back', () => {
    const store = makeStore();
    const { plugin } = makePlugin();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    registerPositionFlushes(plugin, store);

    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pageshow'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(store.flushAll).toHaveBeenCalledOnce();
  });

  it('stops listening for the page going away at unload', () => {
    const store = makeStore();
    const { plugin, unload } = makePlugin();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    registerPositionFlushes(plugin, store);
    unload();
    store.persist.mockClear();

    window.dispatchEvent(new Event('pagehide'));
    expect(store.persist).not.toHaveBeenCalled();
  });

  it('stops watching every document at unload', () => {
    const store = makeStore();
    const popout = makeDocument();
    const { plugin, unload } = makePlugin([popout]);
    registerPositionFlushes(plugin, store);
    unload();

    popout.setHidden(true);
    expect(store.flushAll).not.toHaveBeenCalled();
  });
});
