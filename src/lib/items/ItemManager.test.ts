import {
  MAXIMUM_PRIORITY,
  MINIMUM_PRIORITY,
  MS_PER_YEAR,
} from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { refusalReason } from '#/lib/readiness';
import type { IArticleBase, NoteType, SQLiteRepository } from '#/lib/types';
import {
  makeItemVault,
  runOutMergeWait,
  TestRepository,
} from '#/test/item-vault';
import fc from 'fast-check';
import type { CachedMetadata, TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ItemManager } from './ItemManager';
import { purgedReference } from './row-delete';

// #region HELPERS
/** Opens the protected `reprioritizeText` and `reconcileNote` to the tests. */
class TestManager extends ItemManager {
  reprioritize(
    ...args: Parameters<ItemManager['reprioritizeText']>
  ): Promise<void> {
    return this.reprioritizeText(...args);
  }

  reconcile(
    row: ReconcileRow,
    file: TFile,
    type: NoteType,
    // The tag a note of this type carries, which nothing writes back (0166)
    _tag: string
  ): boolean {
    return this.reconcileNote(row, file, type);
  }
}

function makeRepo() {
  const mutate = vi.fn().mockResolvedValue([[]]);
  const repo = {
    query: vi.fn().mockResolvedValue([]),
    mutate,
  } as unknown as SQLiteRepository;
  return { repo, mutate };
}

/**
 * A manager whose metadata cache answers `cache` for every note, with the
 * writes it can make spied on and stubbed out.
 */
function wire(cache: CachedMetadata | null) {
  const { repo, mutate } = makeRepo();
  const manager = new TestManager(
    {
      app: { metadataCache: { getFileCache: vi.fn(() => cache) } },
    } as never,
    repo
  );
  // Every frontmatter write the managers make goes through here
  const writeNote = vi
    .spyOn(Obsidian, 'updateFrontMatter')
    .mockResolvedValue(undefined);
  const markDeleted = vi
    .spyOn(manager, 'markDeleted')
    .mockResolvedValue(undefined);
  const markUndeleted = vi
    .spyOn(manager, 'markUndeleted')
    .mockResolvedValue(undefined);
  return { manager, mutate, writeNote, markDeleted, markUndeleted };
}

const FILE = { path: 'notes/item.md', extension: 'md' } as TFile;

/** The row `reconcileNote` squares with its note. */
interface ReconcileRow {
  id: string;
  deleted: boolean;
  reference: string;
  note_mtime: number | null;
}

/** The note at `FILE`'s path, last modified at `mtime` (no stat when null). */
const noteAt = (mtime: number | null) =>
  (mtime === null
    ? { ...FILE }
    : { ...FILE, stat: { ctime: 0, mtime, size: 0 } }) as TFile;

// Row ids are UUIDs; any non-empty string stands in for one. A row is live,
// tombstoned, or deleted for good (its reference let go to the sentinel).
const rowArb: fc.Arbitrary<ReconcileRow> = fc
  .record({
    id: fc.string({ minLength: 1 }),
    state: fc.constantFrom('live', 'tombstoned', 'purged'),
    note_mtime: fc.option(fc.integer({ min: 1 }), { nil: null }),
  })
  .map(({ id, state, note_mtime }) => ({
    id,
    deleted: state !== 'live',
    reference: state === 'purged' ? purgedReference(id) : FILE.path,
    note_mtime,
  }));

/**
 * The note's mtime against the row's fingerprint: the same, a millisecond
 * either side, anything at all, or none to read.
 */
const noteMtimeArb = (row: ReconcileRow): fc.Arbitrary<number | null> =>
  fc.oneof(
    fc.constant(row.note_mtime),
    fc.constant(row.note_mtime === null ? null : row.note_mtime + 1),
    fc.constant(row.note_mtime === null ? null : row.note_mtime - 1),
    fc.integer({ min: 0 }),
    fc.constant(null)
  );

/** Whether the note's mtime proves it is the one the row was written with. */
const proven = (row: ReconcileRow, noteMtime: number | null) =>
  row.note_mtime !== null && noteMtime === row.note_mtime;
const typeArb = fc.constantFrom<NoteType>('article', 'snippet', 'card');

/** Whatever YAML can put under a key: absent, null, scalars, lists. */
const yamlValueArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.array(fc.oneof(fc.string(), fc.integer(), fc.constant(null)))
);

/**
 * A row, the tag its type carries, and a settled cache entry for the note at
 * its reference: no frontmatter, or frontmatter whose `ir-id` and `tags` may
 * each be missing, the row's own, or anything else.
 */
const settledArb = fc
  .record({ row: rowArb, type: typeArb, tag: fc.string() })
  .chain(({ row, type, tag }) => {
    const irIdArb = fc.oneof(yamlValueArb, fc.constant(row.id));
    const tagsArb = fc.oneof(
      yamlValueArb,
      fc.constant(tag),
      fc
        .tuple(fc.array(fc.string()), fc.array(fc.string()))
        .map(([before, after]) => [...before, tag, ...after])
    );
    const frontmatterArb = fc.oneof(
      fc.constant(undefined),
      fc.record(
        { 'ir-id': irIdArb, tags: tagsArb, other: fc.string() },
        { requiredKeys: [] }
      )
    );
    return fc.record({
      row: fc.constant(row),
      type: fc.constant(type),
      tag: fc.constant(tag),
      frontmatter: frontmatterArb,
      noteMtime: noteMtimeArb(row),
    });
  });

