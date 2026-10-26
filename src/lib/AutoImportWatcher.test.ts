// @vitest-environment jsdom

import { describeFailures } from '#/lib/bulk-import/run-import';
import type { BulkOutcome } from '#/lib/bulk-import/types';
import { configureSuccessNotices } from './notices';
// The mock the vitest config aliases `obsidian` to, imported by path so its
// recorded notices are visible to the type checker
import { Notice } from '#/test/__mocks__/obsidian';
import {
  showSuccessNotices,
  SUCCESS_NOTICE_LEVELS,
} from '#/test/success-notices';
import * as fc from 'fast-check';
import {
  TFile,
  TFolder,
  type CachedMetadata,
  type TAbstractFile,
} from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutoImportWatcher,
  type AutoImportConfig,
  type AutoImportEntry,
} from './AutoImportWatcher';
import {
  AUTO_IMPORT_DEBOUNCE_MS,
  AUTO_IMPORT_MAX_WAIT_MS,
  AUTO_IMPORT_SYNC_PATIENCE_MS,
  AUTO_IMPORT_SYNC_POLL_MS,
  AUTO_IMPORT_TAG,
  AUTO_IMPORT_WATERMARK_SLACK_MS,
  CARD_TAG,
  DATA_DIRECTORY,
  SNIPPET_TAG,
} from './constants';
import type { SyncGate } from './obsidian-sync';
import {
  AUTO_IMPORT_WATERMARK_KEY,
  loadAutoImportWatermark,
  saveAutoImportWatermark,
} from './plugin-data';
import {
  loadWatchedFolderLedger,
  saveWatchedFolderLedger,
  WATCHED_FOLDER_LEDGER_KEY,
} from './watched-folder-ledger';

// #region HELPERS

const TRIGGER = AUTO_IMPORT_TAG;

/** A watched folder. */
const INBOX = 'Inbox';

/** Watching no folders, as the tests of trigger tags alone do. */
const NO_FOLDERS = { onFolder: false, folders: [] };

/**
 * A vault the watcher reads files and their cached metadata from, the ids its
 * database holds rows for, deleted or not, and the device's localStorage.
 */
function makeVault() {
  const files = new Map<string, TFile>();
  const caches = new Map<TFile, CachedMetadata | null>();
  const storage = new Map<string, unknown>();
  return {
    rows: new Set<string>(),
    storage,
    app: {
      // As Obsidian's: null for a key never stored
      loadLocalStorage: (key: string): unknown => storage.get(key) ?? null,
      saveLocalStorage: (key: string, data: unknown) => {
        storage.set(key, data);
      },
      vault: {
        getFileByPath: (path: string) => files.get(path) ?? null,
        // As Obsidian's: every file, folders not included, in no set order
        getFiles: () => [...files.values()],
        // As Obsidian's: the files whose extension is `md`, in no set order
        getMarkdownFiles: () =>
          [...files.values()].filter(({ extension }) => extension === 'md'),
      },
      metadataCache: {
        getFileCache: (file: TFile) => caches.get(file) ?? null,
      },
    },
    /**
     * A file at `path`, a note unless `extension` says otherwise, its
     * frontmatter `frontmatter`; none when undefined. Last written `mtime`,
     * now unless said otherwise.
     */
    add: (
      path: string,
      frontmatter?: Record<string, unknown>,
      extension = 'md',
      mtime = Date.now()
    ) => {
      const file = Object.assign(new TFile(), {
        path,
        extension,
        stat: { ctime: mtime, mtime, size: 1 },
      });
      files.set(path, file);
      caches.set(file, frontmatter === undefined ? {} : { frontmatter });
      return file;
    },
    /**
     * Re-index `file` with `frontmatter`, none when undefined, its text now
     * `size` bytes long, written when it last was.
     */
    edit: (file: TFile, frontmatter?: Record<string, unknown>, size = 1) => {
      file.stat = { ...file.stat, size };
      caches.set(file, frontmatter === undefined ? {} : { frontmatter });
    },
    /**
     * A file at `path` the metadata cache hasn't read: a note just created, or
     * a file of any other kind, which it never reads.
     */
    create: (path: string) => {
      const extension = path.slice(path.lastIndexOf('.') + 1);
      const file = Object.assign(new TFile(), {
        path,
        extension,
        stat: { ctime: 0, mtime: 0, size: 0 },
      });
      files.set(path, file);
      return file;
    },
    /** Forget what the cache read of `file`. */
    unindex: (file: TFile) => {
      caches.delete(file);
    },
    cacheOf: (file: TFile) => caches.get(file) ?? null,
    remove: (file: TFile) => {
      files.delete(file.path);
    },
    rename: (file: TFile, path: string) => {
      files.delete(file.path);
      file.path = path;
      files.set(path, file);
    },
  };
}

type Vault = ReturnType<typeof makeVault>;

/**
 * Imports as the plugin does, unless `outcome` says otherwise for a file: a row
 * is made, the note gains its id as `ir-id` and the article tag, and the cache
 * sees it at once.
 */
function makeImporter(
  vault: Vault,
  outcome: (file: TFile) => Omit<BulkOutcome, 'file'> = () => ({
    status: 'imported',
  })
) {
  return vi.fn(
    (entries: readonly AutoImportEntry[], _config: AutoImportConfig) =>
      Promise.resolve(
        entries.map(({ file }): BulkOutcome => {
          const result = { file, ...outcome(file) };
          if (result.status === 'imported') {
            const frontmatter: Record<string, unknown> =
              vault.cacheOf(file)?.frontmatter ?? {};
            const id = `id-${file.path}`;
            vault.rows.add(id);
            vault.edit(file, {
              ...frontmatter,
              'ir-id': id,
              tags: [...[frontmatter.tags].flat(), 'ir-article'],
            });
          }
          return result;
        })
      )
  );
}

/**
 * Imports as the plugin does a PDF, where it is: a row is written, but nothing
 * on the file shows it, so only the ledger keeps it from being found again.
 */
function makeMarklessImporter(vault: Vault) {
  return vi.fn(
    (entries: readonly AutoImportEntry[], _config: AutoImportConfig) =>
      Promise.resolve(
        entries.map(({ file }): BulkOutcome => {
          vault.rows.add(`id-${file.path}`);
          return { file, status: 'imported' };
        })
      )
  );
}

/** Answers whether `vault`'s database holds a row with the id asked of it. */
const makeRowLookup = (vault: Vault) =>
  vi.fn((id: string) => Promise.resolve(vault.rows.has(id)));

/**
 * A started watcher over `vault`, a fresh one unless given, with the config it
 * reads changeable, importing through what `makeImport` makes.
 */
function makeWatcher(
  config: Partial<AutoImportConfig> = {},
  vault = makeVault(),
  makeImport: typeof makeImporter = makeImporter
) {
  let current: AutoImportConfig = {
    enabled: true,
    triggerTags: [TRIGGER],
    priority: 30,
    ...NO_FOLDERS,
    ...config,
  };
  const importMany = makeImport(vault);
  const hasRow = makeRowLookup(vault);
  /** The ids whose row's note lost its article tag (see `needsRepair`). */
  const repairable = new Set<string>();
  const needsRepair = vi.fn((id: string, _file: TFile) =>
    Promise.resolve(repairable.has(id))
  );
  let gate: SyncGate = 'open';
  const onSyncWait = vi.fn((_waiting: number) => undefined);
  /** What the watcher listens to of Sync: its recheck while it does. */
  const syncWatch = {
    recheck: null as (() => void) | null,
    starts: 0,
    stops: 0,
  };
  const watchSync = (recheck: () => void) => {
    syncWatch.starts++;
    syncWatch.recheck = recheck;
    return () => {
      syncWatch.stops++;
      syncWatch.recheck = null;
    };
  };
  let databaseReady = true;
  const settleDatabase = vi.fn(() => Promise.resolve(databaseReady));
  const watcher = new AutoImportWatcher({
    app: vault.app,
    getConfig: () => current,
    importMany,
    hasRow,
    needsRepair,
    syncGate: () => gate,
    watchSync,
    onSyncWait,
    settleDatabase,
  });
  const stop = watcher.start();
  return {
    vault,
    watcher,
    importMany,
    hasRow,
    needsRepair,
    repairable,
    stop,
    /** Told how many notes wait for Sync, each time that changes. */
    onSyncWait,
    /** Have Sync stand as `next` says from now on. */
    setGate: (next: SyncGate) => {
      gate = next;
    },
    /** How often the watcher began and stopped listening to Sync. */
    syncWatch,
    /** Have Sync tell of a change, as its `'status-change'` does. */
    syncChanged: () => syncWatch.recheck?.(),
    /** Asked before importing a note whose `ir-id` no row holds. */
    settleDatabase,
    /** Have the database settle ready, or not, from now on. */
    setDatabaseReady: (ready: boolean) => {
      databaseReady = ready;
    },
    /** Change the settings, telling the watcher as the plugin does. */
    configure: (change: Partial<AutoImportConfig>) => {
      current = { ...current, ...change };
      watcher.configChanged();
    },
    /**
     * Change the settings without telling the watcher yet, as writing to them
     * by hand does until it saves them.
     */
    rewrite: (change: Partial<AutoImportConfig>) => {
      current = { ...current, ...change };
    },
    /** Tell the watcher `file` was re-indexed as its cache now stands. */
    change: (file: TFile) => {
      watcher.consider(file, vault.cacheOf(file));
    },
    /** Tell the watcher `file` was created where it is. */
    arrive: (file: TAbstractFile) => {
      watcher.noteArrival(file);
    },
    /** Move `file` to `path`, and tell the watcher. */
    move: (file: TFile, path: string) => {
      const oldPath = file.path;
      vault.rename(file, path);
      watcher.noteArrival(file, oldPath);
    },
  };
}

/** The files each import was handed, by path, one list per call. */
const importedPaths = (importMany: ReturnType<typeof makeImporter>) =>
  importMany.mock.calls.map(([entries]) =>
    entries.map(({ file }) => file.path)
  );

/** Run the clock out past any wait the watcher could be in. */
const settle = () => vi.advanceTimersByTimeAsync(AUTO_IMPORT_MAX_WAIT_MS);

/** A promise and the function that resolves it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * What a note can carry as its `ir-id`. YAML can put anything under the key, a
 * blank or a zero included; a string is an id, which a row may or may not hold.
 */
const irIdArb = fc.oneof(
  fc.constantFrom(undefined, null, '', 0, false),
  fc.string(),
  fc.anything()
);

/**
 * A note's state as the watcher can find it. `tags` are drawn from trigger,
 * blocked and other tags, written any way Obsidian reads them.
 */
const noteArb = fc.record({
  enabled: fc.boolean(),
  hasFrontmatter: fc.boolean(),
  irId: irIdArb,
  /** Whether a row holds `irId`, when that is an id at all. */
  rowHeld: fc.boolean(),
  tags: fc.subarray([
    TRIGGER,
    '#Second-Trigger',
    SNIPPET_TAG,
    'Other',
    CARD_TAG,
  ]),
  failedBefore: fc.boolean(),
});

type NoteState = Omit<
  typeof noteArb extends fc.Arbitrary<infer T> ? T : never,
  'enabled'
>;

/**
 * Whether a note in `note`'s state is one to import, the watcher on and
 * looking for {@link TRIGGER} and `second-trigger`, where `heldIds` are the
 * ids rows hold.
 */
const callsForImport = (note: NoteState, heldIds: ReadonlySet<string>) =>
  note.hasFrontmatter &&
  !(typeof note.irId === 'string' && heldIds.has(note.irId)) &&
  note.tags.some((tag) => tag === TRIGGER || tag === '#Second-Trigger') &&
  !note.tags.includes(SNIPPET_TAG) &&
  !note.tags.includes(CARD_TAG) &&
  !note.failedBefore;

/** The moment the watcher last saw every change, as `vault` stores it. */
const seenAt = (vault: Vault) => loadAutoImportWatermark(vault.app);

/** The notice for `count` imports, matched by its count and plural only. */
const importedNotice = (count: number): unknown =>
  expect.stringMatching(
    new RegExp(`\\b${count} article${count === 1 ? '' : 's'}\\b`)
  ) as unknown;

/** The ledger of watched folders `vault` stores, or null. */
const ledgerOf = (vault: Vault) => loadWatchedFolderLedger(vault.app);

/** The paths the ledger `vault` stores has seen, in no order. */
const seenPaths = (vault: Vault) => new Set(ledgerOf(vault)?.paths);

/** Store a ledger in `vault`, as an earlier launch left it. */
const storeLedger = (vault: Vault, folders: string[], paths: string[]) => {
  saveWatchedFolderLedger(vault.app, { folders, paths });
};

/** How many times `store`, spying on `saveLocalStorage`, stored the ledger. */
const ledgerWrites = (store: { mock: { calls: readonly unknown[][] } }) =>
  store.mock.calls.filter(([key]) => key === WATCHED_FOLDER_LEDGER_KEY).length;

/**
 * The plugin started over `vault`: a watcher made as {@link makeWatcher} makes
 * one, caught up as at startup.
 */
async function launch(
  config: Partial<AutoImportConfig>,
  vault: Vault,
  makeImport?: typeof makeImporter
) {
  const watching = makeWatcher(config, vault, makeImport);
  await watching.watcher.runCatchUpScan();
  return watching;
}

// #endregion

beforeEach(() => {
  vi.useFakeTimers();
  Notice.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  configureSuccessNotices(null);
});

