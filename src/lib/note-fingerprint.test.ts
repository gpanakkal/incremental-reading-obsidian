import { TestRepository } from '#/test/item-vault';
import fc from 'fast-check';
import type { MetadataCache, TFile } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { ITEM_TABLES, type ItemTable } from './moved-note-scan';
import {
  type IrIdRelation,
  type ReconcileInput,
  type RowState,
  cacheLagsNote,
  fingerprintMatches,
  noteFingerprint,
  reconcileAction,
  recordFingerprint,
} from './note-fingerprint';

// #region HELPERS

/** A file at `path`, with a stat reading `mtime` unless that is undefined. */
function fileAt(path: string, mtime?: number): TFile {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const file = {
    path,
    name,
    basename: dot > 0 ? name.slice(0, dot) : name,
    extension: dot > 0 ? name.slice(dot + 1) : '',
  };
  return (
    mtime === undefined ? file : { ...file, stat: { ctime: 0, mtime, size: 1 } }
  ) as TFile;
}

const mtimeArb = fc.integer({ min: 0, max: 4_102_444_800_000 });
const relationArb = fc.constantFrom<IrIdRelation>('same', 'other', 'none');
const rowStateArb = fc.constantFrom<RowState>('live', 'tombstoned', 'purged');

/**
 * A row's fingerprint and its note's mtime, related the ways that matter:
 * equal, a millisecond either side, far apart, or either one unknown.
 */
const mtimesArb: fc.Arbitrary<Pick<ReconcileInput, 'noteMtime' | 'rowMtime'>> =
  fc.oneof(
    mtimeArb.map((m) => ({ noteMtime: m, rowMtime: m })),
    mtimeArb.map((m) => ({ noteMtime: m + 1, rowMtime: m })),
    mtimeArb.map((m) => ({ noteMtime: m, rowMtime: m + 1 })),
    fc
      .tuple(mtimeArb, mtimeArb)
      .map(([noteMtime, rowMtime]) => ({ noteMtime, rowMtime })),
    mtimeArb.map((m) => ({ noteMtime: m, rowMtime: null })),
    mtimeArb.map((m) => ({ noteMtime: null, rowMtime: m })),
    fc.constant({ noteMtime: null, rowMtime: null })
  );

const inputArb: fc.Arbitrary<ReconcileInput> = fc
  .tuple(mtimesArb, relationArb, rowStateArb)
  .map(([mtimes, relation, rowState]) => ({ ...mtimes, relation, rowState }));

/** Add a live `table` row `id`, with no fingerprint recorded. */
function insertItem(repo: TestRepository, table: ItemTable, id: string) {
  if (table === 'srs_card') {
    repo.mutate(
      `INSERT INTO srs_card (id, reference, created_at, due, stability,
         difficulty, elapsed_days, scheduled_days, reps, lapses, state)
       VALUES ($1, $2, 0, 0, 0, 0, 0, 0, 0, 0, 0)`,
      [id, `${id}.md`]
    );
    return;
  }
  repo.mutate(
    `INSERT INTO ${table} (id, reference, due, interval, priority)
     VALUES ($1, $2, 0, 86400000, 30)`,
    [id, `${id}.md`]
  );
}

/**
 * A metadata cache whose internal `fileCache` (unofficial Obsidian API: the
 * stat each note was last parsed at, by path) is `fileCache`.
 */
const cacheWith = (fileCache: unknown) =>
  ({ fileCache }) as unknown as MetadataCache;

/** A note's stat, and the stat its cache entry was parsed at, related the ways that matter. */
const statPairArb = fc.tuple(mtimeArb, fc.nat()).chain(([mtime, size]) =>
  fc.record({
    now: fc.constant({ mtime, size }),
    parsed: fc.oneof(
      fc.constant({ mtime, size }),
      fc.constant({ mtime: mtime + 1, size }),
      fc.constant({ mtime: mtime - 1, size }),
      fc.constant({ mtime, size: size + 1 }),
      fc.record({ mtime: mtimeArb, size: fc.nat() })
    ),
  })
);

// #endregion

describe('fingerprintMatches', () => {
  it('matches only a recorded fingerprint the note still has', () => {
    fc.assert(
      fc.property(mtimesArb, ({ noteMtime, rowMtime }) => {
        expect(fingerprintMatches(noteMtime, rowMtime)).toBe(
          rowMtime !== null && noteMtime === rowMtime
        );
      })
    );
  });

  it('never matches a note whose mtime cannot be read', () => {
    fc.assert(
      fc.property(fc.option(mtimeArb, { nil: null }), (rowMtime) => {
        expect(fingerprintMatches(null, rowMtime)).toBe(false);
      })
    );
  });
});