/**
 * A file with no frontmatter: `pdf` in every casing, or any other extension
 * that isn't some casing of `md`, the empty one included.
 */
const binaryFileArb = fc
  .tuple(
    fc.string(),
    fc.oneof(
      fc.mixedCase(fc.constant('pdf')),
      fc.string().filter((ext) => ext.toLowerCase() !== 'md')
    )
  )
  .map(
    ([name, extension]) =>
      ({ path: `${name}.${extension}`, extension }) as TFile
  );

/** The note type each table's rows are. */
const TABLE_TYPE = {
  article: 'article',
  snippet: 'snippet',
  srs_card: 'card',
} as const;
/** A table, or no row at all. */
const tableArb = fc.option(
  fc.constantFrom<keyof typeof TABLE_TYPE>('article', 'snippet', 'srs_card'),
  { nil: null }
);
/** Opens the protected `deleteWithNote` to the tests. */
class DeletingManager extends ItemManager {
  delete(
    table: 'snippet' | 'srs_card',
    id: string,
    options: { prompt?: boolean }
  ) {
    return this.deleteWithNote(table, id, options, 'delete the item');
  }
}

/** Where the note of each item that {@link wireDelete} makes is. */
const ITEM_NOTE = 'items/note.md';

/** An item's row, of either table with a note, as the schema accepts it. */
const itemRowArb = fc.record({
  table: fc.constantFrom('snippet' as const, 'srs_card' as const),
  id: fc.uuid(),
  due: fc.integer({ min: 0, max: 2 ** 42 }),
  dismissed: fc.boolean(),
  reviews: fc.uniqueArray(fc.uuid(), { maxLength: 3 }),
});
type ItemRowCase = typeof itemRowArb extends fc.Arbitrary<infer T> ? T : never;

/**
 * The item `row` with its note at {@link ITEM_NOTE} and its reviews, a
 * manager over them, and Obsidian's prompt answering `confirm`.
 */
async function wireDelete(row: ItemRowCase, confirm = true) {
  const vault = makeItemVault({
    [ITEM_NOTE]: { 'ir-id': row.id, tags: ['ir-snippet'] },
  });
  const promptForFileDeletion = vi.fn(async (file: TFile) => {
    if (!confirm) return false;
    await vault.app.fileManager.trashFile(file);
    return true;
  });
  Object.assign(vault.app.fileManager, { promptForFileDeletion });
  const repo = await TestRepository.create();
  const dismissed = Number(row.dismissed);
  if (row.table === 'snippet') {
    repo.mutate(
      `INSERT INTO snippet (id, reference, due, interval, priority, dismissed) VALUES ($1, $2, $3, 1, 30, $4)`,
      [row.id, ITEM_NOTE, row.due, dismissed]
    );
    for (const review of row.reviews) {
      repo.mutate(
        `INSERT INTO snippet_review (id, snippet_id, review_time) VALUES ($1, $2, $3)`,
        [review, row.id, row.due]
      );
    }
  } else {
    repo.mutate(
      `INSERT INTO srs_card (id, reference, created_at, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, dismissed) VALUES ($1, $2, 0, $3, 0, 0, 0, 0, 0, 0, 0, 0, $4)`,
      [row.id, ITEM_NOTE, row.due, dismissed]
    );
    for (const review of row.reviews) {
      repo.mutate(
        `INSERT INTO srs_card_review (id, card_id, due, review, stability, difficulty, elapsed_days, last_elapsed_days, scheduled_days, learning_steps, rating, state) VALUES ($1, $2, 0, $3, 0, 0, 0, 0, 0, 0, 1, 0)`,
        [review, row.id, row.due]
      );
    }
  }
  const log = row.table === 'snippet' ? 'snippet_review' : 'srs_card_review';
  // What is live, as readers see it: a tombstone is no row to them, and a
  // stamp is no content, which a write that puts a row back renews
  const live = (rows: Record<string, unknown>[]) =>
    rows
      .filter(({ deleted }) => deleted === 0)
      .map(({ updated_at: _at, updated_by: _by, ...content }) => content);
  const stored = () => ({
    rows: live(repo.rows(row.table)),
    reviews: live(repo.rows(log)),
  });
  const before = stored();
  vi.spyOn(console, 'error').mockReturnValue(undefined);
  const notify = vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
  const manager = new DeletingManager({ app: vault.app } as never, repo);
  return {
    vault,
    repo,
    manager,
    before,
    stored,
    notify,
    promptForFileDeletion,
  };
}

// #endregion