describe('AutoImportWatcher.consider', () => {
  it('imports a note only while on, with frontmatter carrying a trigger tag, no snippet or card tag and no ir-id a row holds, that has not failed', async () => {
    await fc.assert(
      fc.asyncProperty(noteArb, async (note) => {
        const { vault, change, importMany, configure, stop } = makeWatcher({
          triggerTags: [TRIGGER, 'second-trigger'],
        });
        if (typeof note.irId === 'string' && note.rowHeld) {
          vault.rows.add(note.irId);
        }
        const file = vault.add('notes/a.md', { tags: ['Other'] });
        if (note.failedBefore) {
          importMany.mockResolvedValueOnce([
            { file, status: 'failed', reason: 'broken' },
          ]);
          vault.edit(file, { tags: [TRIGGER] });
          change(file);
          await settle();
          importMany.mockClear();
        }
        configure({ enabled: note.enabled });
        vault.edit(
          file,
          note.hasFrontmatter
            ? { 'ir-id': note.irId, tags: note.tags }
            : undefined
        );

        change(file);
        await settle();

        const wanted =
          note.enabled &&
          note.hasFrontmatter &&
          !(typeof note.irId === 'string' && note.rowHeld) &&
          note.tags.some(
            (tag) => tag === TRIGGER || tag === '#Second-Trigger'
          ) &&
          !note.tags.includes(SNIPPET_TAG) &&
          !note.tags.includes(CARD_TAG) &&
          !note.failedBefore;
        expect(importedPaths(importMany)).toEqual(
          wanted ? [['notes/a.md']] : []
        );
        stop();
      })
    );
  });

  it('imports nothing while turned off', async () => {
    const { vault, change, importMany } = makeWatcher({ enabled: false });
    change(vault.add('a.md', { tags: TRIGGER }));

    await settle();

    expect(importMany).not.toHaveBeenCalled();
  });

  it('imports nothing without frontmatter, or without a cache at all', async () => {
    const { vault, watcher, change, importMany } = makeWatcher();
    change(vault.add('a.md'));
    watcher.consider(vault.add('b.md', { tags: TRIGGER }), null);

    await settle();

    expect(importMany).not.toHaveBeenCalled();
  });

  it('never imports a note whose ir-id a row holds, however often it changes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.array(fc.constantFrom('change', 'settle', 'flush'), {
          maxLength: 8,
        }),
        async (id, steps) => {
          const { vault, watcher, change, importMany, stop } = makeWatcher();
          // Deleted or not, the row is the note's: importing would make it anew
          vault.rows.add(id);
          const file = vault.add('a.md', { 'ir-id': id, tags: TRIGGER });

          for (const step of [...steps, 'change', 'settle'] as const) {
            if (step === 'change') change(file);
            else if (step === 'settle') await settle();
            else await watcher.flushNow();
          }

          expect(importMany).not.toHaveBeenCalled();
          stop();
        }
      )
    );
  });

  it('imports a note whose ir-id no row holds once, handing the import the note itself to take over', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.integer({ min: 1, max: 4 }),
        async (orphanId, changes) => {
          const { vault, change, importMany, stop } = makeWatcher();
          const file = vault.add('a.md', { 'ir-id': orphanId, tags: TRIGGER });

          // Changed again after the import, as its own write-back does
          for (let i = 0; i < changes; i++) {
            change(file);
            await settle();
          }

          expect(importMany).toHaveBeenCalledOnce();
          expect(importMany.mock.calls[0][0]).toEqual([
            { file, matchedTags: [TRIGGER] },
          ]);
          stop();
        }
      )
    );
  });

  it('looks a note up by ir-id only when it carries one as a string, again once the database settles for one no row holds, importing those no row holds', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ irId: irIdArb, rowHeld: fc.boolean() }), {
          minLength: 1,
          maxLength: 6,
        }),
        async (notes) => {
          const { vault, change, importMany, hasRow, stop } = makeWatcher();
          for (const { irId, rowHeld } of notes) {
            if (typeof irId === 'string' && rowHeld) vault.rows.add(irId);
          }
          const files = notes.map(({ irId }, i) =>
            vault.add(`note ${i}.md`, { 'ir-id': irId, tags: TRIGGER })
          );
          for (const file of files) change(file);

          await settle();

          const ids = notes
            .map(({ irId }) => irId)
            .filter((irId): irId is string => typeof irId === 'string');
          expect(hasRow.mock.calls.map(([id]) => id)).toEqual(
            ids.flatMap((id) => (vault.rows.has(id) ? [id] : [id, id]))
          );
          const wanted = files.filter((_, i) => {
            const { irId } = notes[i];
            return !(typeof irId === 'string' && vault.rows.has(irId));
          });
          expect(importedPaths(importMany)).toEqual(
            wanted.length === 0 ? [] : [wanted.map(({ path }) => path)]
          );
          stop();
        }
      )
    );
  });

  // 0228: as the import command repairs such a note rather than refusing it
  it('imports a note whose ir-id a row holds only when it is the note of that row and lost its article tag, asking only of those', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ rowHeld: fc.boolean(), lostTag: fc.boolean() }), {
          minLength: 1,
          maxLength: 6,
        }),
        async (notes) => {
          const { vault, change, importMany, needsRepair, repairable, stop } =
            makeWatcher();
          const files = notes.map(({ rowHeld, lostTag }, i) => {
            if (rowHeld) vault.rows.add(`id-${i}`);
            if (lostTag) repairable.add(`id-${i}`);
            return vault.add(`note ${i}.md`, {
              'ir-id': `id-${i}`,
              tags: TRIGGER,
            });
          });
          for (const file of files) change(file);

          await settle();

          expect(needsRepair.mock.calls).toEqual(
            files.flatMap((file, i) =>
              notes[i].rowHeld ? [[`id-${i}`, file]] : []
            )
          );
          const wanted = files.filter(
            (_, i) => !notes[i].rowHeld || notes[i].lostTag
          );
          expect(importedPaths(importMany)).toEqual(
            wanted.length === 0 ? [] : [wanted.map(({ path }) => path)]
          );
          stop();
        }
      )
    );
  });

  it('leaves a note whose row holds its ir-id alone when asking whether it lost its tag throws, saying why in the console', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { vault, change, importMany, needsRepair } = makeWatcher();
    vault.rows.add('held');
    needsRepair.mockRejectedValueOnce(new Error('database closed'));
    change(vault.add('held.md', { 'ir-id': 'held', tags: TRIGGER }));

    await settle();

    expect(importMany).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('"held"'),
      new Error('database closed')
    );
  });

  it('imports nothing without a trigger tag', async () => {
    const { vault, change, importMany } = makeWatcher();
    change(vault.add('a.md', { tags: ['reading', 'ir-imports'] }));

    await settle();

    expect(importMany).not.toHaveBeenCalled();
  });

  it('imports nothing carrying a snippet or card tag', async () => {
    const { vault, change, importMany } = makeWatcher();
    change(vault.add('a.md', { tags: [TRIGGER, SNIPPET_TAG] }));
    change(
      vault.add('b.md', { tags: [TRIGGER, `#${CARD_TAG.toUpperCase()}`] })
    );

    await settle();

    expect(importMany).not.toHaveBeenCalled();
  });

  it('reads the trigger tag from frontmatter however it is written', async () => {
    const { vault, change, importMany } = makeWatcher();
    change(vault.add('a.md', { tags: `#${TRIGGER.toUpperCase()}` }));
    change(vault.add('b.md', { tag: `reading, ${TRIGGER}` }));

    await settle();

    expect(importedPaths(importMany)).toEqual([['a.md', 'b.md']]);
  });

  it('imports a note carrying any of several trigger tags, handing on the ones it carries', async () => {
    const { vault, change, importMany } = makeWatcher({
      triggerTags: [TRIGGER, 'to-read', 'clipped'],
    });
    const one = vault.add('one.md', { tags: ['to-read'] });
    const both = vault.add('both.md', { tags: ['clipped', 'other', TRIGGER] });
    change(one);
    change(both);

    await settle();

    expect(importMany.mock.calls[0][0]).toEqual([
      { file: one, matchedTags: ['to-read'] },
      { file: both, matchedTags: [TRIGGER, 'clipped'] },
    ]);
  });

  it("looks up the ir-id the plugin's own import writes back once, and imports nothing more", async () => {
    const { vault, change, importMany, hasRow } = makeWatcher();
    const file = vault.add('a.md', { tags: TRIGGER });
    change(file);
    await settle();
    expect(importMany).toHaveBeenCalledOnce();
    expect(hasRow).not.toHaveBeenCalled();

    // The write-back, as the metadata cache tells of it
    change(file);
    await settle();

    expect(hasRow).toHaveBeenCalledExactlyOnceWith('id-a.md');
    expect(importMany).toHaveBeenCalledOnce();
  });

  it('takes every note whose ir-id a row holds for an article when not told how to tell one that lost its tag', async () => {
    const vault = makeVault();
    const importMany = makeImporter(vault);
    const watcher = new AutoImportWatcher({
      app: vault.app,
      getConfig: () => ({
        enabled: true,
        triggerTags: [TRIGGER],
        priority: 1,
        mode: 'inPlace',
        ...NO_FOLDERS,
      }),
      importMany,
      hasRow: makeRowLookup(vault),
    });
    const stop = watcher.start();
    vault.rows.add('held');
    const file = vault.add('a.md', { 'ir-id': 'held', tags: TRIGGER });

    watcher.consider(file, vault.cacheOf(file));
    await settle();

    expect(importMany).not.toHaveBeenCalled();
    stop();
  });

  it('imports nothing before it starts or after it stops', async () => {
    const vault = makeVault();
    const importMany = makeImporter(vault);
    const watcher = new AutoImportWatcher({
      app: vault.app,
      getConfig: () => ({
        enabled: true,
        triggerTags: [TRIGGER],
        priority: 1,
        ...NO_FOLDERS,
      }),
      importMany,
      hasRow: makeRowLookup(vault),
    });
    const file = vault.add('a.md', { tags: TRIGGER });

    watcher.consider(file, vault.cacheOf(file));
    await settle();
    expect(importMany).not.toHaveBeenCalled();

    const stop = watcher.start();
    stop();
    watcher.consider(file, vault.cacheOf(file));
    await settle();
    expect(importMany).not.toHaveBeenCalled();
  });
});

describe('AutoImportWatcher batching', () => {
  it('waits for changes to stop for the debounce time, then imports them together, once each', async () => {
    const { vault, change, importMany } = makeWatcher();
    const a = vault.add('a.md', { tags: TRIGGER });
    const b = vault.add('b.md', { tags: TRIGGER });

    change(a);
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS - 1);
    change(b);
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS - 1);
    change(a);
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS - 1);
    expect(importMany).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(importedPaths(importMany)).toEqual([['a.md', 'b.md']]);
  });

  it('imports a stream of changes that never pauses once the oldest has waited the longest it may', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: 10_000 }),
        fc.array(fc.integer({ min: 0, max: AUTO_IMPORT_DEBOUNCE_MS - 1 }), {
          maxLength: 12,
        }),
        async (before, gaps) => {
          const { vault, change, importMany, stop } = makeWatcher();
          await vi.advanceTimersByTimeAsync(before);
          const first = Date.now();
          change(vault.add('note.md', { tags: TRIGGER }));
          let last = first;
          // Each change comes before the batch would have been imported
          for (const [i, gap] of gaps.entries()) {
            if (last + gap >= first + AUTO_IMPORT_MAX_WAIT_MS) break;
            await vi.advanceTimersByTimeAsync(gap);
            last = Date.now();
            change(vault.add(`note ${i}.md`, { tags: TRIGGER }));
          }
          const due = Math.min(
            last + AUTO_IMPORT_DEBOUNCE_MS,
            first + AUTO_IMPORT_MAX_WAIT_MS
          );

          await vi.advanceTimersByTimeAsync(due - Date.now() - 1);
          expect(importMany).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          expect(importMany).toHaveBeenCalledOnce();
          stop();
        }
      ),
      {
        // A stream that outlasts the longest wait, which random gaps seldom do
        examples: [
          [0, Array.from({ length: 12 }, () => AUTO_IMPORT_DEBOUNCE_MS - 1)],
        ],
      }
    );
  });

  it('starts the longest wait over for changes after a flush', async () => {
    const { vault, change, importMany } = makeWatcher();
    change(vault.add('a.md', { tags: TRIGGER }));
    await settle();
    expect(importMany).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(10_000);
    change(vault.add('b.md', { tags: TRIGGER }));
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS - 1);
    expect(importMany).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(importedPaths(importMany)).toEqual([['a.md'], ['b.md']]);
  });

  it('imports at once when flushed, and not again when the wait would have ended', async () => {
    const { vault, watcher, change, importMany } = makeWatcher();
    change(vault.add('a.md', { tags: TRIGGER }));

    await watcher.flushNow();
    expect(importedPaths(importMany)).toEqual([['a.md']]);

    await settle();
    expect(importMany).toHaveBeenCalledOnce();
  });

  it('imports nothing when flushed with nothing waiting', async () => {
    const { watcher, importMany } = makeWatcher();

    await watcher.flushNow();

    expect(importMany).not.toHaveBeenCalled();
  });

  it('drops what is waiting when stopped', async () => {
    const { vault, change, importMany, stop } = makeWatcher();
    change(vault.add('a.md', { tags: TRIGGER }));

    stop();
    await settle();

    expect(importMany).not.toHaveBeenCalled();
  });

  it('hands the import the config as it is when the batch is imported', async () => {
    const { vault, change, importMany, configure } = makeWatcher({
      priority: 10,
    });
    change(vault.add('a.md', { tags: TRIGGER }));
    configure({ priority: 42 });

    await settle();

    expect(importMany.mock.calls[0][1]).toMatchObject({ priority: 42 });
  });
});

describe('AutoImportWatcher at flush', () => {
  it('drops a note deleted while it waited', async () => {
    const { vault, change, importMany } = makeWatcher();
    const gone = vault.add('gone.md', { tags: TRIGGER });
    change(gone);
    change(vault.add('kept.md', { tags: TRIGGER }));
    vault.remove(gone);

    await settle();

    expect(importedPaths(importMany)).toEqual([['kept.md']]);
  });

  it('drops a note replaced at its path by another file while it waited', async () => {
    const { vault, change, importMany } = makeWatcher();
    const replaced = vault.add('a.md', { tags: TRIGGER });
    change(replaced);
    vault.remove(replaced);
    vault.add('a.md', { tags: TRIGGER });

    await settle();

    expect(importMany).not.toHaveBeenCalled();
  });

  it('imports a note renamed while it waited, where it now is', async () => {
    const { vault, change, importMany } = makeWatcher();
    const file = vault.add('inbox/a.md', { tags: TRIGGER });
    change(file);
    vault.rename(file, 'reading/a.md');

    await settle();

    expect(importedPaths(importMany)).toEqual([['reading/a.md']]);
  });

  it('drops a note that lost its trigger tag, gained an ir-id a row holds or a snippet tag while it waited', async () => {
    const { vault, change, importMany } = makeWatcher();
    const untagged = vault.add('untagged.md', { tags: TRIGGER });
    const imported = vault.add('imported.md', { tags: TRIGGER });
    const snippet = vault.add('snippet.md', { tags: TRIGGER });
    const kept = vault.add('kept.md', { tags: TRIGGER });
    for (const file of [untagged, imported, snippet, kept]) change(file);
    vault.edit(untagged, { tags: ['other'] });
    vault.rows.add('abc');
    vault.edit(imported, { tags: TRIGGER, 'ir-id': 'abc' });
    vault.edit(snippet, { tags: [TRIGGER, SNIPPET_TAG] });

    await settle();

    expect(importedPaths(importMany)).toEqual([['kept.md']]);
  });

  it('drops a note whose frontmatter went while it waited', async () => {
    const { vault, change, importMany } = makeWatcher();
    const file = vault.add('a.md', { tags: TRIGGER });
    change(file);
    vault.edit(file);

    await settle();

    expect(importMany).not.toHaveBeenCalled();
  });

  it('drops everything waiting when turned off before the flush', async () => {
    const { vault, change, importMany, configure } = makeWatcher();
    change(vault.add('a.md', { tags: TRIGGER }));
    configure({ enabled: false });

    await settle();

    expect(importMany).not.toHaveBeenCalled();
  });

  it('matches against the trigger tags as they are at the flush', async () => {
    const { vault, change, importMany, configure } = makeWatcher({
      triggerTags: [TRIGGER, 'later'],
    });
    const dropped = vault.add('a.md', { tags: TRIGGER });
    const kept = vault.add('b.md', { tags: [TRIGGER, 'later'] });
    change(dropped);
    change(kept);
    configure({ triggerTags: ['later'] });

    await settle();

    expect(importMany.mock.calls[0][0]).toEqual([
      { file: kept, matchedTags: ['later'] },
    ]);
  });

  it('runs one import at a time, checking each batch only once the one before it is done', async () => {
    const { vault, change, importMany } = makeWatcher();
    const first = deferred<BulkOutcome[]>();
    const a = vault.add('a.md', { tags: TRIGGER });
    importMany.mockImplementationOnce(() => first.promise);
    change(a);
    await settle();
    expect(importMany).toHaveBeenCalledOnce();

    // Changed again while its import runs, before its ir-id is written
    change(a);
    change(vault.add('b.md', { tags: TRIGGER }));
    await settle();
    expect(importMany).toHaveBeenCalledOnce();

    vault.rows.add('id-a');
    vault.edit(a, { tags: TRIGGER, 'ir-id': 'id-a' });
    first.resolve([{ file: a, status: 'imported' }]);
    await settle();

    expect(importedPaths(importMany)).toEqual([['a.md'], ['b.md']]);
  });

  it('goes on importing after an import throws, saying why in the console', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { vault, change, importMany } = makeWatcher();
    importMany.mockRejectedValueOnce(new Error('database closed'));
    change(vault.add('a.md', { tags: TRIGGER }));
    await settle();
    expect(error).toHaveBeenCalledWith(
      'Incremental Reading - automatic import failed:',
      new Error('database closed')
    );

    change(vault.add('b.md', { tags: TRIGGER }));
    await settle();

    expect(importedPaths(importMany)).toEqual([['a.md'], ['b.md']]);
  });

  it('leaves a note alone for now when looking up its ir-id throws, saying why in the console, and imports it at its next change', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { vault, change, importMany, hasRow } = makeWatcher();
    hasRow.mockRejectedValueOnce(new Error('database closed'));
    const unread = vault.add('unread.md', { 'ir-id': 'gone', tags: TRIGGER });
    const plain = vault.add('plain.md', { tags: TRIGGER });
    const orphan = vault.add('orphan.md', { 'ir-id': 'lost', tags: TRIGGER });
    for (const file of [unread, plain, orphan]) change(file);
    await settle();
    expect(importedPaths(importMany)).toEqual([['plain.md', 'orphan.md']]);
    expect(error).toHaveBeenCalledExactlyOnceWith(
      'Incremental Reading - couldn\'t look up ir-id "gone" for an automatic import:',
      new Error('database closed')
    );
    expect(Notice.messages).toEqual([importedNotice(2)]);

    change(unread);
    await settle();

    expect(importedPaths(importMany)).toEqual([
      ['plain.md', 'orphan.md'],
      ['unread.md'],
    ]);
  });

  it('imports nothing when stopped while looking up an ir-id', async () => {
    const { vault, change, importMany, hasRow, stop } = makeWatcher();
    const lookup = deferred<boolean>();
    hasRow.mockImplementationOnce(() => lookup.promise);
    change(vault.add('plain.md', { tags: TRIGGER }));
    change(vault.add('orphan.md', { 'ir-id': 'lost', tags: TRIGGER }));
    await settle();
    expect(hasRow).toHaveBeenCalledOnce();

    stop();
    lookup.resolve(false);
    await settle();

    expect(importMany).not.toHaveBeenCalled();
  });
});