describe('reconcileAction', () => {
  it('acts only on a matching fingerprint, and only by tombstoning a live row', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const action = reconcileAction(input);
        expect(['none', 'tombstone']).toContain(action);
        if (action !== 'none') {
          expect(input.rowMtime).not.toBeNull();
          expect(input.noteMtime).toBe(input.rowMtime);
          expect(input.rowState).toBe('live');
        }
      })
    );
  });

  it("tombstones a live row whose note, provably the one it was written with, carries another item's id", () => {
    fc.assert(
      fc.property(mtimeArb, (m) => {
        expect(
          reconcileAction({
            noteMtime: m,
            rowMtime: m,
            relation: 'other',
            rowState: 'live',
          })
        ).toBe('tombstone');
      })
    );
  });

  it("never brings back a tombstoned row, even when its note, provably the one it was written with, carries the row's id", () => {
    // A restore revives it through `handleCreation`; trashing keeps mtime, so
    // the fingerprint can't tell one from a deletion Sync has yet to bring
    fc.assert(
      fc.property(mtimeArb, relationArb, (m, relation) => {
        expect(
          reconcileAction({
            noteMtime: m,
            rowMtime: m,
            relation,
            rowState: 'tombstoned',
          })
        ).toBe('none');
      })
    );
  });

  it('leaves every other pairing of note and row alone, fingerprint or not', () => {
    fc.assert(
      fc.property(
        inputArb.filter(
          ({ relation, rowState }) =>
            !(relation === 'other' && rowState === 'live')
        ),
        (input) => {
          expect(reconcileAction(input)).toBe('none');
        }
      )
    );
  });

  it('leaves the row alone on any mismatch, whatever the note and row say', () => {
    fc.assert(
      fc.property(
        inputArb.filter(
          ({ noteMtime, rowMtime }) =>
            rowMtime === null || noteMtime !== rowMtime
        ),
        (input) => {
          expect(reconcileAction(input)).toBe('none');
        }
      )
    );
  });
});

describe('noteFingerprint', () => {
  it("reads a note's mtime", () => {
    fc.assert(
      fc.property(fc.mixedCase(fc.constant('md')), mtimeArb, (ext, mtime) => {
        expect(noteFingerprint(fileAt(`notes/a.${ext}`, mtime))).toBe(mtime);
      })
    );
  });

  it('gives a file with no frontmatter none, whatever its mtime', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.mixedCase(fc.constant('pdf')),
          fc.string().filter((ext) => ext.toLowerCase() !== 'md')
        ),
        mtimeArb,
        (ext, mtime) => {
          expect(noteFingerprint(fileAt(`notes/a.${ext}`, mtime))).toBeNull();
        }
      )
    );
  });

  it('gives a file object with no stat to read none', () => {
    expect(noteFingerprint(fileAt('notes/a.md'))).toBeNull();
  });
});

describe('cacheLagsNote', () => {
  it("calls the cache behind exactly when it parsed the note at another mtime or size than the note's now", () => {
    fc.assert(
      fc.property(fc.string(), statPairArb, (name, { now, parsed }) => {
        const path = `notes/${name}.md`;
        const file = { path, stat: { ctime: 0, ...now } } as TFile;

        expect(cacheLagsNote(file, cacheWith({ [path]: parsed }))).toBe(
          parsed.mtime !== now.mtime || parsed.size !== now.size
        );
      })
    );
  });

  it("never calls the cache behind when it can't compare the two", () => {
    const path = 'notes/a.md';
    const file = { path, stat: { ctime: 0, mtime: 5, size: 5 } } as TFile;
    const older = { mtime: 1, size: 1, hash: 'h' };
    // No internal to read, or not of the shape it had
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(undefined), fc.constant(null), fc.string()),
        (fileCache) => {
          expect(cacheLagsNote(file, cacheWith(fileCache))).toBe(false);
        }
      )
    );
    // No entry of the note's own, an older one elsewhere or inherited
    expect(cacheLagsNote(file, cacheWith({ 'notes/b.md': older }))).toBe(false);
    expect(
      cacheLagsNote(file, cacheWith(Object.create({ [path]: older })))
    ).toBe(false);
    // An entry with no stat of its own to compare
    for (const entry of [null, {}, { mtime: 1 }, { size: 1 }]) {
      expect(cacheLagsNote(file, cacheWith({ [path]: entry }))).toBe(false);
    }
    // A stand-in file object with no stat
    expect(cacheLagsNote({ path } as TFile, cacheWith({ [path]: older }))).toBe(
      false
    );
  });
});

describe('recordFingerprint', () => {
  it("records the note's mtime on its row, and nothing else", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ITEM_TABLES),
        mtimeArb,
        async (table, mtime) => {
          const repo = await TestRepository.create();
          insertItem(repo, table, 'a1');
          insertItem(repo, table, 'a2');
          const before = repo.rows(table);

          const statement = recordFingerprint(
            table,
            'a1',
            fileAt('notes/a.md', mtime)
          );
          repo.mutate(statement!.query, statement!.params);

          expect(
            repo.storedRows(table).map(({ id, note_mtime }) => [id, note_mtime])
          ).toStrictEqual([
            ['a1', mtime],
            ['a2', null],
          ]);
          expect(repo.rows(table)).toStrictEqual(before);
        }
      ),
      { numRuns: 20 }
    );
  });

  it('has nothing to record for a file with no fingerprint', () => {
    expect(recordFingerprint('article', 'a1', fileAt('a.pdf', 5))).toBeNull();
    expect(recordFingerprint('article', 'a1', fileAt('a.md'))).toBeNull();
  });
});
