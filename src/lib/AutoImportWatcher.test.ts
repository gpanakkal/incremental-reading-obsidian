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
  AUTO_IMPORT_TAG,
  AUTO_IMPORT_WATERMARK_SLACK_MS,
  CARD_TAG,
  DATA_DIRECTORY,
  SNIPPET_TAG,
} from './constants';
import {
  loadAutoImportWatermark,
  saveAutoImportWatermark,
} from './plugin-data';
import { matchFrontmatterTags, stripFrontmatterTags } from './tags';

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
 * Imports as the plugin does in copy mode: a copy of each note is made under
 * `copies/`, carrying its frontmatter, with an `ir-id` a row holds and the
 * article tag, and the note loses the trigger tags it was imported by.
 */
function makeCopyImporter(vault: Vault) {
  return vi.fn(
    (entries: readonly AutoImportEntry[], _config: AutoImportConfig) =>
      Promise.resolve(
        entries.map(({ file, matchedTags }): BulkOutcome => {
          const frontmatter: Record<string, unknown> =
            vault.cacheOf(file)?.frontmatter ?? {};
          const path = `copies/${file.path}`;
          const id = `id-${path}`;
          vault.rows.add(id);
          vault.add(path, {
            ...frontmatter,
            'ir-id': id,
            tags: [...[frontmatter.tags].flat(), 'ir-article'],
          });
          const left = structuredClone(frontmatter);
          stripFrontmatterTags(left, matchedTags);
          vault.edit(file, left);
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
    mode: 'inPlace',
    ...NO_FOLDERS,
    ...config,
  };
  const importMany = makeImport(vault);
  const hasRow = makeRowLookup(vault);
  const watcher = new AutoImportWatcher({
    app: vault.app,
    getConfig: () => current,
    importMany,
    hasRow,
  });
  const stop = watcher.start();
  return {
    vault,
    watcher,
    importMany,
    hasRow,
    stop,
    /** Change the settings, telling the watcher as the plugin does. */
    configure: (change: Partial<AutoImportConfig>) => {
      current = { ...current, ...change };
      watcher.configChanged();
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

  it('looks a note up by ir-id only when it carries one as a string, importing those no row holds', async () => {
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
          expect(hasRow.mock.calls.map(([id]) => id)).toEqual(ids);
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

  it('imports nothing before it starts or after it stops', async () => {
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
    configure({ priority: 42, mode: 'copy' });

    await settle();

    expect(importMany.mock.calls[0][1]).toMatchObject({
      priority: 42,
      mode: 'copy',
    });
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
        mode: 'inPlace',
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
              mode: 'inPlace',
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
          mode: 'inPlace',
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
        mode: 'inPlace',
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

describe('AutoImportWatcher in copy mode', () => {
  it('hands on only the trigger tags a note carries, for a copy import to take off it', async () => {
    const { vault, change, importMany } = makeWatcher(
      { triggerTags: [TRIGGER, 'clipped'], mode: 'copy' },
      makeVault(),
      makeCopyImporter
    );
    const file = vault.add('clip.md', { tags: ['#Clipped', 'other'] });
    change(file);

    await settle();

    expect(importMany.mock.calls).toEqual([
      [
        [{ file, matchedTags: ['clipped'] }],
        expect.objectContaining({ mode: 'copy' }),
      ],
    ]);
    expect(vault.cacheOf(file)).toEqual({ frontmatter: { tags: ['other'] } });
  });

  it('never imports again after a copy import, however often the note or its copy changes', async () => {
    const triggersArb = fc.subarray([TRIGGER, 'clipped', 'to-read'], {
      minLength: 1,
    });
    const tagsArb = fc.subarray([TRIGGER, '#Clipped', 'TO-READ', 'Other'], {
      minLength: 1,
    });
    await fc.assert(
      fc.asyncProperty(
        triggersArb,
        tagsArb,
        fc.array(fc.boolean(), { maxLength: 6 }),
        async (triggerTags, tags, changes) => {
          vi.clearAllTimers();
          const { vault, change, importMany, hasRow } = makeWatcher(
            { triggerTags, mode: 'copy' },
            makeVault(),
            makeCopyImporter
          );
          const original = vault.add('clip.md', { tags, title: 'Clip' });
          const matched = matchFrontmatterTags({ tags }, triggerTags);
          change(original);
          await settle();
          const copy = vault.app.vault.getFileByPath('copies/clip.md');

          // Each change the import made, and any more, as Obsidian tells of
          for (const ofCopy of [false, true, ...changes]) {
            const target = ofCopy ? copy : original;
            if (target) change(target);
            await settle();
          }

          expect(importMany).toHaveBeenCalledTimes(matched.length > 0 ? 1 : 0);
          if (matched.length === 0) return;
          expect(importMany.mock.calls[0][0]).toEqual([
            { file: original, matchedTags: matched },
          ]);
          // The note keeps every tag but those, the copy carries them
          const kept = tags.filter(
            (tag) => matchFrontmatterTags({ tags: [tag] }, matched).length === 0
          );
          expect(vault.cacheOf(original)).toEqual({
            frontmatter: {
              title: 'Clip',
              ...(kept.length > 0 && { tags: kept }),
            },
          });
          expect(
            matchFrontmatterTags(vault.cacheOf(copy!)?.frontmatter, triggerTags)
          ).toEqual(matched);
          // Only the copy's ir-id is ever looked up
          expect(new Set(hasRow.mock.calls.map(([id]) => id))).toEqual(
            new Set(['id-copies/clip.md'])
          );
        }
      ),
      { numRuns: 60 }
    );
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
          expect(store.mock.calls.length).toBe(
            stored !== null && stored >= now ? 0 : 1
          );
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
          mode: 'inPlace',
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
          mode: 'inPlace',
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