describe('reconcileNote', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves a note the cache is still re-reading alone and keeps the row', async () => {
    await fc.assert(
      fc.asyncProperty(rowArb, typeArb, fc.string(), async (row, type, tag) => {
        const { manager, mutate, writeNote, markDeleted, markUndeleted } =
          wire(null);

        expect(manager.reconcile(row, FILE, type, tag)).toBe(true);

        expect(writeNote).not.toHaveBeenCalled();
        expect(markDeleted).not.toHaveBeenCalled();
        expect(markUndeleted).not.toHaveBeenCalled();
        expect(mutate).not.toHaveBeenCalled();
      })
    );
  });

  it('refuses the row a note claiming another id, tombstoning a live row only when the note is provably the one it was written with', async () => {
    await fc.assert(
      fc.asyncProperty(
        settledArb.filter(
          ({ row, frontmatter }) =>
            Boolean(frontmatter?.['ir-id']) && frontmatter?.['ir-id'] !== row.id
        ),
        async ({ row, type, tag, frontmatter, noteMtime }) => {
          const { manager, writeNote, markDeleted, markUndeleted } = wire({
            // The read normalizes `tags` in place; keep the generated value intact
            frontmatter: structuredClone(frontmatter),
          } as CachedMetadata);

          expect(manager.reconcile(row, noteAt(noteMtime), type, tag)).toBe(
            false
          );

          expect(markDeleted.mock.calls).toStrictEqual(
            !row.deleted && proven(row, noteMtime) ? [[row.id, type]] : []
          );
          expect(writeNote).not.toHaveBeenCalled();
          expect(markUndeleted).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('keeps the row for a note making no other claim, and never lifts a tombstone', async () => {
    // A note missing its id or tag may be newer than the row: stripped by an
    // un-import on another device and synced here first (0166)
    await fc.assert(
      fc.asyncProperty(
        settledArb.filter(
          ({ row, frontmatter }) =>
            !frontmatter?.['ir-id'] || frontmatter['ir-id'] === row.id
        ),
        async ({ row, type, tag, frontmatter, noteMtime }) => {
          const { manager, writeNote, markDeleted, markUndeleted } = wire({
            // The read normalizes `tags` in place; keep the generated value intact
            frontmatter: structuredClone(frontmatter),
          } as CachedMetadata);

          expect(manager.reconcile(row, noteAt(noteMtime), type, tag)).toBe(
            true
          );

          // Not even for a note carrying the row's id that is provably the
          // one it was written with: a restore revives the row through
          // `handleCreation`, and trashing keeps mtime, so a note trashed on
          // another device reads the same until Sync brings its deletion
          expect(markUndeleted).not.toHaveBeenCalled();
          expect(writeNote).not.toHaveBeenCalled();
          expect(markDeleted).not.toHaveBeenCalled();
        }
      )
    );
  });

  // The notes Sync delivers may not have landed with the database (0174)
  it('judges the note but repairs no row during the refetch after a reload', async () => {
    await fc.assert(
      fc.asyncProperty(
        settledArb,
        fc.integer({ min: 0 }),
        async ({ row, type, tag, frontmatter }, mtime) => {
          const claimsOther =
            Boolean(frontmatter?.['ir-id']) &&
            frontmatter?.['ir-id'] !== row.id;
          const { manager, mutate, writeNote, markDeleted, markUndeleted } =
            wire({
              frontmatter: structuredClone(frontmatter),
            } as CachedMetadata);
          Object.assign(manager.repo, { refetchingAfterReload: true });
          // A live row and a note that is provably its own, so that only the
          // refetch keeps a note claiming another id from tombstoning it
          const live = { ...row, deleted: false, note_mtime: mtime };

          expect(manager.reconcile(live, noteAt(mtime), type, tag)).toBe(
            !claimsOther
          );

          expect(markDeleted).not.toHaveBeenCalled();
          expect(markUndeleted).not.toHaveBeenCalled();
          expect(mutate).not.toHaveBeenCalled();
          expect(writeNote).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('never touches a row deleted for good, whatever its note says', async () => {
    await fc.assert(
      fc.asyncProperty(
        settledArb,
        fc.integer({ min: 0 }),
        async ({ row, type, tag, frontmatter }, mtime) => {
          const { manager, mutate, markDeleted, markUndeleted } = wire({
            frontmatter: structuredClone(frontmatter),
          } as CachedMetadata);
          const purged = {
            ...row,
            deleted: true,
            reference: purgedReference(row.id),
            note_mtime: mtime,
          };

          manager.reconcile(purged, noteAt(mtime), type, tag);

          expect(markDeleted).not.toHaveBeenCalled();
          expect(markUndeleted).not.toHaveBeenCalled();
          expect(mutate).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('reads a row with no fingerprint recorded as proving nothing about its note', () => {
    const { manager, markDeleted, markUndeleted } = wire({
      frontmatter: { 'ir-id': 'someone-else' },
    } as unknown as CachedMetadata);
    // As a row read before its table had the column
    const unrecorded = {
      id: 'a1',
      deleted: false,
      reference: FILE.path,
    } as ReconcileRow;

    expect(
      manager.reconcile(unrecorded, noteAt(5), 'article', 'ir-article')
    ).toBe(false);
    expect(markDeleted).not.toHaveBeenCalled();
    expect(markUndeleted).not.toHaveBeenCalled();
  });

  it('judges the note once its parse lands', () => {
    const cache: { current: CachedMetadata | null } = { current: null };
    const { manager, writeNote, markDeleted } = wire(null);
    vi.spyOn(manager.app.metadataCache, 'getFileCache').mockImplementation(
      () => cache.current
    );
    const row = {
      id: 'a1',
      deleted: false,
      reference: FILE.path,
      note_mtime: 1_000,
    };

    expect(manager.reconcile(row, noteAt(1_000), 'article', 'ir-article')).toBe(
      true
    );
    expect(markDeleted).not.toHaveBeenCalled();

    cache.current = {
      frontmatter: { 'ir-id': 'b2', tags: ['ir-article'] },
    } as unknown as CachedMetadata;
    expect(manager.reconcile(row, noteAt(1_000), 'article', 'ir-article')).toBe(
      false
    );
    expect(markDeleted.mock.calls).toStrictEqual([['a1', 'article']]);
    expect(writeNote).not.toHaveBeenCalled();
  });
});

describe('reconcileNote on a file without frontmatter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the row by path alone, writing nothing to the file or the row', async () => {
    await fc.assert(
      fc.asyncProperty(
        settledArb,
        fc.boolean(),
        binaryFileArb,
        async ({ row, type, tag, frontmatter }, settled, file) => {
          // Whatever the cache holds for it, a PDF's frontmatter is not the
          // row's to read or repair
          const { manager, writeNote, markDeleted, markUndeleted } = wire(
            settled
              ? ({
                  frontmatter: structuredClone(frontmatter),
                } as CachedMetadata)
              : null
          );

          expect(manager.reconcile(row, file, type, tag)).toBe(true);

          expect(writeNote).not.toHaveBeenCalled();
          expect(markDeleted).not.toHaveBeenCalled();
          expect(markUndeleted).not.toHaveBeenCalled();
        }
      )
    );
  });
});

describe('getItemType', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('types a file without frontmatter by the row at its path, never reading the file', async () => {
    await fc.assert(
      fc.asyncProperty(binaryFileArb, tableArb, async (file, table) => {
        const processFrontMatter = vi.fn();
        const manager = new TestManager(
          { app: { fileManager: { processFrontMatter } } } as never,
          makeRepo().repo
        );
        const findItem = vi
          .spyOn(manager, 'findItem')
          .mockResolvedValue(table && ({ table } as never));
        const getNoteType = vi.spyOn(Obsidian, 'getNoteType');
        getNoteType.mockClear();

        const type = await manager.getItemType(file);

        expect(type).toBe(table && TABLE_TYPE[table]);
        expect(findItem).toHaveBeenCalledExactlyOnceWith(file);
        expect(getNoteType).not.toHaveBeenCalled();
        expect(processFrontMatter).not.toHaveBeenCalled();
      })
    );
  });

  it('types a markdown note by its tags alone, whatever the rows say', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(typeArb, { nil: null }),
        tableArb,
        async (noteType, table) => {
          const app = {};
          const manager = new TestManager({ app } as never, makeRepo().repo);
          const findItem = vi
            .spyOn(manager, 'findItem')
            .mockResolvedValue(table && ({ table } as never));
          const getNoteType = vi
            .spyOn(Obsidian, 'getNoteType')
            .mockResolvedValue(noteType);
          getNoteType.mockClear();

          await expect(manager.getItemType(FILE)).resolves.toBe(noteType);
          expect(getNoteType).toHaveBeenCalledExactlyOnceWith(FILE, app);
          expect(findItem).not.toHaveBeenCalled();
        }
      )
    );
  });
});

// #region SOURCE HELPERS
/** Whether the round brackets in `text` balance. */
const balanced = (text: string) => {
  let depth = 0;
  for (const char of text) {
    if (char === '(') depth += 1;
    else if (char === ')' && --depth < 0) return false;
  }
  return depth === 0;
};

/** The id of the item whose note is at `path`, as its `ir-id` says. */
const idOf = (path: string) => `id-of-${path}`;

/** The items whose notes are at `paths`. */
const itemsAt = (...paths: string[]) =>
  paths.map((reference) => ({ id: idOf(reference), reference }));

/**
 * Notes at `sources`' keys, each its item's by its `ir-id` and with that
 * `source` property (or none), in a
 * vault holding only them. `processFrontMatter` edits the notes' frontmatter
 * in place, and the metadata cache answers it; links are made as
 * `[[<path><subpath>|<alias>]]`, so the test can read back what was asked for.
 */
function wireSources(sources: Record<string, string | undefined>) {
  const frontmatter = new Map<string, Record<string, unknown>>(
    Object.entries(sources).map(([path, source]) => [
      path,
      source === undefined
        ? { 'ir-id': idOf(path) }
        : { 'ir-id': idOf(path), source },
    ])
  );
  const processFrontMatter = vi.fn(
    async (file: TFile, edit: (fm: Record<string, unknown>) => void) => {
      edit(frontmatter.get(file.path)!);
    }
  );
  const app = {
    metadataCache: {
      getFileCache: (file: TFile) => ({
        frontmatter: { ...frontmatter.get(file.path) },
      }),
      // Every file linked to by its full path
      fileToLinktext: vi.fn((file: TFile) => file.path),
    },
    fileManager: { processFrontMatter },
  };
  vi.spyOn(Obsidian, 'getNote').mockImplementation((reference) =>
    frontmatter.has(reference)
      ? ({ path: reference, extension: 'md' } as TFile)
      : null
  );
  const query = vi.fn().mockResolvedValue([]);
  const repo = { query, mutate: vi.fn() } as unknown as SQLiteRepository;
  const manager = new TestManager({ app } as never, repo);
  return {
    manager,
    query,
    processFrontMatter,
    fileToLinktext: app.metadataCache.fileToLinktext,
    sourceOf: (path: string) => frontmatter.get(path)?.source,
  };
}

const TO = {
  path: 'IR/articles/Paper copy.pdf',
  basename: 'Paper copy',
  extension: 'pdf',
} as TFile;
const FROM = 'papers/Paper.pdf';
// #endregion

describe('reprioritizeText', () => {
  const priorityArb = fc.integer({
    min: MINIMUM_PRIORITY,
    max: MAXIMUM_PRIORITY,
  });
  const textArb = fc.record({
    id: fc.uuid(),
    interval: fc.integer({ min: 1, max: MS_PER_YEAR * 10 }),
    priority: priorityArb,
    due: fc.option(fc.nat()),
    fixed_interval_days: fc.constant(null),
  }) as fc.Arbitrary<IArticleBase>;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the new priority with the interval and due it leaves to the text's row", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('article' as const, 'snippet' as const),
        textArb,
        priorityArb,
        fc.option(fc.nat(), { nil: undefined }),
        async (table, text, newPriority, reviewTime) => {
          const { repo, mutate } = makeRepo();
          const manager = new TestManager({} as never, repo);
          await manager.reprioritize(
            table,
            text,
            newPriority,
            reviewTime === undefined ? undefined : { review_time: reviewTime }
          );

          const { interval, due } = IRScheduler.reprioritize(
            text,
            newPriority,
            reviewTime
          );
          expect(mutate).toHaveBeenCalledExactlyOnceWith(
            `UPDATE ${table} SET priority = $1, due = $2, interval = $3 WHERE id = $4`,
            [newPriority, due, interval, text.id]
          );
        }
      )
    );
  });

  it('leaves the row as it was after a run of changes back to the starting priority', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: MS_PER_YEAR * 10 }),
        priorityArb,
        fc.array(priorityArb, { maxLength: 10 }),
        fc.nat(),
        async (base, priority, changes, reviewTime) => {
          const { repo, mutate } = makeRepo();
          const manager = new TestManager({} as never, repo);
          const interval = IRScheduler.nextInterval({
            interval: base,
            priority,
            fixed_interval_days: null,
          } as IArticleBase);
          const start = {
            id: 'a',
            interval,
            priority,
            due: reviewTime + interval,
            fixed_interval_days: null,
          } as IArticleBase;

          let text = start;
          for (const p of [...changes, priority]) {
            mutate.mockClear();
            await manager.reprioritize('article', text, p, {
              review_time: reviewTime,
            });
            const [, params] = mutate.mock.calls[0] as [string, number[]];
            text = {
              ...text,
              priority: params[0],
              due: params[1],
              interval: params[2],
            };
          }
          expect(text).toEqual(start);
        }
      )
    );
  });
});

