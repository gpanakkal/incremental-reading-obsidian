import type ReviewManager from '#/lib/items/ReviewManager';
import type { ItemPositionRow } from '#/lib/items/ReviewManager';
import type { App, Plugin } from 'obsidian';
import { getDeviceId } from './device-id';
import { type PositionStorage, PositionStore } from './position-store';
import { addQuitTask } from './quit-task';

/** The localStorage key, per vault, of every item's device-tier position. */
export const POSITIONS_KEY = 'incremental-reading-positions';

type LocalStorageApp = Pick<App, 'loadLocalStorage' | 'saveLocalStorage'>;

/**
 * The device tier in localStorage, as {@link getDeviceId} keeps the device
 * id: `loadLocalStorage` keys by the vault's `appId` (an undocumented field
 * of `App`), so two vaults on one device keep apart, and nothing travels with
 * the vault to other devices. Every item shares the one key, so the entries
 * left by a killed app can be found at load without walking localStorage for
 * keys in Obsidian's private format. `saveLocalStorage` drops the key for
 * `null`.
 */
export function localPositionStorage(app: LocalStorageApp): PositionStorage {
  return {
    load: () => app.loadLocalStorage(POSITIONS_KEY),
    save: (entries) => app.saveLocalStorage(POSITIONS_KEY, entries),
  };
}

/** The reading position store over `app`'s localStorage and `reviewManager`'s rows. */
export function createPositionStore(
  app: LocalStorageApp,
  reviewManager: Pick<ReviewManager, 'readPosition' | 'writePosition'>
): PositionStore<ItemPositionRow> {
  return new PositionStore<ItemPositionRow>({
    storage: localPositionStorage(app),
    rows: {
      read: (id) => reviewManager.readPosition(id),
      write: (id, position, row) =>
        reviewManager.writePosition(id, position, row),
    },
    deviceId: () => getDeviceId(app),
    onError: (error) => {
      console.warn('Incremental Reading: reading position not saved', error);
    },
  });
}

/**
 * Write `store` to the database whenever the app may be about to go away
 * without closing its tabs: a window's document going hidden (iOS and Android
 * background the app this way, and may kill it after), and the app quitting.
 * At unload, the moves still waiting in memory go to localStorage, for the
 * flush at the next load: the database refuses writes by then.
 */
export function registerPositionFlushes(
  plugin: Plugin,
  store: Pick<PositionStore, 'flushAll' | 'persist'>
): void {
  const { workspace } = plugin.app;
  /** Each watched document, and how to stop watching it. */
  const watched = new Map<Document, () => void>();
  const watch = (doc: Document) => {
    if (watched.has(doc)) return;
    const changed = () => {
      if (doc.visibilityState === 'hidden') void store.flushAll();
    };
    doc.addEventListener('visibilitychange', changed);
    watched.set(doc, () =>
      doc.removeEventListener('visibilitychange', changed)
    );
  };
  // A closed popout's document is let go of, not held until unload
  const unwatch = (doc: Document) => {
    watched.get(doc)?.();
    watched.delete(doc);
  };

  watch(document);
  // Popout windows open before this ran, then each one opened after
  workspace.iterateAllLeaves((leaf) => watch(leaf.getContainer().doc));
  plugin.registerEvent(workspace.on('window-open', (win) => watch(win.doc)));
  plugin.registerEvent(workspace.on('window-close', (win) => unwatch(win.doc)));
  plugin.register(() => {
    for (const doc of [...watched.keys()]) unwatch(doc);
  });
  plugin.registerEvent(
    workspace.on('quit', (tasks) => addQuitTask(tasks, store.flushAll()))
  );
  plugin.register(() => store.persist());
}