describe('AutoImportWatcher.unimporting', () => {
  /**
   * Un-import `file` as the plugin does: the watcher told first, then the row
   * deleted. Its cache is left as it was, as the metadata cache reads the
   * stripped note only a moment later.
   */
  const unimport = (
    { vault, watcher }: ReturnType<typeof makeWatcher>,
    file: TFile
  ) => {
    watcher.unimporting(file);
    const id: unknown = vault.cacheOf(file)?.frontmatter?.['ir-id'];
    if (typeof id === 'string') vault.rows.delete(id);
  };

  it('leaves alone a note un-imported while it waited, its cache still showing its trigger tag and the id whose row went, and imports the rest', async () => {
    const watching = makeWatcher();
    const { vault, change, importMany } = watching;
    const file = vault.add('a.md', { tags: TRIGGER });
    change(file);
    await settle();
    // The import's own write of the id comes back to be looked at
    change(file);
    change(vault.add('b.md', { tags: TRIGGER }));

    unimport(watching, file);
    await settle();

    expect(importedPaths(importMany)).toEqual([['a.md'], ['b.md']]);
  });

  it('holds a note back for as long as its cache shows the id and a trigger tag it had when un-imported, then imports it when tagged again', async () => {
    await fc.assert(
      fc.asyncProperty(
        irIdArb,
        fc.nat({ max: 3 }),
        fc.constantFrom('untagged', 'new id'),
        async (irId, staleChanges, moveOn) => {
          const watching = makeWatcher();
          const { vault, change, importMany } = watching;
          const file = vault.add('a.md', { 'ir-id': irId, tags: TRIGGER });
          change(file);

          unimport(watching, file);
          for (let i = 0; i < staleChanges; i++) change(file);
          await settle();
          expect(importMany).not.toHaveBeenCalled();

          // The cache reads the note as the un-import left it, or as changed
          // since: no trigger tag, or another id
          vault.edit(
            file,
            moveOn === 'untagged'
              ? { tags: ['other'] }
              : {
                  // Not `String(irId)`: YAML can't write an object whose
                  // `toString` isn't one, but the arbitrary can
                  'ir-id': `${typeof irId === 'string' ? irId : 'id'}-new`,
                  tags: TRIGGER,
                }
          );
          change(file);
          await settle();
          vault.edit(file, { tags: TRIGGER });
          change(file);
          await settle();

          expect(importedPaths(importMany)).toEqual(
            moveOn === 'untagged' ? [['a.md']] : [['a.md'], ['a.md']]
          );
        }
      )
    );
  });

  it('leaves alone a note un-imported while its id was looked up', async () => {
    const watching = makeWatcher();
    const { vault, change, importMany, hasRow } = watching;
    vault.rows.add('a');
    const file = vault.add('a.md', { 'ir-id': 'a', tags: TRIGGER });
    const lookup = deferred<boolean>();
    hasRow.mockImplementationOnce(() => lookup.promise);
    change(file);
    await settle();
    expect(hasRow).toHaveBeenCalledOnce();

    unimport(watching, file);
    lookup.resolve(false);
    await settle();

    expect(importMany).not.toHaveBeenCalled();
  });

  it('holds one whose ir-id YAML read as NaN while its cache still shows that id and a trigger tag', async () => {
    // `.nan` in YAML: NaN equals nothing, itself included
    const watching = makeWatcher();
    const { vault, change, importMany } = watching;
    const file = vault.add('a.md', { 'ir-id': Number.NaN, tags: TRIGGER });

    unimport(watching, file);
    change(file);
    await settle();

    expect(importMany).not.toHaveBeenCalled();
  });

  it('counts no note it holds among those waiting for Sync', async () => {
    const watching = makeWatcher();
    const { vault, change, onSyncWait, setGate } = watching;
    setGate('stalled');
    // No id: one with an id no row holds is never counted anyway
    const file = vault.add('a.md', { tags: TRIGGER });

    unimport(watching, file);
    change(file);
    await settle();

    expect(onSyncWait).not.toHaveBeenCalled();
  });
});

describe('AutoImportWatcher and Sync', () => {
  /** Queue a note with a trigger tag at `path`. */
  const queueTagged = (
    watching: ReturnType<typeof makeWatcher>,
    path: string
  ) => {
    const file = watching.vault.add(path, { tags: TRIGGER });
    watching.change(file);
    return file;
  };

  /** The number of notes the watcher last said wait for Sync. */
  const waiting = ({ onSyncWait }: ReturnType<typeof makeWatcher>) =>
    onSyncWait.mock.lastCall?.[0] ?? 0;

  it('holds every note queued, by trigger tag or arrival, while Sync is not open, says how many wait while it is stalled, and imports them together once it opens', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        fc.boolean(),
        fc.array(fc.constantFrom<SyncGate>('syncing', 'stalled'), {
          maxLength: 5,
        }),
        async (tagged, withArrival, closed) => {
          const watching = makeWatcher({ onFolder: true, folders: [INBOX] });
          const { vault, importMany, onSyncWait, setGate } = watching;
          setGate(closed[0] ?? 'open');
          const paths: string[] = [];
          for (let i = 0; i < tagged; i++) {
            paths.push(queueTagged(watching, `n${i}.md`).path);
          }
          if (withArrival) {
            const file = vault.create(`${INBOX}/a.md`);
            watching.arrive(file);
            vault.edit(file, { tags: ['Other'] });
            watching.change(file);
            paths.push(file.path);
          }
          await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);
          for (const [i, gate] of closed.entries()) {
            if (i > 0) {
              setGate(gate);
              await vi.advanceTimersByTimeAsync(AUTO_IMPORT_SYNC_POLL_MS);
            }
            expect(importMany).not.toHaveBeenCalled();
            expect(waiting(watching)).toBe(
              gate === 'stalled' ? paths.length : 0
            );
          }
          setGate('open');
          await vi.advanceTimersByTimeAsync(AUTO_IMPORT_SYNC_POLL_MS);

          expect(
            importedPaths(importMany).map((batch) => [...batch].sort())
          ).toEqual([[...paths].sort()]);
          expect(waiting(watching)).toBe(0);
          // Told only of a change
          const told = onSyncWait.mock.calls.map(([count]) => count);
          expect(told.every((count, i) => count !== (told[i - 1] ?? 0))).toBe(
            true
          );
          watching.stop();
        }
      )
    );
  });

  it('counts the notes as waiting once Sync has been syncing for its patience, and not before, a note queued meanwhile among them', async () => {
    const watching = makeWatcher();
    watching.setGate('syncing');
    queueTagged(watching, 'a.md');
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(
      AUTO_IMPORT_SYNC_PATIENCE_MS - AUTO_IMPORT_SYNC_POLL_MS
    );
    expect(watching.onSyncWait).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_SYNC_POLL_MS);
    expect(watching.onSyncWait.mock.calls).toEqual([[1]]);
    queueTagged(watching, 'b.md');
    await vi.advanceTimersByTimeAsync(0);
    expect(watching.onSyncWait.mock.calls).toEqual([[1], [2]]);

    expect(watching.importMany).not.toHaveBeenCalled();
  });

  it('imports what waits when told to, whatever Sync is doing, once, and nothing when nothing waits', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<SyncGate>('syncing', 'stalled'),
        fc.constantFrom<SyncGate>('syncing', 'stalled', 'open'),
        async (gate, after) => {
          const watching = makeWatcher();
          const { watcher, importMany, setGate } = watching;
          setGate(gate);
          await watcher.importDespiteSync();
          queueTagged(watching, 'a.md');
          await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);

          await watcher.importDespiteSync();
          expect(importedPaths(importMany)).toEqual([['a.md']]);
          expect(waiting(watching)).toBe(0);

          setGate(after);
          await settle();
          await watcher.importDespiteSync();
          expect(importMany).toHaveBeenCalledOnce();
          watching.stop();
        }
      )
    );
  });

  it("holds the startup scan's imports for Sync too", async () => {
    const vault = makeVault();
    const file = vault.add('a.md', { tags: TRIGGER });
    saveAutoImportWatermark(vault.app, file.stat.mtime - 1);
    const watching = makeWatcher({}, vault);
    watching.setGate('stalled');

    await watching.watcher.runCatchUpScan();
    expect(watching.importMany).not.toHaveBeenCalled();
    expect(waiting(watching)).toBe(1);

    watching.setGate('open');
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_SYNC_POLL_MS);
    expect(importedPaths(watching.importMany)).toEqual([['a.md']]);
  });

  it('moves the moment last seen to on, with nothing to import, whatever Sync is doing', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<SyncGate>('syncing', 'stalled', 'open'),
        async (gate) => {
          const vault = makeVault();
          saveAutoImportWatermark(vault.app, 1);
          const watching = makeWatcher({}, vault);
          watching.setGate(gate);

          await watching.watcher.runCatchUpScan();

          expect(seenAt(vault)).toBe(
            Date.now() - AUTO_IMPORT_WATERMARK_SLACK_MS
          );
          expect(watching.onSyncWait).not.toHaveBeenCalled();
          watching.stop();
        }
      )
    );
  });

  it('listens to Sync only while it holds notes for it, importing as soon as a change Sync tells of finds it open, and stops listening once nothing waits or it is stopped', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<SyncGate>('syncing', 'stalled'), {
          maxLength: 4,
        }),
        fc.boolean(),
        async (closed, stopFirst) => {
          const watching = makeWatcher();
          const { syncWatch, setGate, importMany } = watching;
          queueTagged(watching, 'open.md');
          await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);
          expect(importedPaths(importMany)).toEqual([['open.md']]);
          expect(syncWatch.starts).toBe(0);

          setGate('stalled');
          queueTagged(watching, 'a.md');
          await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);
          expect(syncWatch).toMatchObject({ starts: 1, stops: 0 });
          for (const gate of closed) {
            setGate(gate);
            watching.syncChanged();
            await vi.advanceTimersByTimeAsync(0);
          }
          expect(importMany).toHaveBeenCalledOnce();
          expect(syncWatch).toMatchObject({ starts: 1, stops: 0 });

          if (stopFirst) {
            watching.stop();
            expect(syncWatch).toMatchObject({ starts: 1, stops: 1 });
            setGate('open');
            watching.syncChanged();
            await settle();
            expect(importMany).toHaveBeenCalledOnce();
            return;
          }
          setGate('open');
          watching.syncChanged();
          // At once, with no wait for the next look
          await vi.advanceTimersByTimeAsync(0);
          expect(importedPaths(importMany)).toEqual([['open.md'], ['a.md']]);
          expect(syncWatch).toMatchObject({ starts: 1, stops: 1 });
          watching.syncChanged();
          await settle();
          expect(importMany).toHaveBeenCalledTimes(2);
          watching.stop();
        }
      )
    );
  });

  it('pays no heed to a change Sync tells of late, once it no longer waits on Sync, leaving what is queued to settle', async () => {
    const watching = makeWatcher();
    watching.setGate('stalled');
    queueTagged(watching, 'a.md');
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);
    const late = watching.syncWatch.recheck!;
    watching.setGate('open');
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_SYNC_POLL_MS);
    expect(watching.importMany).toHaveBeenCalledOnce();

    queueTagged(watching, 'b.md');
    late();
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS - 1);
    expect(watching.importMany).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(importedPaths(watching.importMany)).toEqual([['a.md'], ['b.md']]);
  });

  it('counts Sync that goes back to syncing after a pause as stuck only once it has synced on end for its patience', async () => {
    const watching = makeWatcher();
    watching.setGate('stalled');
    queueTagged(watching, 'a.md');
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);
    expect(waiting(watching)).toBe(1);

    watching.setGate('syncing');
    watching.syncChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(waiting(watching)).toBe(0);
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_SYNC_PATIENCE_MS - 1);
    expect(waiting(watching)).toBe(0);
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_SYNC_POLL_MS);
    expect(waiting(watching)).toBe(1);
    expect(watching.importMany).not.toHaveBeenCalled();
  });

  it('property: imports a note whose ir-id no row holds only once Sync is open and the database settles ready, never despite Sync, never counting it waiting, and leaves it be when the database does not settle', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            gate: fc.constantFrom<SyncGate>('syncing', 'stalled', 'open'),
            ready: fc.boolean(),
            press: fc.boolean(),
          }),
          { minLength: 1, maxLength: 6 }
        ),
        fc.boolean(),
        async (steps, withPlain) => {
          const watching = makeWatcher();
          const { vault, watcher, importMany, setGate, setDatabaseReady } =
            watching;
          setGate(steps[0].gate === 'open' ? 'syncing' : steps[0].gate);
          const orphan = vault.add('orphan.md', {
            'ir-id': 'gone',
            tags: TRIGGER,
          });
          watching.change(orphan);
          if (withPlain) queueTagged(watching, 'plain.md');
          await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);

          let orphanState: 'queued' | 'imported' | 'left' = 'queued';
          let plainQueued = withPlain;
          for (const { gate, ready, press } of steps) {
            setGate(gate);
            setDatabaseReady(ready);
            if (press) await watcher.importDespiteSync();
            await vi.advanceTimersByTimeAsync(AUTO_IMPORT_SYNC_POLL_MS);
            const flushed = press || gate === 'open';
            if (flushed) plainQueued = false;
            if (orphanState === 'queued' && gate === 'open') {
              orphanState = ready ? 'imported' : 'left';
            }
            const imported = importedPaths(importMany).flat();
            expect(imported.includes('orphan.md')).toBe(
              orphanState === 'imported'
            );
            expect(imported.includes('plain.md')).toBe(
              withPlain && !plainQueued
            );
            expect(waiting(watching)).toBe(
              gate === 'stalled' && plainQueued ? 1 : 0
            );
          }
          // Left to its next change, not remembered as failed
          if (orphanState === 'left') {
            setGate('open');
            setDatabaseReady(true);
            watching.change(orphan);
            await settle();
            expect(importedPaths(importMany).flat()).toContain('orphan.md');
          }
          watching.stop();
        }
      )
    );
  });

  // 0228 review: another device may be putting the tag back as Sync runs
  it('repairs a note that lost its article tag only once Sync is open, never despite Sync, and never asks the database to settle for it', async () => {
    const watching = makeWatcher();
    const { vault, watcher, importMany, repairable, setGate, settleDatabase } =
      watching;
    vault.rows.add('held');
    repairable.add('held');
    setGate('stalled');
    watching.change(vault.add('held.md', { 'ir-id': 'held', tags: TRIGGER }));
    queueTagged(watching, 'plain.md');
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);

    await watcher.importDespiteSync();
    expect(importedPaths(importMany)).toEqual([['plain.md']]);

    setGate('open');
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_SYNC_POLL_MS);
    expect(importedPaths(importMany)).toEqual([['plain.md'], ['held.md']]);
    expect(settleDatabase).not.toHaveBeenCalled();
    watching.stop();
  });

  it('asks the database to settle once a batch, only for notes whose ir-id no row holds', async () => {
    const watching = makeWatcher();
    const { vault, settleDatabase } = watching;
    vault.rows.add('held');
    watching.change(vault.add('held.md', { 'ir-id': 'held', tags: TRIGGER }));
    queueTagged(watching, 'plain.md');
    await settle();
    expect(settleDatabase).not.toHaveBeenCalled();

    watching.change(vault.add('o1.md', { 'ir-id': 'x', tags: TRIGGER }));
    watching.change(vault.add('o2.md', { 'ir-id': 'y', tags: TRIGGER }));
    await settle();
    expect(settleDatabase).toHaveBeenCalledOnce();
    expect(importedPaths(watching.importMany)).toEqual([
      ['plain.md'],
      ['o1.md', 'o2.md'],
    ]);
  });

  it('property: checks a note whose ir-id no row holds again once the database settles, importing it only if it is still there, with that id and a trigger tag, by the tags it has then', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          'none',
          'untagged',
          'other trigger',
          'new id',
          'deleted',
          'replaced',
          'unimported'
        ),
        async (meanwhile) => {
          const watching = makeWatcher({ triggerTags: [TRIGGER, 'later'] });
          const { vault, settleDatabase, importMany } = watching;
          const file = vault.add('a.md', { 'ir-id': 'gone', tags: TRIGGER });
          settleDatabase.mockImplementation(() => {
            if (meanwhile === 'untagged') {
              vault.edit(file, { 'ir-id': 'gone', tags: ['other'] });
            } else if (meanwhile === 'other trigger') {
              vault.edit(file, { 'ir-id': 'gone', tags: ['later'] });
            } else if (meanwhile === 'new id') {
              vault.edit(file, { 'ir-id': 'fresh', tags: TRIGGER });
            } else if (meanwhile === 'deleted') {
              vault.remove(file);
            } else if (meanwhile === 'replaced') {
              vault.add('a.md', { 'ir-id': 'gone', tags: TRIGGER });
            } else if (meanwhile === 'unimported') {
              watching.watcher.unimporting(file);
            }
            return Promise.resolve(true);
          });
          watching.change(file);
          await settle();

          const calls = importMany.mock.calls.map(([entries]) =>
            entries.map(({ file: given, matchedTags }) => [given, matchedTags])
          );
          expect(calls).toEqual(
            meanwhile === 'none'
              ? [[[file, [TRIGGER]]]]
              : meanwhile === 'other trigger'
                ? [[[file, ['later']]]]
                : []
          );
          watching.stop();
        }
      )
    );
  });

  it('passes over a note whose row turns up while the database settles', async () => {
    const watching = makeWatcher();
    const { vault, settleDatabase } = watching;
    settleDatabase.mockImplementation(() => {
      vault.rows.add('late');
      return Promise.resolve(true);
    });
    watching.change(vault.add('a.md', { 'ir-id': 'late', tags: TRIGGER }));
    await settle();

    expect(watching.importMany).not.toHaveBeenCalled();
  });

  it('keeps the moment last seen to before every note held for Sync, so one the startup scan found is found again after a restart', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 * 24 * 3600_000 }),
        fc.constantFrom<SyncGate>('syncing', 'stalled'),
        async (age, gate) => {
          const vault = makeVault();
          const now = Date.now();
          vault.add('old.md', { tags: TRIGGER }, 'md', now - age);
          saveAutoImportWatermark(vault.app, now - age - 1);
          const first = makeWatcher({}, vault);
          first.setGate(gate);
          await first.watcher.runCatchUpScan();
          await vi.advanceTimersByTimeAsync(AUTO_IMPORT_SYNC_POLL_MS);
          first.stop();
          expect(seenAt(vault)).toBeLessThan(now - age);

          const second = makeWatcher({}, vault);
          await second.watcher.runCatchUpScan();
          expect(importedPaths(second.importMany)).toEqual([['old.md']]);
          second.stop();
        }
      )
    );
  });

  it('says none wait, and imports nothing, once stopped while holding notes for Sync', async () => {
    const watching = makeWatcher();
    watching.setGate('stalled');
    queueTagged(watching, 'a.md');
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);
    expect(waiting(watching)).toBe(1);

    watching.stop();
    watching.setGate('open');
    await settle();

    expect(waiting(watching)).toBe(0);
    expect(watching.importMany).not.toHaveBeenCalled();
  });
});