describe('retargetSources', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * A name a vault can hold and a link can carry: dots, spaces, brackets and
   * `%` included.
   */
  const nameArb = fc
    .string({
      minLength: 1,
      maxLength: 8,
      unit: fc.constantFrom('a', 'B', '1', ' ', '.', '(', ')', '-', '%'),
    })
    .filter(
      (s) =>
        s.trim() === s &&
        !s.startsWith('.') &&
        !s.endsWith('.') &&
        // Read as an escape in a markdown link, as Obsidian reads it too
        !/%[0-9A-Fa-f]{2}/.test(s)
    );
  const folderArb = fc.array(nameArb, { maxLength: 3 });

  /**
   * A file the link was written for, a note it is in, and the link, written
   * as Obsidian may write one: a wikilink or markdown link (encoded, or in
   * angle brackets) by the full path, a tail of it, a leading `/`, or a path
   * relative to the note; a note's maybe without `.md`; with a subpath or
   * none, and an alias that is the file's name, its page label, the user's
   * own words, or none.
   */
  const linkCaseArb = fc
    .record({
      fromFolder: folderArb,
      fromBase: nameArb,
      extension: fc.constantFrom('.pdf', '.md', ''),
      noteFolder: folderArb,
      to: fc.record({ folder: folderArb, base: nameArb }),
      form: fc.constantFrom('wiki', 'markdown', 'angled'),
      pathForm: fc.constantFrom('full', 'tail', 'slash', 'relative', 'noExt'),
      tail: fc.nat(),
      subpath: fc.constantFrom('', '#page=3&selection=1,2,3,4', '#page=12'),
      alias: fc.constantFrom('name', 'page', 'own', null),
      // Where the note has moved since its link was written, if it has
      movedTo: fc.option(folderArb, { nil: null }),
    })
    .map((c) => {
      const fromParts = [...c.fromFolder, c.fromBase + c.extension];
      const fromPath = fromParts.join('/');
      const notePath = [...c.noteFolder, 's.md'].join('/');
      let linkPath = fromPath;
      if (c.pathForm === 'tail') {
        linkPath = fromParts.slice(c.tail % fromParts.length).join('/');
      } else if (c.pathForm === 'slash') {
        linkPath = `/${fromPath}`;
      } else if (c.pathForm === 'relative') {
        linkPath =
          c.noteFolder.length === 0
            ? `./${fromPath}`
            : '../'.repeat(c.noteFolder.length) + fromPath;
      } else if (c.pathForm === 'noExt' && c.extension === '.md') {
        linkPath = fromPath.slice(0, -'.md'.length);
      }
      // Its name as Obsidian has it: all but what follows the last dot
      const fileName = c.fromBase + c.extension;
      const dot = fileName.lastIndexOf('.');
      const fromName = dot > 0 ? fileName.slice(0, dot) : fileName;
      const alias =
        c.alias === 'name'
          ? fromName
          : c.alias === 'page'
            ? `${fromName}, page 3`
            : c.alias === 'own'
              ? 'my (own) words'
              : null;
      const target = linkPath + c.subpath;
      const link =
        c.form === 'wiki'
          ? `[[${target}${alias === null ? '' : `|${alias}`}]]`
          : c.form === 'angled'
            ? `[${alias ?? ''}](<${target}>)`
            : `[${alias ?? ''}](${target.replace(/ /g, '%20')})`;
      const to = {
        path: [...c.to.folder, `${c.to.base}.pdf`].join('/'),
        basename: c.to.base,
        extension: 'pdf',
      } as TFile;
      // Renamed where it was the old name or its page label, else kept
      const newAlias =
        c.alias === 'name'
          ? to.basename
          : c.alias === 'page'
            ? `${to.basename}, page 3`
            : alias;
      const newTarget = to.path + c.subpath;
      const expected =
        c.form === 'wiki'
          ? `[[${newTarget}${newAlias === null ? '' : `|${newAlias}`}]]`
          : c.form === 'angled'
            ? `[${newAlias ?? ''}](<${newTarget}>)`
            : `[${newAlias ?? ''}](${newTarget.replace(/ /g, '%20')})`;
      return {
        fromPath,
        notePath,
        link,
        to,
        expected,
        form: c.form,
        target,
        nowAt:
          c.movedTo === null
            ? notePath
            : [...c.movedTo, 'moved', 's.md'].join('/'),
      };
    });

  it('points every link naming the old file at the new one, as it was written where its note was, keeping its subpath and renaming its alias', async () => {
    await fc.assert(
      fc.asyncProperty(linkCaseArb, async (c) => {
        // A bare markdown target's brackets must balance to be read at all
        fc.pre(c.form !== 'markdown' || balanced(c.target));
        vi.restoreAllMocks();
        const wired = wireSources({ [c.nowAt]: c.link });
        const [item] = itemsAt(c.nowAt);

        await expect(
          wired.manager.retargetSources(
            [
              c.nowAt === c.notePath
                ? item
                : { ...item, writtenAt: c.notePath },
            ],
            c.fromPath,
            c.to
          )
          // A link that already reads as it would become costs no write
        ).resolves.toBe(c.expected === c.link ? 0 : 1);

        expect(wired.sourceOf(c.nowAt)).toBe(c.expected);
        // Linked to from where the note is now; a note named without its .md
        // in a wikilink only, as Obsidian does
        expect(wired.fileToLinktext).toHaveBeenCalledWith(
          c.to,
          c.nowAt,
          c.form === 'wiki'
        );
      })
    );
  });

  it('leaves alone, without a write, a note that is gone, has no link, or links elsewhere', async () => {
    const wired = wireSources({
      'a.md': '[[papers/Other.pdf#page=1|Other, page 1]]',
      'b.md': undefined,
      'c.md': 'papers/Paper.pdf',
      'd.md': '[[aper.pdf]]',
    });

    await expect(
      wired.manager.retargetSources(
        itemsAt('a.md', 'b.md', 'c.md', 'd.md', 'gone.md'),
        FROM,
        TO
      )
    ).resolves.toBe(0);

    expect(wired.processFrontMatter).not.toHaveBeenCalled();
    expect(wired.sourceOf('a.md')).toBe(
      '[[papers/Other.pdf#page=1|Other, page 1]]'
    );
  });

  it('writes nothing where the link is already the one it would become', async () => {
    const wired = wireSources({
      's.md': `[[${TO.path}#page=2|Paper copy, page 2]]`,
      // Spaces around it are no change to the link
      't.md': ` [[${TO.path}#page=2|Paper copy, page 2]] `,
    });

    await expect(
      wired.manager.retargetSources(itemsAt('s.md', 't.md'), TO.path, TO)
    ).resolves.toBe(0);
    expect(wired.processFrontMatter).not.toHaveBeenCalled();
  });

  it('decides again on the note as written, where the cache was behind', async () => {
    const wired = wireSources({ 's.md': '[[papers/Paper.pdf|Paper]]' });
    const error = vi.spyOn(console, 'error');
    // The note was rewritten elsewhere after the cache read it
    const asWritten: Record<string, unknown> = {
      'ir-id': idOf('s.md'),
      source: '[[elsewhere.pdf|elsewhere]]',
    };
    wired.processFrontMatter.mockImplementationOnce(async (_file, edit) => {
      edit(asWritten);
    });

    await expect(
      wired.manager.retargetSources(itemsAt('s.md'), FROM, TO)
    ).resolves.toBe(0);

    expect(wired.processFrontMatter).toHaveBeenCalledOnce();
    expect(asWritten).toEqual({
      'ir-id': idOf('s.md'),
      source: '[[elsewhere.pdf|elsewhere]]',
    });
    expect(error).not.toHaveBeenCalled();
  });

  it("leaves alone, without a write, a note at an item's path that is another's by its ir-id", async () => {
    const wired = wireSources({ 's.md': '[[papers/Paper.pdf|Paper]]' });

    await expect(
      wired.manager.retargetSources(
        [{ id: 'some-other-item', reference: 's.md' }],
        FROM,
        TO
      )
    ).resolves.toBe(0);

    expect(wired.processFrontMatter).not.toHaveBeenCalled();
    expect(wired.sourceOf('s.md')).toBe('[[papers/Paper.pdf|Paper]]');
  });

  it('reads a relative link from where the note was when it was written, for a note that has moved since', async () => {
    // Written in `notes/` as `../papers/Paper.pdf`; the note is now in `archive/deep/`
    const wired = wireSources({
      'archive/deep/s.md': '[[../papers/Paper.pdf#page=3|Paper, page 3]]',
      'archive/deep/t.md': '[[../papers/Paper.pdf|Paper]]',
    });

    await expect(
      wired.manager.retargetSources(
        [
          { ...itemsAt('archive/deep/s.md')[0], writtenAt: 'notes/s.md' },
          // Read from where it is now, the link names no such file
          ...itemsAt('archive/deep/t.md'),
        ],
        FROM,
        TO
      )
    ).resolves.toBe(1);

    expect(wired.sourceOf('archive/deep/s.md')).toBe(
      `[[${TO.path}#page=3|Paper copy, page 3]]`
    );
    // Linked to from where the note is now
    expect(wired.fileToLinktext).toHaveBeenCalledWith(
      TO,
      'archive/deep/s.md',
      true
    );
    expect(
      new Set(wired.fileToLinktext.mock.calls.map((call) => call.at(1)))
    ).toStrictEqual(new Set(['archive/deep/s.md']));
    expect(wired.sourceOf('archive/deep/t.md')).toBe(
      '[[../papers/Paper.pdf|Paper]]'
    );
  });

  it('goes on to the next note when one cannot be written', async () => {
    const wired = wireSources({
      'a.md': '[[papers/Paper.pdf|Paper]]',
      'b.md': '[[papers/Paper.pdf|Paper]]',
    });
    const failure = new Error('bad YAML');
    wired.processFrontMatter.mockRejectedValueOnce(failure);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      wired.manager.retargetSources(itemsAt('a.md', 'b.md'), FROM, TO)
    ).resolves.toBe(1);

    expect(error).toHaveBeenCalledExactlyOnceWith(failure);
    expect(wired.sourceOf('b.md')).toBe(`[[${TO.path}|Paper copy]]`);
  });
});

