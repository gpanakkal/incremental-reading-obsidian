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
import { TFile, type CachedMetadata } from 'obsidian';
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
  CARD_TAG,
  SNIPPET_TAG,
} from './constants';
import { matchFrontmatterTags, stripFrontmatterTags } from './tags';

// #region HELPERS

const TRIGGER = AUTO_IMPORT_TAG;

/**
 * A vault the watcher reads files and their cached metadata from, and the ids
 * its database holds rows for, deleted or not.
 */
function makeVault() {
  const files = new Map<string, TFile>();
  const caches = new Map<TFile, CachedMetadata | null>();
  return {
    rows: new Set<string>(),
    app: {
      vault: {
        getFileByPath: (path: string) => files.get(path) ?? null,
      },
      metadataCache: {
        getFileCache: (file: TFile) => caches.get(file) ?? null,
      },
    },
    /** A note at `path`, its frontmatter `frontmatter`; none when undefined. */
    add: (path: string, frontmatter?: Record<string, unknown>) => {
      const file = Object.assign(new TFile(), { path, extension: 'md' });
      files.set(path, file);
      caches.set(file, frontmatter === undefined ? {} : { frontmatter });
      return file;
    },
    /** Re-index `file` with `frontmatter`; none when undefined. */
    edit: (file: TFile, frontmatter?: Record<string, unknown>) => {
      caches.set(file, frontmatter === undefined ? {} : { frontmatter });
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

/** A started watcher over a fresh vault, with the config it reads changeable. */
function makeWatcher(
  config: Partial<AutoImportConfig> = {},
  makeImport: typeof makeImporter = makeImporter
) {
  const vault = makeVault();
  let current: AutoImportConfig = {
    enabled: true,
    triggerTags: [TRIGGER],
    priority: 30,
    mode: 'inPlace',
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
    configure: (change: Partial<AutoImportConfig>) => {
      current = { ...current, ...change };
    },
    /** Tell the watcher `file` was re-indexed as its cache now stands. */
    change: (file: TFile) => {
      watcher.consider(file, vault.cacheOf(file));
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
    expect(Notice.messages).toEqual(['Imported 2 articles']);

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
            ...(imported === 0
              ? []
              : [`Imported ${imported} article${imported === 1 ? '' : 's'}`]),
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
        ...(level === 'none' ? [] : ['Imported 1 article']),
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