describe('AutoImportWatcher failures', () => {
  it('never tries again to import a note that failed, but does other notes and ones only skipped', async () => {
    const vault = makeVault();
    let busySkipped = false;
    const importMany = makeImporter(vault, (file) => {
      if (file.path === 'bad.md') return { status: 'failed', reason: 'broken' };
      if (file.path === 'busy.md' && !busySkipped) {
        busySkipped = true;
        return { status: 'skipped', reason: 'already being imported' };
      }
      return { status: 'imported' };
    });
    const watcher = new AutoImportWatcher({
      app: vault.app,
      getConfig: () => ({
        enabled: true,
        triggerTags: [TRIGGER],
        priority: 1,
        ...NO_FOLDERS,
      }),
      importMany,
      hasRow: makeRowLookup(vault),
    });
    watcher.start();
    const bad = vault.add('bad.md', { tags: TRIGGER });
    const busy = vault.add('busy.md', { tags: TRIGGER });
    watcher.consider(bad, vault.cacheOf(bad));
    watcher.consider(busy, vault.cacheOf(busy));
    await settle();

    for (const file of [bad, busy, vault.add('new.md', { tags: TRIGGER })]) {
      watcher.consider(file, vault.cacheOf(file));
    }
    await settle();

    expect(importedPaths(importMany)).toEqual([
      ['bad.md', 'busy.md'],
      ['busy.md', 'new.md'],
    ]);
  });
});

describe('AutoImportWatcher notices', () => {
  it('counts what a batch imported in one notice, then lists what failed in another', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('imported', 'skipped', 'failed'), {
          minLength: 1,
          maxLength: 6,
        }),
        async (statuses) => {
          Notice.reset();
          const vault = makeVault();
          const files = statuses.map((_, i) =>
            vault.add(`note ${i}.md`, { tags: TRIGGER })
          );
          const outcome = (file: TFile) => {
            const status = statuses[files.indexOf(file)];
            return status === 'imported'
              ? { status }
              : { status, reason: `${status} because` };
          };
          const importMany = makeImporter(vault, outcome);
          const watcher = new AutoImportWatcher({
            app: vault.app,
            getConfig: () => ({
              enabled: true,
              triggerTags: [TRIGGER],
              priority: 1,
              ...NO_FOLDERS,
            }),
            importMany,
            hasRow: makeRowLookup(vault),
          });
          const stop = watcher.start();
          for (const file of files) watcher.consider(file, vault.cacheOf(file));

          await settle();

          const imported = statuses.filter((s) => s === 'imported').length;
          const failed = files
            .filter((_, i) => statuses[i] === 'failed')
            .map((file) => ({ file, ...outcome(file) }) as BulkOutcome);
          expect(Notice.messages).toEqual([
            ...(imported === 0 ? [] : [importedNotice(imported)]),
            ...(failed.length === 0 ? [] : [describeFailures(failed)]),
          ]);
          stop();
        }
      )
    );
  });

  it('counts the imports only where the success notice level shows imports, but always lists the failures', async () => {
    for (const level of SUCCESS_NOTICE_LEVELS) {
      Notice.reset();
      showSuccessNotices(level);
      const vault = makeVault();
      const importMany = makeImporter(vault, (file) =>
        file.path === 'bad.md'
          ? { status: 'failed', reason: 'broken' }
          : { status: 'imported' }
      );
      const watcher = new AutoImportWatcher({
        app: vault.app,
        getConfig: () => ({
          enabled: true,
          triggerTags: [TRIGGER],
          priority: 1,
          ...NO_FOLDERS,
        }),
        importMany,
        hasRow: makeRowLookup(vault),
      });
      const stop = watcher.start();
      const bad = vault.add('bad.md', { tags: TRIGGER });
      const good = vault.add('good.md', { tags: TRIGGER });
      watcher.consider(bad, vault.cacheOf(bad));
      watcher.consider(good, vault.cacheOf(good));

      await settle();

      expect(Notice.messages, level).toEqual([
        ...(level === 'none' ? [] : [importedNotice(1)]),
        describeFailures([{ file: bad, status: 'failed', reason: 'broken' }]),
      ]);
      stop();
    }
  });

  it('leaves the failures up as long as an error stays up', async () => {
    const vault = makeVault();
    const importMany = makeImporter(vault, (file) =>
      file.path === 'bad.md'
        ? { status: 'failed', reason: 'broken' }
        : { status: 'imported' }
    );
    const watcher = new AutoImportWatcher({
      app: vault.app,
      getConfig: () => ({
        enabled: true,
        triggerTags: [TRIGGER],
        priority: 1,
        ...NO_FOLDERS,
      }),
      importMany,
      hasRow: makeRowLookup(vault),
    });
    watcher.start();
    for (const path of ['bad.md', 'good.md']) {
      const file = vault.add(path, { tags: TRIGGER });
      watcher.consider(file, vault.cacheOf(file));
    }
    await settle();
    const [summary, failures] = Notice.instances;

    const next = vault.add('next.md', { tags: TRIGGER });
    watcher.consider(next, vault.cacheOf(next));
    await settle();

    expect(summary.hides).toBe(1);
    expect(failures.hides).toBe(0);
  });
});

/** The moment last seen to, as stored, if one is: any a clock gives. */
const seenArb = fc.option(fc.integer({ min: 0, max: 4e12 }), { nil: null });