describe('retargetChildSources', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-points the snippets and cards whose parent is the row, by the row's id", async () => {
    const wired = wireSources({
      'IR/snippets/s.md': '[[papers/Paper.pdf#page=1|Paper, page 1]]',
      'IR/cards/c.md': '[[Paper.pdf#page=2|Paper, page 2]]',
    });
    wired.query.mockResolvedValue(itemsAt('IR/snippets/s.md', 'IR/cards/c.md'));

    await expect(
      wired.manager.retargetChildSources('article-1', FROM, TO)
    ).resolves.toBe(2);

    const [sql, params] = wired.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(
      /SELECT id, reference FROM snippet WHERE parent = \$1 AND deleted = FALSE\s+UNION ALL\s+SELECT id, reference FROM srs_card WHERE parent = \$1 AND deleted = FALSE/
    );
    expect(params).toEqual(['article-1']);
    expect(wired.sourceOf('IR/snippets/s.md')).toBe(
      `[[${TO.path}#page=1|Paper copy, page 1]]`
    );
    expect(wired.sourceOf('IR/cards/c.md')).toBe(
      `[[${TO.path}#page=2|Paper copy, page 2]]`
    );
  });
});

describe('deleteWithNote', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the row and its reviews exactly as they were, and the note, when the note is not deleted', async () => {
    await fc.assert(
      fc.asyncProperty(
        itemRowArb,
        fc.constantFrom('cancelled', 'trash fails'),
        fc.boolean(),
        fc.boolean(),
        async (row, why, prompt, foreignKeys) => {
          vi.restoreAllMocks();
          fc.pre(prompt || why !== 'cancelled');
          const wired = await wireDelete(row, why !== 'cancelled');
          // Off after sql.js's first save: the reviews outlive the row's
          // delete then, rather than going with it
          if (!foreignKeys) wired.repo.db!.exec('PRAGMA foreign_keys = OFF');
          if (why === 'trash fails') wired.vault.fail('trash');
          const [{ updated_at: stampedBefore }] = wired.repo.storedRows(
            row.table
          );

          expect(
            await wired.manager.delete(row.table, row.id, { prompt })
          ).toBe(why === 'cancelled' ? 'declined' : 'failed');

          expect(wired.stored()).toEqual(wired.before);
          // Put back by a write newer than the delete it undid
          expect(
            wired.repo.storedRows(row.table)[0].updated_at
          ).toBeGreaterThan(stampedBefore as number);

          expect(wired.vault.paths()).toEqual([ITEM_NOTE]);
        }
      ),
      { numRuns: 40 }
    );
  });

  it('deletes nothing when the reviews it would put back cannot be read', async () => {
    await fc.assert(
      fc.asyncProperty(itemRowArb, async (row) => {
        vi.restoreAllMocks();
        const wired = await wireDelete(row);
        const query = wired.repo.query.bind(
          wired.repo
        ) as TestRepository['query'];
        const failing = vi
          .spyOn(wired.repo, 'query')
          .mockImplementation((sql, params, options) => {
            if (!sql.includes('_review')) return query(sql, params, options);
            if (options?.throwOnError) throw new Error('read failed');
            return [];
          });

        expect(
          await wired.manager.delete(row.table, row.id, { prompt: false })
        ).toBe('failed');

        failing.mockRestore();
        expect(wired.stored()).toEqual(wired.before);
        expect(wired.vault.paths()).toEqual([ITEM_NOTE]);
      }),
      { numRuns: 10 }
    );
  });

  it('keeps the note when the row cannot be deleted', async () => {
    await fc.assert(
      fc.asyncProperty(itemRowArb, fc.boolean(), async (row, prompt) => {
        vi.restoreAllMocks();
        const wired = await wireDelete(row);
        // The last of its writes, so the ones before it are rolled back
        wired.repo.failWrite((query) =>
          query.startsWith(`UPDATE ${row.table} SET deleted`)
        );

        expect(await wired.manager.delete(row.table, row.id, { prompt })).toBe(
          'failed'
        );

        expect(wired.stored()).toEqual(wired.before);
        expect(wired.vault.paths()).toEqual([ITEM_NOTE]);
        expect(wired.promptForFileDeletion).not.toHaveBeenCalled();
      }),
      { numRuns: 20 }
    );
  });

  it('deletes the note and the row when nothing fails, prompting as asked', async () => {
    await fc.assert(
      fc.asyncProperty(itemRowArb, fc.boolean(), async (row, prompt) => {
        vi.restoreAllMocks();
        const wired = await wireDelete(row);

        expect(await wired.manager.delete(row.table, row.id, { prompt })).toBe(
          'deleted'
        );

        expect(wired.stored().rows).toEqual([]);
        expect(wired.vault.trashed).toEqual([ITEM_NOTE]);
        expect(wired.promptForFileDeletion).toHaveBeenCalledTimes(
          prompt ? 1 : 0
        );
      }),
      { numRuns: 20 }
    );
  });

  it('keeps the row deleted when the prompt fails after trashing the note', async () => {
    await fc.assert(
      fc.asyncProperty(itemRowArb, async (row) => {
        vi.restoreAllMocks();
        const wired = await wireDelete(row);
        const failure = new Error('attachment busy');
        wired.promptForFileDeletion.mockImplementationOnce(
          async (file: TFile) => {
            await wired.vault.app.fileManager.trashFile(file);
            throw failure;
          }
        );

        expect(
          await wired.manager.delete(row.table, row.id, { prompt: true })
        ).toBe('deleted');

        expect(wired.stored().rows).toEqual([]);
        expect(console.error).toHaveBeenCalledWith(failure);
      }),
      { numRuns: 10 }
    );
  });

  it('says in the console why nothing was deleted', async () => {
    await fc.assert(
      fc.asyncProperty(itemRowArb, async (row) => {
        vi.restoreAllMocks();
        const wired = await wireDelete(row, false);

        await wired.manager.delete(row.table, row.id, { prompt: true });
        await wired.manager.delete(row.table, 'no-such-id', { prompt: true });

        expect(
          vi.mocked(console.error).mock.calls.map(([e]) => String(e))
        ).toEqual([
          `Error: Kept ${ITEM_NOTE}`,
          `Error: No ${row.table} row was found with ID "no-such-id"`,
        ]);
      }),
      { numRuns: 10 }
    );
  });

  it('deletes nothing, and says why, while not ready', async () => {
    await fc.assert(
      fc.asyncProperty(
        itemRowArb,
        fc.constantFrom('starting' as const, 'merging' as const),
        async (row, state) => {
          vi.restoreAllMocks();
          const wired = await wireDelete(row);
          if (state === 'merging') {
            wired.repo.holdMerging();
            runOutMergeWait();
          } else wired.repo.refuseWrites(new Error('Saving is paused.'));
          const rowsBefore = wired.repo.rows(row.table);

          expect(await wired.manager.delete(row.table, row.id, {})).toBe(
            'refused'
          );

          expect(wired.promptForFileDeletion).not.toHaveBeenCalled();
          expect(wired.vault.paths()).toEqual([ITEM_NOTE]);
          expect(wired.repo.rows(row.table)).toEqual(rowsBefore);
          expect(wired.notify).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining(refusalReason(state)),
            { kind: 'error' }
          );
        }
      ),
      { numRuns: 10 }
    );
  });

  it('says writes were refused when they are refused partway', async () => {
    await fc.assert(
      fc.asyncProperty(itemRowArb, async (row) => {
        vi.restoreAllMocks();
        const wired = await wireDelete(row);
        // Refused only once the row is read, as when Sync pauses saving then
        const query = wired.repo.query.bind(
          wired.repo
        ) as TestRepository['query'];
        vi.spyOn(wired.repo, 'query').mockImplementation((...args) => {
          wired.repo.refuseWrites();
          return query(...args);
        });

        expect(
          await wired.manager.delete(row.table, row.id, { prompt: false })
        ).toBe('refused');
        expect(wired.vault.paths()).toEqual([ITEM_NOTE]);
      }),
      { numRuns: 10 }
    );
  });
});