describe('AutoImportWatcher.runCatchUpScan', () => {
  /**
   * A file the scan may find: a note, or a file of another kind, last written
   * `writtenAfter` ms after the moment last seen to (before it, if negative).
   */
  const scannedArb = fc.record({
    extension: fc.constantFrom('md', 'pdf', 'canvas', 'MD'),
    note: noteArb.map(({ enabled: _enabled, ...note }): NoteState => note),
    writtenAfter: fc.oneof(
      fc.constantFrom(0, 1, -1),
      fc.integer({ min: -1e12, max: 1e12 })
    ),
  });

  it('takes a note written at the very moment last seen to as seen, and one a moment after as not', async () => {
    const vault = makeVault();
    const seen = Date.now() - 10;
    saveAutoImportWatermark(vault.app, seen);
    vault.add('at.md', { tags: [TRIGGER] }, 'md', seen);
    vault.add('after.md', { tags: [TRIGGER] }, 'md', seen + 1);

    const { importMany } = await launch({}, vault);

    expect(importedPaths(importMany)).toEqual([['after.md']]);
  });

  it('imports at once, in one batch under one notice, every note written after the moment last seen to that the guards let through, and no other file', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(scannedArb, { maxLength: 8 }),
        seenArb,
        async (scanned, seen) => {
          Notice.reset();
          const vault = makeVault();
          const { watcher, importMany, stop } = makeWatcher(
            { triggerTags: [TRIGGER, 'second-trigger'] },
            vault
          );
          const files = scanned.map(({ extension, writtenAfter }, i) =>
            vault.add(
              `notes/${i}.${extension}`,
              { tags: [TRIGGER] },
              extension,
              (seen ?? Date.now()) + writtenAfter
            )
          );
          // Failed since the plugin loaded
          const failing = files.filter((_, i) => scanned[i].note.failedBefore);
          if (failing.length > 0) {
            for (const file of failing) {
              watcher.consider(file, vault.cacheOf(file));
            }
            importMany.mockImplementationOnce((entries) =>
              Promise.resolve(
                entries.map(
                  ({ file }): BulkOutcome => ({
                    file,
                    status: 'failed',
                    reason: 'broken',
                  })
                )
              )
            );
            await watcher.flushNow();
            importMany.mockClear();
            Notice.reset();
          }
          if (seen !== null) saveAutoImportWatermark(vault.app, seen);
          const heldIds = new Set(
            scanned.flatMap(({ note }) =>
              typeof note.irId === 'string' && note.rowHeld ? [note.irId] : []
            )
          );
          heldIds.forEach((id) => vault.rows.add(id));
          scanned.forEach(({ note }, i) => {
            vault.edit(
              files[i],
              note.hasFrontmatter
                ? { 'ir-id': note.irId, tags: note.tags }
                : undefined
            );
          });

          await watcher.runCatchUpScan();

          const wanted = files
            .filter(
              ({ extension, stat }, i) =>
                extension === 'md' &&
                seen !== null &&
                stat.mtime > seen &&
                callsForImport(scanned[i].note, heldIds)
            )
            .map(({ path }) => path);
          expect(importedPaths(importMany)).toEqual(
            wanted.length === 0 ? [] : [wanted]
          );
          expect(Notice.messages).toEqual(
            wanted.length === 0 ? [] : [importedNotice(wanted.length)]
          );
          // Nothing was left waiting to be imported later
          await settle();
          expect(importMany.mock.calls.length).toBe(
            wanted.length === 0 ? 0 : 1
          );
          stop();
        }
      )
    );
  });

  it('reads no note, and stores now as the moment last seen to, when none is stored or importing is off', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.record({
            enabled: fc.boolean(),
            storedAfterNow: fc.constant(null),
          }),
          fc.record({
            enabled: fc.constant(false),
            storedAfterNow: fc.oneof(
              fc.constantFrom(0, 1, -1),
              fc.integer({ min: -1e12, max: 1e12 })
            ),
          })
        ),
        fc.array(fc.integer({ min: -1e12, max: 1e12 }), { maxLength: 5 }),
        async ({ enabled, storedAfterNow }, writtenAfter) => {
          Notice.reset();
          const vault = makeVault();
          const now = Date.now();
          writtenAfter.forEach((after, i) =>
            vault.add(`note ${i}.md`, { tags: [TRIGGER] }, 'md', now + after)
          );
          const stored = storedAfterNow === null ? null : now + storedAfterNow;
          if (stored !== null) saveAutoImportWatermark(vault.app, stored);
          const { watcher, importMany, stop } = makeWatcher({ enabled }, vault);
          const listFiles = vi.spyOn(vault.app.vault, 'getMarkdownFiles');
          const store = vi.spyOn(vault.app, 'saveLocalStorage');

          await watcher.runCatchUpScan();
          await settle();

          expect(listFiles).not.toHaveBeenCalled();
          expect(importMany).not.toHaveBeenCalled();
          expect(Notice.messages).toEqual([]);
          expect(seenAt(vault)).toBe(Math.max(stored ?? now, now));
          // Never moved back: a later moment stored is kept as it is
          expect(
            store.mock.calls.filter(
              ([key]) => key === AUTO_IMPORT_WATERMARK_KEY
            ).length
          ).toBe(stored !== null && stored >= now ? 0 : 1);
          stop();
          vi.restoreAllMocks();
        }
      )
    );
  });

  it('imports nothing and says nothing when run again after its imports, however often', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 3 }),
        async (count, reruns) => {
          Notice.reset();
          const vault = makeVault();
          saveAutoImportWatermark(vault.app, Date.now() - 1);
          const { watcher, importMany, stop } = makeWatcher({}, vault);
          for (let i = 0; i < count; i++) {
            vault.add(`note ${i}.md`, { tags: [TRIGGER] });
          }
          await watcher.runCatchUpScan();
          expect(importMany).toHaveBeenCalledOnce();

          for (let i = 0; i < reruns; i++) await watcher.runCatchUpScan();
          await settle();

          expect(importMany).toHaveBeenCalledOnce();
          expect(Notice.messages).toEqual([importedNotice(count)]);
          stop();
        }
      )
    );
  });

  it('does no work, and stores nothing, before it starts or once it stops', async () => {
    for (const state of ['unstarted', 'stopped'] as const) {
      const vault = makeVault();
      vault.add('a.md', { tags: [TRIGGER] });
      const listFiles = vi.spyOn(vault.app.vault, 'getMarkdownFiles');
      const readCache = vi.spyOn(vault.app.metadataCache, 'getFileCache');
      const importMany = makeImporter(vault);
      const watcher = new AutoImportWatcher({
        app: vault.app,
        getConfig: () => ({
          enabled: true,
          triggerTags: [TRIGGER],
          priority: 1,
          ...NO_FOLDERS,
        }),
        importMany,
        hasRow: makeRowLookup(vault),
      });
      if (state === 'stopped') watcher.start()();

      await watcher.runCatchUpScan();
      await settle();

      expect({ state, listed: listFiles.mock.calls.length }).toEqual({
        state,
        listed: 0,
      });
      expect(readCache).not.toHaveBeenCalled();
      expect(importMany).not.toHaveBeenCalled();
      expect(vault.storage.size).toBe(0);
    }
  });

  it('imports the notes already waiting in the same batch, under the same notice', async () => {
    const vault = makeVault();
    saveAutoImportWatermark(vault.app, Date.now() - 1);
    const { watcher, change, importMany } = makeWatcher({}, vault);
    change(vault.add('waiting.md', { tags: [TRIGGER] }));
    vault.add('tagged while closed.md', { tags: [TRIGGER] });

    await watcher.runCatchUpScan();
    await settle();

    expect(importedPaths(importMany)).toEqual([
      ['waiting.md', 'tagged while closed.md'],
    ]);
    expect(Notice.messages).toEqual([importedNotice(2)]);
  });

  it('leaves a note being imported to that import, though its cache has yet to show it', async () => {
    const vault = makeVault();
    saveAutoImportWatermark(vault.app, Date.now() - 1);
    const { watcher, change, importMany } = makeWatcher({}, vault);
    const file = vault.add('a.md', { tags: [TRIGGER] });
    const outcomes = deferred<BulkOutcome[]>();
    importMany.mockImplementationOnce(() => outcomes.promise);
    change(file);
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);
    expect(importMany).toHaveBeenCalledOnce();

    const scan = watcher.runCatchUpScan();
    // The row is made, but the note's new ir-id is not indexed yet
    vault.rows.add('id-a.md');
    outcomes.resolve([{ file, status: 'imported' }]);
    await scan;
    await settle();

    expect(importMany).toHaveBeenCalledOnce();
  });

  it('leaves a note waiting behind another import to its own import, though its cache has yet to show it', async () => {
    const vault = makeVault();
    saveAutoImportWatermark(vault.app, Date.now() - 1);
    const { watcher, change, importMany } = makeWatcher({}, vault);
    const outcomes = deferred<BulkOutcome[]>();
    importMany.mockImplementationOnce(() => outcomes.promise);
    const first = vault.add('a.md', { tags: [TRIGGER] });
    change(first);
    await settle();
    const second = vault.add('b.md', { tags: [TRIGGER] });
    importMany.mockImplementationOnce(() =>
      Promise.resolve([{ file: second, status: 'imported' }])
    );
    change(second);
    await settle();
    expect(importMany).toHaveBeenCalledOnce();

    const scan = watcher.runCatchUpScan();
    // The rows are made, but the notes' new ir-ids are not indexed yet
    vault.rows.add('id-a.md').add('id-b.md');
    outcomes.resolve([{ file: first, status: 'imported' }]);
    await scan;
    await settle();

    expect(importedPaths(importMany)).toEqual([['a.md'], ['b.md']]);
  });

  it('looks at a note again once an import of it that came to nothing is over', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('skipped', 'throws'), async (first) => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const vault = makeVault();
        saveAutoImportWatermark(vault.app, Date.now() - 1);
        const { watcher, change, importMany, stop } = makeWatcher({}, vault);
        const file = vault.add('a.md', { tags: [TRIGGER] });
        importMany.mockImplementationOnce(() =>
          first === 'throws'
            ? Promise.reject(new Error('disk full'))
            : Promise.resolve([{ file, status: 'skipped', reason: 'not now' }])
        );
        change(file);
        await watcher.flushNow();

        await watcher.runCatchUpScan();

        expect(importedPaths(importMany)).toEqual([['a.md'], ['a.md']]);
        stop();
      })
    );
  });

  it('imports a file written in a watched folder after the moment last seen to only for a trigger tag, never as an arrival', async () => {
    const vault = makeVault();
    const { watcher, importMany, stop } = makeWatcher(
      { onFolder: true, folders: [INBOX] },
      vault
    );
    const seen = Date.now() - 1000;
    vault.add(`${INBOX}/plain.md`, {}, 'md', seen + 1);
    vault.add(`${INBOX}/paper.pdf`, undefined, 'pdf', seen + 1);
    vault.add(`${INBOX}/tagged.md`, { tags: [TRIGGER] }, 'md', seen + 1);
    saveAutoImportWatermark(vault.app, seen);

    await watcher.runCatchUpScan();

    expect(importedPaths(importMany)).toEqual([[`${INBOX}/tagged.md`]]);
    stop();
  });
});

describe('AutoImportWatcher, the moment last seen to', () => {
  /** A watcher over `vault` that has looked for what changed while closed. */
  async function caughtUp(
    vault: Vault,
    config: Partial<AutoImportConfig> = {}
  ) {
    const watching = makeWatcher(config, vault);
    await watching.watcher.runCatchUpScan();
    return watching;
  }

  it('moves on after each import, back as far as the note waiting longest less the slack, and never back', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.constant(0), fc.integer({ min: -1e9, max: 1e9 })),
        fc.boolean(),
        fc.integer({ min: 1, max: AUTO_IMPORT_DEBOUNCE_MS - 1 }),
        async (storedAfterNow, queuedMeanwhile, wait) => {
          Notice.reset();
          const vault = makeVault();
          const stored = Date.now() + storedAfterNow;
          saveAutoImportWatermark(vault.app, stored);
          const { importMany, change, stop } = await caughtUp(vault);
          const scanned = Math.max(
            stored,
            Date.now() - AUTO_IMPORT_WATERMARK_SLACK_MS
          );
          expect(seenAt(vault)).toBe(scanned);

          const first = vault.add('first.md', { tags: [TRIGGER] });
          const outcomes = deferred<BulkOutcome[]>();
          importMany.mockImplementationOnce(() => outcomes.promise);
          change(first);
          await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);
          expect(importMany).toHaveBeenCalledOnce();
          const queuedAt = Date.now();
          if (queuedMeanwhile) {
            change(vault.add('second.md', { tags: [TRIGGER] }));
          }
          await vi.advanceTimersByTimeAsync(wait);
          outcomes.resolve([{ file: first, status: 'imported' }]);
          // Settled with no time passing, so the note queued meanwhile waits
          for (let i = 0; i < 20; i++) await Promise.resolve();
          expect(Notice.messages).toEqual([importedNotice(1)]);

          expect(seenAt(vault)).toBe(
            Math.max(
              scanned,
              (queuedMeanwhile ? queuedAt : queuedAt + wait) -
                AUTO_IMPORT_WATERMARK_SLACK_MS
            )
          );
          stop();
        }
      )
    );
  });

  it('is stored as it stops, so a note written too late to import, whether or not its change came, is imported at the next start, as after a crash', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('changed', 'unread', 'crashed'),
        fc.integer({ min: 1, max: AUTO_IMPORT_DEBOUNCE_MS - 1 }),
        async (how, wait) => {
          const vault = makeVault();
          saveAutoImportWatermark(vault.app, Date.now() - 1);
          const { importMany, change, stop } = await caughtUp(vault);
          const before = seenAt(vault)!;
          await vi.advanceTimersByTimeAsync(AUTO_IMPORT_WATERMARK_SLACK_MS * 2);
          const file = vault.add('late.md', { tags: [TRIGGER] });
          const writtenAt = Date.now();
          if (how === 'changed') change(file);
          await vi.advanceTimersByTimeAsync(wait);

          if (how !== 'crashed') {
            stop();
            expect(seenAt(vault)).toBe(
              Math.max(
                before,
                (how === 'changed' ? writtenAt : writtenAt + wait) -
                  AUTO_IMPORT_WATERMARK_SLACK_MS
              )
            );
          }
          expect(importMany).not.toHaveBeenCalled();

          const next = await caughtUp(vault);
          expect(importedPaths(next.importMany)).toEqual([['late.md']]);
          next.stop();
          if (how === 'crashed') stop();
        }
      )
    );
  });

  it('stays put once stopped, though an import was under way', async () => {
    const vault = makeVault();
    saveAutoImportWatermark(vault.app, Date.now() - 1);
    const { importMany, change, stop } = await caughtUp(vault);
    const file = vault.add('a.md', { tags: [TRIGGER] });
    const outcomes = deferred<BulkOutcome[]>();
    importMany.mockImplementationOnce(() => outcomes.promise);
    change(file);
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);
    stop();
    const stopped = seenAt(vault);

    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_WATERMARK_SLACK_MS * 2);
    outcomes.resolve([{ file, status: 'imported' }]);
    await settle();

    expect(seenAt(vault)).toBe(stopped);
  });

  it('is moved by nothing but turning importing on until it has looked for what changed while closed', async () => {
    await fc.assert(
      fc.asyncProperty(seenArb, async (stored) => {
        const vault = makeVault();
        if (stored !== null) saveAutoImportWatermark(vault.app, stored);
        const { change, importMany, stop } = makeWatcher({}, vault);
        change(vault.add('a.md', { tags: [TRIGGER] }));
        await settle();
        expect(importMany).toHaveBeenCalledOnce();

        stop();

        expect(seenAt(vault)).toBe(stored);
      })
    );
  });

  it('is now as importing by tag is turned on, and moves at no other change to the settings', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.array(
          fc.record({
            enabled: fc.boolean(),
            triggerTags: fc.constantFrom([TRIGGER], ['other']),
            after: fc.integer({ min: 0, max: 1e7 }),
          }),
          { maxLength: 6 }
        ),
        async (enabledAtStart, changes) => {
          const vault = makeVault();
          const { configure, stop } = makeWatcher(
            { enabled: enabledAtStart },
            vault
          );
          let enabled = enabledAtStart;
          let expected: number | null = null;
          for (const { after, ...change } of changes) {
            await vi.advanceTimersByTimeAsync(after);
            configure(change);
            if (change.enabled && !enabled) expected = Date.now();
            enabled = change.enabled;
            expect(seenAt(vault)).toBe(expected);
          }
          stop();
        }
      )
    );
  });

  it('is not stored as importing is turned on before the watcher starts or once it stops', () => {
    for (const state of ['unstarted', 'stopped'] as const) {
      const vault = makeVault();
      let enabled = false;
      const watcher = new AutoImportWatcher({
        app: vault.app,
        getConfig: () => ({
          enabled,
          triggerTags: [TRIGGER],
          priority: 1,
          ...NO_FOLDERS,
        }),
        importMany: makeImporter(vault),
        hasRow: makeRowLookup(vault),
      });
      if (state === 'stopped') watcher.start()();

      enabled = true;
      watcher.configChanged();

      expect({ state, stored: vault.storage.size }).toEqual({
        state,
        stored: 0,
      });
    }
  });

  it('leaves alone a note tagged before importing by tag was turned on, however often Obsidian starts, until it changes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1e7 }),
        fc.integer({ min: 1, max: 4 }),
        fc.boolean(),
        async (gap, starts, scannedWhileOff) => {
          const vault = makeVault();
          const off = makeWatcher({ enabled: false }, vault);
          if (scannedWhileOff) await off.watcher.runCatchUpScan();
          const tagged = vault.add('tagged before.md', { tags: [TRIGGER] });
          off.change(tagged);
          await vi.advanceTimersByTimeAsync(gap);
          off.configure({ enabled: true });
          await settle();
          off.stop();

          for (let i = 0; i < starts; i++) {
            await vi.advanceTimersByTimeAsync(AUTO_IMPORT_MAX_WAIT_MS);
            const next = await caughtUp(vault);
            await settle();
            expect(next.importMany).not.toHaveBeenCalled();
            next.stop();
          }

          // Changed while Obsidian was closed
          await vi.advanceTimersByTimeAsync(AUTO_IMPORT_MAX_WAIT_MS);
          tagged.stat.mtime = Date.now();
          const next = await caughtUp(vault);
          expect(importedPaths(next.importMany)).toEqual([
            ['tagged before.md'],
          ]);
          expect(off.importMany).not.toHaveBeenCalled();
          next.stop();
        }
      )
    );
  });
});

describe('AutoImportWatcher.noteArrival', () => {
  /** A watcher watching {@link INBOX}, with importing by tag off. */
  const makeFolderWatcher = (config: Partial<AutoImportConfig> = {}) =>
    makeWatcher({
      enabled: false,
      onFolder: true,
      folders: [INBOX],
      ...config,
    });

  /**
   * A file created or moved to `to`, with `extension`, while watching
   * `folders`. A note carries `frontmatter` once read, if it has any. The
   * plugin's data folder can be among `folders` only by a hand-edited
   * `data.json`, since settings refuse it.
   */
  const arrivalArb = fc.record({
    onFolder: fc.boolean(),
    enabled: fc.boolean(),
    folders: fc.subarray([INBOX, 'Clips/Web', DATA_DIRECTORY]),
    extension: fc.constantFrom('md', 'pdf', 'png'),
    to: fc.constantFrom(
      `${INBOX}/a`,
      `${INBOX}/sub/a`,
      `${INBOX}2/a`,
      'Clips/Web/a',
      'Clips/a',
      `${DATA_DIRECTORY}/a`,
      'a'
    ),
    /** Where it was moved from; created when null. */
    from: fc.constantFrom(
      null,
      `${INBOX}/b`,
      `${INBOX}2/b`,
      'Clips/Web/sub/b',
      'Clips/b',
      `${DATA_DIRECTORY}/sub/b`,
      'b'
    ),
    hasFrontmatter: fc.boolean(),
    /** Whether a note has nothing in it when read. */
    empty: fc.boolean(),
    irId: irIdArb,
    rowHeld: fc.boolean(),
    tags: fc.subarray([TRIGGER, SNIPPET_TAG, CARD_TAG, 'Other']),
  });

  it('imports an importable file that lands in a watched folder from outside every one, unless a note is a snippet or card or has an ir-id', async () => {
    await fc.assert(
      fc.asyncProperty(arrivalArb, async (arrival) => {
        const { onFolder, enabled, folders, extension, from } = arrival;
        const { vault, change, arrive, move, importMany, stop } = makeWatcher({
          onFolder,
          enabled,
          folders,
        });
        const { irId, rowHeld, tags, hasFrontmatter, empty } = arrival;
        const size = empty ? 0 : 1;
        if (typeof irId === 'string' && rowHeld) vault.rows.add(irId);
        const frontmatter = hasFrontmatter
          ? { 'ir-id': irId, tags }
          : undefined;
        const isNote = extension === 'md';
        const to = `${arrival.to}.${extension}`;
        if (from === null) {
          const file = vault.create(to);
          arrive(file);
          if (isNote) {
            // Read only some time after it is created
            await settle();
            vault.edit(file, frontmatter, size);
            change(file);
          }
        } else {
          const file = vault.create(`${from}.${extension}`);
          if (isNote) vault.edit(file, frontmatter, size);
          move(file, to);
        }
        await settle();

        const watched = (path: string) =>
          !path.startsWith(`${DATA_DIRECTORY}/`) &&
          folders.some((folder) => path.startsWith(`${folder}/`));
        const arrived =
          onFolder &&
          extension !== 'png' &&
          watched(to) &&
          (from === null || !watched(from));
        const blocked =
          hasFrontmatter &&
          tags.some((tag) => tag === SNIPPET_TAG || tag === CARD_TAG);
        const id: unknown = hasFrontmatter ? irId : undefined;
        const byArrival =
          arrived &&
          (!isNote || (!empty && !blocked && typeof id !== 'string'));
        // A new note is read after it is created; one moved is looked at
        // only if it arrived
        const looked = isNote && (from === null || arrived);
        const byTag =
          looked &&
          enabled &&
          hasFrontmatter &&
          tags.includes(TRIGGER) &&
          !blocked &&
          !(typeof id === 'string' && rowHeld);
        expect(importedPaths(importMany)).toEqual(
          byArrival || byTag ? [[to]] : []
        );
        if (byArrival || byTag) {
          expect(importMany.mock.calls[0][0][0].matchedTags).toEqual(
            byTag ? [TRIGGER] : []
          );
        }
        stop();
      })
    );
  });

  it('waits for a new note to be read, then imports it once', async () => {
    const { vault, watcher, change, arrive, importMany } = makeFolderWatcher();
    const file = vault.create(`${INBOX}/clip.md`);
    arrive(file);
    await settle();
    // Written, but not read yet: its frontmatter, an ir-id among it, is unknown
    file.stat.size = 40;
    watcher.consider(file, null);
    await settle();
    expect(importMany).not.toHaveBeenCalled();

    vault.edit(file, { source: 'web' });
    change(file);
    await settle();
    // The import's own write-back, then further edits
    change(file);
    change(file);
    await settle();

    expect(importMany.mock.calls).toEqual([
      [
        [{ file, matchedTags: [] }],
        expect.objectContaining({ onFolder: true }),
      ],
    ]);
  });

  it('waits for a note that arrives empty to have something in it', async () => {
    const { vault, change, arrive, move, importMany } = makeFolderWatcher();
    const created = vault.create(`${INBOX}/new.md`);
    arrive(created);
    const moved = vault.add('blank.md');
    vault.edit(moved, undefined, 0);
    move(moved, `${INBOX}/blank.md`);
    // Read empty, and read again as it is saved still empty
    for (let i = 0; i < 2; i++) {
      vault.edit(created, undefined, 0);
      change(created);
      change(moved);
      await settle();
    }
    expect(importMany).not.toHaveBeenCalled();

    // Its first words saved
    vault.edit(created, undefined, 12);
    change(created);
    vault.edit(moved, undefined, 3);
    change(moved);
    await settle();

    expect(importedPaths(importMany)).toEqual([
      [`${INBOX}/new.md`, `${INBOX}/blank.md`],
    ]);
  });

  it('takes each arrival as one chance to import, not retried once the import passes it by', async () => {
    const { vault, change, arrive, importMany } = makeFolderWatcher();
    const file = vault.create(`${INBOX}/clip.md`);
    importMany.mockResolvedValueOnce([
      { file, status: 'skipped', reason: 'already being imported' },
    ]);
    arrive(file);
    vault.edit(file);
    change(file);
    await settle();

    change(file);
    await settle();

    expect(importMany).toHaveBeenCalledOnce();
  });

  it('imports a PDF as soon as the wait for others to arrive ends', async () => {
    const { vault, arrive, importMany } = makeFolderWatcher();
    const file = vault.create(`${INBOX}/paper.pdf`);
    arrive(file);

    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS - 1);
    expect(importMany).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(importMany.mock.calls[0][0]).toEqual([{ file, matchedTags: [] }]);
  });

  it('imports a note moved in at once, and none moved within or out', async () => {
    const { vault, move, importMany } = makeFolderWatcher();
    const within = vault.add(`${INBOX}/within.md`);
    const out = vault.add(`${INBOX}/out.md`);
    const moved = vault.add('notes/moved.md');
    move(within, `${INBOX}/sub/within.md`);
    move(out, 'notes/out.md');
    move(moved, `${INBOX}/moved.md`);

    await settle();

    expect(importedPaths(importMany)).toEqual([[`${INBOX}/moved.md`]]);
  });

  it('waits for a note moved in before it was read to be read', async () => {
    const { vault, change, move, importMany } = makeFolderWatcher();
    const file = vault.create('new.md');
    move(file, `${INBOX}/new.md`);
    await settle();
    expect(importMany).not.toHaveBeenCalled();

    vault.edit(file);
    change(file);
    await settle();

    expect(importedPaths(importMany)).toEqual([[`${INBOX}/new.md`]]);
  });

  it('imports nothing when a note that did not arrive changes, without a trigger tag', async () => {
    const { vault, change, importMany } = makeFolderWatcher({ enabled: true });
    change(vault.add(`${INBOX}/old.md`, { tags: ['Other'] }));

    await settle();

    expect(importMany).not.toHaveBeenCalled();
  });

  it('leaves a note that arrives with an ir-id alone, without looking it up', async () => {
    const { vault, change, arrive, move, importMany, hasRow } =
      makeFolderWatcher();
    // An article Sync delivers before the database row behind its id
    const synced = vault.create(`${INBOX}/synced.md`);
    arrive(synced);
    vault.edit(synced, { 'ir-id': 'from-elsewhere' });
    change(synced);
    move(vault.add('article.md', { 'ir-id': '' }), `${INBOX}/article.md`);

    await settle();

    expect(importMany).not.toHaveBeenCalled();
    expect(hasRow).not.toHaveBeenCalled();
  });

  it('imports nothing while watching is off, even if turned on before a new note is read', async () => {
    const { vault, change, arrive, move, configure, importMany } =
      makeFolderWatcher({ onFolder: false });
    const note = vault.create(`${INBOX}/a.md`);
    arrive(note);
    arrive(vault.create(`${INBOX}/a.pdf`));
    move(vault.add('b.md'), `${INBOX}/b.md`);
    await settle();
    configure({ onFolder: true });
    vault.edit(note);
    change(note);

    await settle();

    expect(importMany).not.toHaveBeenCalled();
  });

  it('imports nothing when watching is turned off before a new note is read', async () => {
    const { vault, change, arrive, configure, importMany } =
      makeFolderWatcher();
    const note = vault.create(`${INBOX}/a.md`);
    arrive(note);
    configure({ onFolder: false });
    vault.edit(note);
    change(note);

    await settle();

    expect(importMany).not.toHaveBeenCalled();
  });

  it('imports a note that arrived carrying a trigger tag once, as one with that tag', async () => {
    const { vault, change, arrive, importMany } = makeFolderWatcher({
      enabled: true,
    });
    const file = vault.create(`${INBOX}/clip.md`);
    arrive(file);
    vault.edit(file, { tags: [TRIGGER] });
    change(file);
    change(file);
    await settle();
    change(file);
    await settle();

    expect(importMany).toHaveBeenCalledOnce();
    expect(importMany.mock.calls[0][0]).toEqual([
      { file, matchedTags: [TRIGGER] },
    ]);
  });

  it('ignores folders', async () => {
    const { arrive, importMany } = makeFolderWatcher();
    const folder = Object.assign(new TFolder(), { path: `${INBOX}/sub.md` });

    expect(() => arrive(folder)).not.toThrow();
    await settle();

    expect(importMany).not.toHaveBeenCalled();
  });

  it('imports nothing that arrives before it starts or after it stops', async () => {
    const { vault, watcher, change, arrive, importMany, stop } =
      makeFolderWatcher();
    stop();
    const note = vault.create(`${INBOX}/a.md`);
    arrive(note);
    arrive(vault.create(`${INBOX}/a.pdf`));
    watcher.start();
    vault.edit(note);
    change(note);

    await settle();

    expect(importMany).not.toHaveBeenCalled();
  });

  it('forgets the notes waiting to be read when stopped', async () => {
    const { vault, watcher, change, arrive, importMany, stop } =
      makeFolderWatcher();
    const note = vault.create(`${INBOX}/a.md`);
    arrive(note);
    stop();
    watcher.start();
    vault.edit(note);
    change(note);

    await settle();

    expect(importMany).not.toHaveBeenCalled();
  });

  it('forgets which waiting files arrived once they are imported or dropped', async () => {
    const { vault, watcher, change, move, importMany, stop } =
      makeFolderWatcher({ enabled: true });
    const flushed = vault.add('flushed.md');
    const stopped = vault.add('stopped.md');
    importMany.mockResolvedValueOnce([
      { file: flushed, status: 'skipped', reason: 'busy' },
    ]);
    move(flushed, `${INBOX}/flushed.md`);
    await settle();
    move(stopped, `${INBOX}/stopped.md`);
    stop();
    watcher.start();
    importMany.mockClear();

    // Queued again by a trigger tag, which goes before the flush
    for (const file of [flushed, stopped]) {
      vault.edit(file, { tags: [TRIGGER] });
      change(file);
      vault.edit(file);
    }
    await settle();

    expect(importMany).not.toHaveBeenCalled();
  });

  it('remembers a file whose import failed, and never tries it again', async () => {
    const { vault, arrive, move, importMany } = makeFolderWatcher();
    const file = vault.create(`${INBOX}/broken.pdf`);
    importMany.mockResolvedValueOnce([
      { file, status: 'failed', reason: 'broken' },
    ]);
    arrive(file);
    await settle();
    move(file, 'broken.pdf');
    move(file, `${INBOX}/broken.pdf`);

    await settle();

    expect(importMany).toHaveBeenCalledOnce();
  });

  it('counts arrivals and tagged notes imported together in one notice', async () => {
    const { vault, change, arrive, importMany } = makeFolderWatcher({
      enabled: true,
    });
    arrive(vault.create(`${INBOX}/a.pdf`));
    change(vault.add('tagged.md', { tags: [TRIGGER] }));

    await settle();

    expect(importMany).toHaveBeenCalledOnce();
    expect(Notice.messages).toEqual([importedNotice(2)]);
  });
});

describe('AutoImportWatcher arrivals at flush', () => {
  /** A file that arrived in the watched folder and waits for the flush. */
  function makeWaiting(extension: 'md' | 'pdf' = 'md') {
    const watching = makeWatcher({ onFolder: true, folders: [INBOX] });
    const file = watching.vault.create(`${INBOX}/a.${extension}`);
    watching.arrive(file);
    if (extension === 'md') {
      watching.vault.edit(file, { tags: ['Other'] });
      watching.change(file);
    }
    return { ...watching, file };
  }

  it('drops a file moved out of every watched folder, and imports one moved within, where it now is', async () => {
    for (const extension of ['md', 'pdf'] as const) {
      const out = makeWaiting(extension);
      out.vault.rename(out.file, `notes/a.${extension}`);
      const within = makeWaiting(extension);
      within.vault.rename(within.file, `${INBOX}/sub/a.${extension}`);

      await settle();

      expect(out.importMany).not.toHaveBeenCalled();
      expect(importedPaths(within.importMany)).toEqual([
        [`${INBOX}/sub/a.${extension}`],
      ]);
    }
  });

  it("drops a file moved into the plugin's data folder while it waited, even with that folder listed", async () => {
    for (const extension of ['md', 'pdf'] as const) {
      const watching = makeWatcher({
        onFolder: true,
        folders: [INBOX, DATA_DIRECTORY],
      });
      const file = watching.vault.create(`${INBOX}/a.${extension}`);
      watching.arrive(file);
      if (extension === 'md') {
        watching.vault.edit(file, { tags: ['Other'] });
        watching.change(file);
      }
      watching.vault.rename(file, `${DATA_DIRECTORY}/a.${extension}`);

      await settle();

      expect(watching.importMany).not.toHaveBeenCalled();
    }
  });

  it('drops a file deleted while it waited', async () => {
    const { vault, file, importMany } = makeWaiting('pdf');
    vault.remove(file);

    await settle();

    expect(importMany).not.toHaveBeenCalled();
  });

  it('drops a note that gained an ir-id, a snippet or card tag, or lost its cache while it waited', async () => {
    const changes: ((vault: Vault, file: TFile) => void)[] = [
      (vault, file) => vault.edit(file, { 'ir-id': 'copied-in' }),
      (vault, file) => vault.edit(file, { tags: [SNIPPET_TAG] }),
      (vault, file) => vault.edit(file, { tags: CARD_TAG }),
      (vault, file) => vault.unindex(file),
    ];
    for (const makeChange of changes) {
      const { vault, file, importMany } = makeWaiting();
      makeChange(vault, file);

      await settle();

      expect(importMany).not.toHaveBeenCalled();
    }
  });

  it('drops everything that arrived when watching is turned off, or its folder unwatched, before the flush', async () => {
    const changes: Partial<AutoImportConfig>[] = [
      { onFolder: false },
      { folders: ['Elsewhere'] },
    ];
    for (const change of changes) {
      for (const extension of ['md', 'pdf'] as const) {
        const { configure, importMany } = makeWaiting(extension);
        configure(change);

        await settle();

        expect(importMany).not.toHaveBeenCalled();
      }
    }
  });
});

describe('AutoImportWatcher, the ledger of watched folders, at startup', () => {
  /**
   * A file in the vault at startup: where it is, of what kind, whether an
   * earlier launch saw it, and, for a note, whether it has an `ir-id` or a
   * snippet's tag.
   */
  const startupFileArb = fc.record({
    place: fc.constantFrom(
      `${INBOX}/`,
      `${INBOX}/sub/`,
      `${INBOX}2/`,
      'notes/',
      `${DATA_DIRECTORY}/`
    ),
    extension: fc.constantFrom('md', 'pdf', 'canvas', 'png'),
    seen: fc.boolean(),
    irId: fc.boolean(),
    blocked: fc.boolean(),
  });

  it('imports at once, under one notice, the importable files in a folder the ledger records that it has not seen, and stores every file the folders hold as seen', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(startupFileArb, { maxLength: 8 }),
        fc.record({
          stored: fc.boolean(),
          recorded: fc.boolean(),
          onFolder: fc.boolean(),
        }),
        async (specs, { stored, recorded, onFolder }) => {
          Notice.reset();
          const vault = makeVault();
          const folders = [INBOX, DATA_DIRECTORY];
          const files = specs.map((spec, i) =>
            vault.add(
              `${spec.place}${i}.${spec.extension}`,
              spec.extension === 'md'
                ? {
                    ...(spec.irId ? { 'ir-id': `id-${i}` } : {}),
                    ...(spec.blocked ? { tags: [SNIPPET_TAG] } : {}),
                  }
                : undefined,
              spec.extension
            )
          );
          if (stored) {
            storeLedger(
              vault,
              recorded ? folders : [],
              files.filter((_, i) => specs[i].seen).map(({ path }) => path)
            );
          }
          const { watcher, importMany, stop } = makeWatcher(
            { onFolder, folders },
            vault
          );

          await watcher.runCatchUpScan();

          const watched = files.filter((_, i) =>
            specs[i].place.startsWith(`${INBOX}/`)
          );
          const wanted = files
            .filter((file, i) => {
              const { extension, seen, irId, blocked } = specs[i];
              return (
                stored &&
                recorded &&
                onFolder &&
                watched.includes(file) &&
                !seen &&
                (extension === 'pdf' ||
                  (extension === 'md' && !irId && !blocked))
              );
            })
            .map(({ path }) => path);
          expect(importedPaths(importMany)).toEqual(
            wanted.length === 0 ? [] : [wanted]
          );
          expect(Notice.messages).toEqual(
            wanted.length === 0 ? [] : [importedNotice(wanted.length)]
          );
          expect(ledgerOf(vault)?.folders).toEqual(onFolder ? folders : []);
          expect(seenPaths(vault)).toEqual(
            new Set(onFolder ? watched.map(({ path }) => path) : [])
          );
          await settle();
          expect(importMany.mock.calls.length).toBe(
            wanted.length === 0 ? 0 : 1
          );
          stop();
        }
      )
    );
  });

  it('reads a stored ledger that is not wholly one as none: imports nothing, and stores the folders as they are', async () => {
    for (const malformed of [
      'Inbox/a.pdf',
      { folders: [INBOX] },
      { folders: [INBOX], paths: [1] },
      { folders: INBOX, paths: [] },
    ]) {
      const vault = makeVault();
      vault.storage.set(WATCHED_FOLDER_LEDGER_KEY, malformed);
      const file = vault.add(`${INBOX}/a.pdf`, undefined, 'pdf');
      const { importMany } = await launch(
        { onFolder: true, folders: [INBOX] },
        vault
      );

      expect(importMany).not.toHaveBeenCalled();
      expect(ledgerOf(vault)).toEqual({ folders: [INBOX], paths: [file.path] });
    }
  });

  it('imports what arrived while Obsidian was closed once per device: not again at the next launch, nor after it is un-imported', async () => {
    const vault = makeVault();
    const config = { onFolder: true, folders: [INBOX] };
    vault.add(`${INBOX}/old.md`, {});
    (await launch(config, vault)).stop();
    const note = vault.add(`${INBOX}/clip.md`, { title: 'Clip' });
    const pdf = vault.add(`${INBOX}/paper.pdf`, undefined, 'pdf');

    const first = await launch(config, vault);
    first.stop();
    const second = await launch(config, vault);
    second.stop();
    // Un-imported: its row gone and its `ir-id` stripped
    vault.rows.delete(`id-${note.path}`);
    vault.edit(note, { title: 'Clip' });
    const third = await launch(config, vault);

    expect(importedPaths(first.importMany)).toEqual([[note.path, pdf.path]]);
    expect(second.importMany).not.toHaveBeenCalled();
    expect(third.importMany).not.toHaveBeenCalled();
  });

  it('imports what arrived together with notes tagged while Obsidian was closed, in one batch under one notice, each once', async () => {
    const vault = makeVault();
    saveAutoImportWatermark(vault.app, Date.now() - 1);
    storeLedger(vault, [INBOX], []);
    vi.advanceTimersByTime(1);
    const tagged = vault.add('notes/tagged.md', { tags: [TRIGGER] });
    const both = vault.add(`${INBOX}/both.md`, { tags: [TRIGGER] });
    const arrived = vault.add(`${INBOX}/arrived.pdf`, undefined, 'pdf');

    const { importMany } = await launch(
      { onFolder: true, folders: [INBOX] },
      vault
    );

    expect(importedPaths(importMany)).toEqual([
      [tagged.path, both.path, arrived.path],
    ]);
    expect(Notice.messages).toEqual([importedNotice(3)]);
  });

  it('stores an arrival it found as seen only once it is imported, so a crash before then leaves it to be found again', async () => {
    const vault = makeVault();
    storeLedger(vault, [INBOX], []);
    const pdf = vault.add(`${INBOX}/a.pdf`, undefined, 'pdf');
    const { watcher, importMany } = makeWatcher(
      { onFolder: true, folders: [INBOX] },
      vault
    );
    const outcomes = deferred<BulkOutcome[]>();
    importMany.mockImplementationOnce(() => outcomes.promise);

    const scan = watcher.runCatchUpScan();
    await vi.advanceTimersByTimeAsync(0);

    expect(importMany).toHaveBeenCalledOnce();
    expect(ledgerOf(vault)).toEqual({ folders: [INBOX], paths: [] });
    outcomes.resolve([{ file: pdf, status: 'imported' }]);
    await scan;
    expect(ledgerOf(vault)).toEqual({ folders: [INBOX], paths: [pdf.path] });
  });

  it('tries an arrival whose import failed again at the next launch', async () => {
    const vault = makeVault();
    const config = { onFolder: true, folders: [INBOX] };
    storeLedger(vault, [INBOX], []);
    const pdf = vault.add(`${INBOX}/a.pdf`, undefined, 'pdf');
    const failing = makeWatcher(config, vault, (v) =>
      makeImporter(v, () => ({ status: 'failed', reason: 'broken' }))
    );
    await failing.watcher.runCatchUpScan();
    failing.stop();

    const next = await launch(config, vault);

    expect(importedPaths(failing.importMany)).toEqual([[pdf.path]]);
    expect(importedPaths(next.importMany)).toEqual([[pdf.path]]);
    expect(seenPaths(vault)).toEqual(new Set([pdf.path]));
  });

  it('leaves an arrival being imported as the scan runs to that import, and stores it as seen once done', async () => {
    const vault = makeVault();
    storeLedger(vault, [INBOX], []);
    const { watcher, importMany, arrive } = makeWatcher(
      { onFolder: true, folders: [INBOX] },
      vault
    );
    const outcomes = deferred<BulkOutcome[]>();
    importMany.mockImplementationOnce(() => outcomes.promise);
    const pdf = vault.add(`${INBOX}/a.pdf`, undefined, 'pdf');
    arrive(pdf);
    await settle();
    expect(importMany).toHaveBeenCalledOnce();

    const scan = watcher.runCatchUpScan();
    expect(seenPaths(vault)).toEqual(new Set());
    outcomes.resolve([{ file: pdf, status: 'imported' }]);
    await scan;
    await settle();

    expect(importMany).toHaveBeenCalledOnce();
    expect(seenPaths(vault)).toEqual(new Set([pdf.path]));
  });

  it('leaves an arrival waiting behind another import as the scan runs to its own import, so it is imported once', async () => {
    const vault = makeVault();
    storeLedger(vault, [INBOX], []);
    const { watcher, importMany, arrive } = makeWatcher(
      { onFolder: true, folders: [INBOX] },
      vault,
      makeMarklessImporter
    );
    const outcomes = deferred<BulkOutcome[]>();
    const markless = importMany.getMockImplementation()!;
    importMany.mockImplementationOnce(async (entries, config) => {
      await outcomes.promise;
      return markless(entries, config);
    });
    const first = vault.add(`${INBOX}/first.pdf`, undefined, 'pdf');
    arrive(first);
    await settle();
    const second = vault.add(`${INBOX}/second.pdf`, undefined, 'pdf');
    arrive(second);
    await settle();
    expect(importMany).toHaveBeenCalledOnce();

    const scan = watcher.runCatchUpScan();
    expect(seenPaths(vault)).toEqual(new Set());
    outcomes.resolve([]);
    await scan;
    await settle();

    expect(importedPaths(importMany)).toEqual([[first.path], [second.path]]);
    expect(seenPaths(vault)).toEqual(new Set([first.path, second.path]));
  });

  it('leaves an empty note it found unseen until it has something in it, and imports it then', async () => {
    const vault = makeVault();
    storeLedger(vault, [INBOX], []);
    const note = vault.create(`${INBOX}/new.md`);
    const { watcher, importMany, change } = makeWatcher(
      { onFolder: true, folders: [INBOX] },
      vault
    );

    await watcher.runCatchUpScan();
    expect(importMany).not.toHaveBeenCalled();
    expect(seenPaths(vault)).toEqual(new Set());

    vault.edit(note, {});
    change(note);
    await settle();
    expect(importedPaths(importMany)).toEqual([[note.path]]);
    expect(seenPaths(vault)).toEqual(new Set([note.path]));
  });

  it('stores an arrival imported before the scan as seen, so a file left unmarked by its import is not imported again', async () => {
    const vault = makeVault();
    storeLedger(vault, [INBOX], []);
    const { watcher, importMany, arrive, change } = makeWatcher(
      { onFolder: true, folders: [INBOX] },
      vault,
      makeMarklessImporter
    );
    const note = vault.create(`${INBOX}/clip.md`);
    arrive(note);
    vault.edit(note, { title: 'Clip' });
    change(note);
    await settle();

    await watcher.runCatchUpScan();
    await settle();

    expect(importedPaths(importMany)).toEqual([[note.path]]);
    expect(seenPaths(vault)).toEqual(new Set([note.path]));
  });

  it('stores nothing for a flush that imported no arrival', async () => {
    const vault = makeVault();
    const { watcher, change } = makeWatcher(
      { onFolder: true, folders: [INBOX] },
      vault
    );
    await watcher.runCatchUpScan();
    const store = vi.spyOn(vault.app, 'saveLocalStorage');

    change(vault.add(`${INBOX}/tagged.md`, { tags: [TRIGGER] }));
    await settle();

    expect(ledgerWrites(store)).toBe(0);
  });

  it('leaves out of the ledger an arrival deleted, moved out of the watched folders, or failed while it was imported, and stores none once stopped', async () => {
    const vault = makeVault();
    storeLedger(vault, [INBOX], []);
    const { watcher, importMany, arrive } = makeWatcher(
      { onFolder: true, folders: [INBOX] },
      vault,
      (v) =>
        makeImporter(v, (file) =>
          file.path.includes('failing')
            ? { status: 'failed', reason: 'broken' }
            : { status: 'imported' }
        )
    );
    await watcher.runCatchUpScan();
    const files = ['kept', 'deleted', 'moved', 'failing'].map((name) =>
      vault.add(`${INBOX}/${name}.pdf`, undefined, 'pdf')
    );
    files.forEach(arrive);
    const outcomes = deferred<BulkOutcome[]>();
    const real = importMany.getMockImplementation()!;
    importMany.mockImplementationOnce(async (entries, config) => {
      await outcomes.promise;
      return real(entries, config);
    });
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_MAX_WAIT_MS);
    vault.remove(files[1]);
    vault.rename(files[2], 'notes/moved.pdf');
    outcomes.resolve([]);
    await settle();

    expect(seenPaths(vault)).toEqual(new Set([files[0].path]));
  });

  it('stores nothing for a flush that ends after the plugin stopped', async () => {
    const vault = makeVault();
    storeLedger(vault, [INBOX], []);
    const { watcher, importMany, arrive, stop } = makeWatcher(
      { onFolder: true, folders: [INBOX] },
      vault
    );
    await watcher.runCatchUpScan();
    const outcomes = deferred<BulkOutcome[]>();
    importMany.mockImplementationOnce(() => outcomes.promise);
    const pdf = vault.add(`${INBOX}/a.pdf`, undefined, 'pdf');
    arrive(pdf);
    await settle();

    stop();
    outcomes.resolve([{ file: pdf, status: 'imported' }]);
    await settle();

    expect(seenPaths(vault)).toEqual(new Set());
  });

  it('never takes a file it has seen in a watched folder for an arrival, however late it hears of its creation, and imports each it has not seen once', async () => {
    /**
     * A file in the watched folder at startup: whether an earlier launch saw
     * it, and when the watcher hears it was created, if it does: before the
     * startup scan, as a late `create` from the vault loading would, or after.
     */
    const fileArb = fc.record({
      extension: fc.constantFrom('md', 'pdf'),
      seen: fc.boolean(),
      heard: fc.constantFrom(null, 'beforeScan', 'afterScan'),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.array(fileArb, { maxLength: 6 }),
        // Whether a flush of what it heard of runs before the scan
        fc.boolean(),
        async (files, flushFirst) => {
          const vault = makeVault();
          const made = files.map(({ extension, ...file }, i) => ({
            ...file,
            file: vault.add(`${INBOX}/${i}.${extension}`, {}, extension),
          }));
          storeLedger(
            vault,
            [INBOX],
            made.filter(({ seen }) => seen).map(({ file }) => file.path)
          );
          const { watcher, importMany, arrive, stop } = makeWatcher(
            { onFolder: true, folders: [INBOX] },
            vault
          );
          const hear = (when: string) => {
            for (const { file, heard } of made) {
              if (heard === when) arrive(file);
            }
          };

          hear('beforeScan');
          if (flushFirst) await settle();
          await watcher.runCatchUpScan();
          hear('afterScan');
          await settle();
          stop();

          expect(importedPaths(importMany).flat().sort()).toEqual(
            made
              .filter(({ seen }) => !seen)
              .map(({ file }) => file.path)
              .sort()
          );
          expect(seenPaths(vault)).toEqual(
            new Set(made.map(({ file }) => file.path))
          );
        }
      )
    );
  });

  it('does nothing once stopped', async () => {
    const vault = makeVault();
    storeLedger(vault, [INBOX], []);
    vault.add(`${INBOX}/a.pdf`, undefined, 'pdf');
    const { watcher, importMany, stop } = makeWatcher(
      { onFolder: true, folders: [INBOX] },
      vault
    );
    stop();

    await watcher.runCatchUpScan();

    expect(importMany).not.toHaveBeenCalled();
    expect(ledgerOf(vault)).toEqual({ folders: [INBOX], paths: [] });
  });
});

describe('AutoImportWatcher, the ledger of watched folders, as settings change', () => {
  const CLIPS = 'Clips';

  it('takes a folder newly watched as seen as it is, so only what arrives in it later is imported', async () => {
    const vault = makeVault();
    const old = vault.add(`${CLIPS}/old.pdf`, undefined, 'pdf');
    const first = await launch({ onFolder: true, folders: [INBOX] }, vault);

    first.configure({ folders: [INBOX, CLIPS] });
    first.stop();
    const added = vault.add(`${CLIPS}/new.pdf`, undefined, 'pdf');
    const next = await launch(
      { onFolder: true, folders: [INBOX, CLIPS] },
      vault
    );

    expect(first.importMany).not.toHaveBeenCalled();
    expect(importedPaths(next.importMany)).toEqual([[added.path]]);
    expect(seenPaths(vault)).toEqual(new Set([old.path, added.path]));
  });

  it('forgets a folder no longer watched, so watching it again takes it as seen again', async () => {
    for (const unwatch of [
      { folders: [INBOX] },
      { onFolder: false },
    ] as const) {
      const vault = makeVault();
      const config = { onFolder: true, folders: [INBOX, CLIPS] };
      const kept = vault.add(`${INBOX}/kept.pdf`, undefined, 'pdf');
      const watching = await launch(config, vault);

      watching.configure(unwatch);
      const unwatched = ledgerOf(vault);
      const meanwhile = vault.add(`${CLIPS}/meanwhile.pdf`, undefined, 'pdf');
      watching.configure(config);
      watching.stop();
      const next = await launch(config, vault);

      expect(unwatched).toEqual(
        'folders' in unwatch
          ? { folders: [INBOX], paths: [kept.path] }
          : { folders: [], paths: [] }
      );
      expect(next.importMany).not.toHaveBeenCalled();
      expect(seenPaths(vault)).toEqual(new Set([kept.path, meanwhile.path]));
    }
  });

  it('keeps an unseen file in a folder still watched as one to import when another folder is added', async () => {
    const vault = makeVault();
    storeLedger(vault, [INBOX], []);
    const { configure, stop } = makeWatcher(
      { onFolder: true, folders: [INBOX] },
      vault
    );
    const unseen = vault.add(`${INBOX}/${CLIPS}/unseen.pdf`, undefined, 'pdf');

    configure({ folders: [INBOX, `${INBOX}/${CLIPS}`] });
    stop();
    const next = await launch(
      { onFolder: true, folders: [INBOX, `${INBOX}/${CLIPS}`] },
      vault
    );

    expect(importedPaths(next.importMany)).toEqual([[unseen.path]]);
  });

  it('takes what a newly watched folder holds once told as seen, a file it heard of arriving before then included, and imports what arrives after, and notes for their trigger tags', async () => {
    /**
     * A file in the folder about to be watched, and when the watcher hears
     * it was created: before the settings change, between the change and the
     * watcher being told of it, or after. A note is read as it is created,
     * or, if heard of in between, before the watcher is told or after.
     */
    const fileArb = fc.record({
      extension: fc.constantFrom('md', 'pdf'),
      heard: fc.constantFrom('beforeChange', 'beforeTold', 'afterTold'),
      readBeforeTold: fc.boolean(),
      tagged: fc.boolean(),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.array(fileArb, { maxLength: 6 }),
        fc.boolean(),
        async (files, enabled) => {
          const vault = makeVault();
          const watching = await launch(
            { enabled, onFolder: true, folders: [INBOX] },
            vault
          );
          const made = files.map((file, i) => ({
            ...file,
            path: `${CLIPS}/${i}.${file.extension}`,
            file: null as TFile | null,
          }));
          type Made = (typeof made)[number];
          const create = (one: Made) => {
            one.file = vault.create(one.path);
            watching.arrive(one.file);
          };
          const read = ({ file, extension, tagged }: Made) => {
            if (extension !== 'md') return;
            vault.edit(file!, tagged ? { tags: [TRIGGER] } : {});
            watching.change(file!);
          };

          for (const file of made) {
            if (file.heard !== 'beforeChange') continue;
            create(file);
            read(file);
          }
          watching.rewrite({ folders: [INBOX, CLIPS] });
          for (const file of made) {
            if (file.heard !== 'beforeTold') continue;
            create(file);
            if (file.readBeforeTold) read(file);
          }
          watching.watcher.configChanged();
          for (const file of made) {
            if (file.heard === 'beforeTold' && !file.readBeforeTold) {
              read(file);
            } else if (file.heard === 'afterTold') {
              create(file);
              read(file);
            }
          }
          await settle();
          watching.stop();

          expect(importedPaths(watching.importMany).flat().sort()).toEqual(
            made
              .filter(
                ({ heard, extension, tagged }) =>
                  heard === 'afterTold' ||
                  (enabled && tagged && extension === 'md')
              )
              .map(({ path }) => path)
              .sort()
          );
          expect(seenPaths(vault)).toEqual(
            new Set(made.map(({ path }) => path))
          );
        }
      )
    );
  });

  it('still imports a file it heard of arriving in a folder watched before, when a folder inside it is newly watched', async () => {
    const vault = makeVault();
    const watching = await launch({ onFolder: true, folders: [INBOX] }, vault);
    const inner = `${INBOX}/${CLIPS}`;
    const pdf = vault.add(`${inner}/a.pdf`, undefined, 'pdf');
    const note = vault.create(`${inner}/b.md`);
    watching.arrive(pdf);
    watching.arrive(note);

    watching.configure({ folders: [INBOX, inner] });
    vault.edit(note, {});
    watching.change(note);
    await settle();

    expect(importedPaths(watching.importMany)).toEqual([[pdf.path, note.path]]);
  });

  it('forgets a file it heard of arriving in a folder no longer watched, so watching it again takes it as seen', async () => {
    const vault = makeVault();
    const watching = await launch(
      { onFolder: true, folders: [INBOX, CLIPS] },
      vault
    );
    const pdf = vault.add(`${CLIPS}/a.pdf`, undefined, 'pdf');
    const note = vault.create(`${CLIPS}/b.md`);
    watching.arrive(pdf);
    watching.arrive(note);

    watching.configure({ folders: [INBOX] });
    watching.configure({ folders: [INBOX, CLIPS] });
    vault.edit(note, {});
    watching.change(note);
    await settle();

    expect(watching.importMany).not.toHaveBeenCalled();
    expect(seenPaths(vault)).toEqual(new Set([pdf.path, note.path]));
  });

  it('stores nothing while the folders watched stay the same, in whatever order', async () => {
    const vault = makeVault();
    const watching = await launch(
      { onFolder: true, folders: [INBOX, CLIPS] },
      vault
    );
    const store = vi.spyOn(vault.app, 'saveLocalStorage');

    watching.configure({ priority: 10 });
    watching.configure({ folders: [CLIPS, INBOX] });
    watching.configure({ onFolder: true });

    expect(ledgerWrites(store)).toBe(0);
  });

  it('stores no ledger before one is stored, nor once stopped', () => {
    const vault = makeVault();
    const { configure, stop } = makeWatcher(
      { onFolder: true, folders: [INBOX] },
      vault
    );
    configure({ folders: [INBOX, CLIPS] });
    expect(ledgerOf(vault)).toBeNull();
    stop();

    const stored = makeVault();
    storeLedger(stored, [INBOX], []);
    const stopped = makeWatcher({ onFolder: true, folders: [INBOX] }, stored);
    stopped.configure({ folders: [INBOX, CLIPS] });
    stopped.stop();
    stopped.configure({ folders: [CLIPS] });
    expect(ledgerOf(stored)).toEqual({ folders: [INBOX, CLIPS], paths: [] });
  });

  it('takes a folder swapped in for another as newly watched, and forgets the other', async () => {
    const vault = makeVault();
    const inbox = vault.add(`${INBOX}/a.pdf`, undefined, 'pdf');
    vault.add(`${CLIPS}/b.pdf`, undefined, 'pdf');
    const papers = vault.add('Papers/c.pdf', undefined, 'pdf');
    const watching = await launch(
      { onFolder: true, folders: [INBOX, CLIPS] },
      vault
    );

    watching.configure({ folders: [INBOX, 'Papers'] });

    expect(ledgerOf(vault)).toEqual({
      folders: [INBOX, 'Papers'],
      paths: [inbox.path, papers.path],
    });
  });
});

describe('AutoImportWatcher, the ledger of watched folders, as files move and go', () => {
  /** A watcher caught up over a vault with `paths` in it, all seen. */
  async function makeCaughtUp(...paths: string[]) {
    const vault = makeVault();
    const files = paths.map((path) => vault.add(path, undefined, 'pdf'));
    const watching = await launch({ onFolder: true, folders: [INBOX] }, vault);
    return { ...watching, files };
  }

  /** Tell `watcher` `file` was deleted, as the plugin does. */
  const deleteFile = (
    { vault, watcher }: Awaited<ReturnType<typeof makeCaughtUp>>,
    file: TFile
  ) => {
    vault.remove(file);
    watcher.noteDeletion(file);
  };

  it('records an arrival it passes over at once, so it is not found arrived at the next launch once it no longer has what kept it out', async () => {
    const watching = await makeCaughtUp();
    const { vault } = watching;
    // Delivered by Sync, or an article moved in: the `ir-id` keeps it out
    vault.rows.add('id-synced');
    const synced = vault.add(`${INBOX}/synced.md`, { 'ir-id': 'id-synced' });
    watching.arrive(synced);
    const moved = vault.add('notes/moved.md', { 'ir-id': 'id-moved' });
    vault.rows.add('id-moved');
    watching.move(moved, `${INBOX}/moved.md`);
    const snippet = vault.add(`${INBOX}/snippet.md`, { tags: [SNIPPET_TAG] });
    watching.arrive(snippet);
    const image = vault.create(`${INBOX}/image.png`);
    watching.arrive(image);
    await settle();
    expect(seenPaths(vault)).toEqual(
      new Set([synced.path, `${INBOX}/moved.md`, snippet.path, image.path])
    );
    // Un-imported, and untagged
    vault.rows.clear();
    vault.edit(synced, {});
    vault.edit(moved, {});
    vault.edit(snippet, {});
    watching.stop();

    const next = await launch({ onFolder: true, folders: [INBOX] }, vault);

    expect(watching.importMany).not.toHaveBeenCalled();
    expect(next.importMany).not.toHaveBeenCalled();
  });

  it('leaves an arrival it passes over unrecorded when its import failed before, so the next launch tries it again', async () => {
    const vault = makeVault();
    const config = { onFolder: true, folders: [INBOX] };
    const watching = await launch(config, vault, (v) =>
      makeImporter(v, () => ({ status: 'failed', reason: 'broken' }))
    );
    const note = vault.add(`${INBOX}/a.md`, {});
    watching.arrive(note);
    await settle();
    // Back again, moved out and in
    watching.move(note, 'notes/a.md');
    watching.move(note, `${INBOX}/a.md`);
    await settle();
    watching.stop();

    const next = await launch(config, vault);

    expect(importedPaths(watching.importMany)).toEqual([[note.path]]);
    expect(importedPaths(next.importMany)).toEqual([[note.path]]);
  });

  it('moves a file moved within the watched folders to where it now is, in a moment', async () => {
    const watching = await makeCaughtUp(`${INBOX}/a.pdf`);
    const store = vi.spyOn(watching.vault.app, 'saveLocalStorage');

    watching.move(watching.files[0], `${INBOX}/sub/a.pdf`);
    watching.move(watching.files[0], `${INBOX}/b.pdf`);
    expect(seenPaths(watching.vault)).toEqual(new Set([`${INBOX}/a.pdf`]));
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);

    expect(seenPaths(watching.vault)).toEqual(new Set([`${INBOX}/b.pdf`]));
    expect(ledgerWrites(store)).toBe(1);
    expect(watching.importMany).not.toHaveBeenCalled();
    watching.stop();
    const next = await launch(
      { onFolder: true, folders: [INBOX] },
      watching.vault
    );
    expect(next.importMany).not.toHaveBeenCalled();
  });

  it('forgets a file moved out, so one moved back while Obsidian was closed is imported', async () => {
    const watching = await makeCaughtUp(`${INBOX}/a.pdf`, `${INBOX}/b.pdf`);
    const [file] = watching.files;

    watching.move(file, 'notes/a.pdf');
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);
    expect(seenPaths(watching.vault)).toEqual(new Set([`${INBOX}/b.pdf`]));
    watching.stop();
    watching.vault.rename(file, `${INBOX}/a.pdf`);
    const next = await launch(
      { onFolder: true, folders: [INBOX] },
      watching.vault
    );

    expect(importedPaths(next.importMany)).toEqual([[`${INBOX}/a.pdf`]]);
  });

  it('forgets a deleted file, so a file written to its path while Obsidian was closed is imported', async () => {
    const watching = await makeCaughtUp(`${INBOX}/a.pdf`, `${INBOX}/b.pdf`);

    deleteFile(watching, watching.files[0]);
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);
    expect(seenPaths(watching.vault)).toEqual(new Set([`${INBOX}/b.pdf`]));
    watching.stop();
    watching.vault.add(`${INBOX}/a.pdf`, undefined, 'pdf');
    const next = await launch(
      { onFolder: true, folders: [INBOX] },
      watching.vault
    );

    expect(importedPaths(next.importMany)).toEqual([[`${INBOX}/a.pdf`]]);
  });

  it('imports a file arriving while it runs once, not again when told late it was created, un-imported or not, but again once deleted and written anew at its path', async () => {
    const watching = await makeCaughtUp();
    const { vault, arrive, change, importMany } = watching;
    /** Create a PDF and a note at `paths`, telling the watcher, and read both. */
    const arriveBoth = (...paths: string[]) => {
      const made = paths.map((path) => vault.create(path));
      for (const file of made) arrive(file);
      vault.edit(made[1], {});
      change(made[1]);
      return made;
    };
    const [pdf, note] = arriveBoth(`${INBOX}/a.pdf`, `${INBOX}/b.md`);
    await settle();

    arrive(pdf);
    arrive(note);
    await settle();
    // Un-imported: the rows gone, the note's `ir-id` stripped
    vault.rows.clear();
    vault.edit(note, {});
    change(note);
    arrive(pdf);
    arrive(note);
    await settle();
    expect(importedPaths(importMany)).toEqual([[pdf.path, note.path]]);

    deleteFile(watching, pdf);
    deleteFile(watching, note);
    arriveBoth(pdf.path, note.path);
    await settle();

    expect(importedPaths(importMany)).toEqual([
      [pdf.path, note.path],
      [pdf.path, note.path],
    ]);
  });

  it('forgets every file in a deleted folder', async () => {
    const watching = await makeCaughtUp(
      `${INBOX}/sub/a.pdf`,
      `${INBOX}/sub/deeper/b.pdf`,
      `${INBOX}/sub2/c.pdf`,
      `${INBOX}/d.pdf`
    );
    const folder = Object.assign(new TFolder(), { path: `${INBOX}/sub` });

    watching.watcher.noteDeletion(folder);
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);

    expect(seenPaths(watching.vault)).toEqual(
      new Set([`${INBOX}/sub2/c.pdf`, `${INBOX}/d.pdf`])
    );
  });

  it('stores at once, as the plugin stops, what a move or deletion changed', async () => {
    const watching = await makeCaughtUp(`${INBOX}/a.pdf`, `${INBOX}/b.pdf`);

    deleteFile(watching, watching.files[0]);
    watching.stop();

    expect(seenPaths(watching.vault)).toEqual(new Set([`${INBOX}/b.pdf`]));
  });

  it('stores nothing for a move or deletion of a file it has not seen, or once stopped, or with no ledger stored', async () => {
    const watching = await makeCaughtUp(`${INBOX}/a.pdf`);
    const store = vi.spyOn(watching.vault.app, 'saveLocalStorage');
    const unseen = watching.vault.add('notes/x.pdf', undefined, 'pdf');
    const emptyFolder = Object.assign(new TFolder(), { path: 'notes' });

    watching.move(unseen, 'notes/y.pdf');
    deleteFile(watching, unseen);
    watching.watcher.noteDeletion(emptyFolder);
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);
    watching.stop();
    deleteFile(watching, watching.files[0]);
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);
    const fresh = makeWatcher({ onFolder: true, folders: [INBOX] });
    fresh.watcher.noteDeletion(fresh.vault.add(`${INBOX}/z.pdf`));
    await vi.advanceTimersByTimeAsync(AUTO_IMPORT_DEBOUNCE_MS);

    expect(ledgerWrites(store)).toBe(0);
    expect(ledgerOf(fresh.vault)).toBeNull();
  });
});
