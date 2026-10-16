import fc from 'fast-check';
import { TFile, TFolder, type TAbstractFile, type Workspace } from 'obsidian';
import type { FileExplorerViewSortOrder } from 'obsidian-typings';
import { describe, expect, it, vi } from 'vitest';
import { explorerComparator, readExplorerSortOrder } from './explorer-order';

// #region HELPERS
/** Every order the explorer's sort menu offers; the compiler checks it's all. */
const SORT_ORDERS = Object.keys({
  alphabetical: true,
  alphabeticalReverse: true,
  byModifiedTime: true,
  byModifiedTimeReverse: true,
  byCreatedTime: true,
  byCreatedTimeReverse: true,
} satisfies Record<
  FileExplorerViewSortOrder,
  true
>) as FileExplorerViewSortOrder[];

/** Each order paired with the one that reverses it. */
const REVERSALS: [FileExplorerViewSortOrder, FileExplorerViewSortOrder][] = [
  ['alphabetical', 'alphabeticalReverse'],
  ['byModifiedTime', 'byModifiedTimeReverse'],
  ['byCreatedTime', 'byCreatedTimeReverse'],
];

const sortOrderArb = fc.constantFrom(...SORT_ORDERS);

/**
 * Names as people write them: numbered parts, the same word in another case
 * or with an accent, punctuation, any script, and anything else.
 */
const nameArb = fc.oneof(
  fc.string({ maxLength: 6 }),
  fc.string({ unit: 'grapheme', maxLength: 4 }),
  fc.stringMatching(/^[aAáb]{0,2}[ ._-]?[0-9]{0,3}$/),
  fc.constantFrom('Part 2', 'part 10', 'Part 1', 'a', 'A', 'á', 'b')
);

/** A file time: often the same as another file's, or anything a stat holds. */
const timeArb = fc.oneof(
  fc.nat({ max: 3 }),
  fc.double({ min: 0, max: 4e12, noNaN: true })
);

interface FileSpec {
  basename: string;
  extension: string;
  mtime: number;
  ctime: number;
}

const fileSpecArb: fc.Arbitrary<FileSpec> = fc.record({
  basename: nameArb,
  extension: fc.constantFrom('md', 'pdf', 'png', ''),
  mtime: timeArb,
  ctime: timeArb,
});

function makeFile({ basename, extension, mtime, ctime }: FileSpec): TFile {
  return Object.assign(new TFile(), {
    name: extension ? `${basename}.${extension}` : basename,
    basename,
    extension,
    stat: { mtime, ctime, size: 0 },
  });
}

function makeFolder(name: string): TFolder {
  return Object.assign(new TFolder(), { name });
}

const fileArb = fileSpecArb.map(makeFile);
const folderArb = nameArb.map(makeFolder);
const entryArb: fc.Arbitrary<TAbstractFile> = fc.oneof(fileArb, folderArb);

/** How people compare names: case and accents aside, digits as numbers. */
const naturalSign = (a: string, b: string) =>
  Math.sign(
    a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
  );

/** `Math.sign`, with no `-0` for `toBe` to tell apart from `0`. */
const sign = (n: number) => Math.sign(n) + 0;

/**
 * A workspace whose leaves of each view type are `leaves[type]`, each view
 * reporting `state` as its own.
 */
function makeWorkspace(leaves: Record<string, unknown[]>) {
  const getLeavesOfType = vi.fn((type: string) =>
    (leaves[type] ?? []).map((state) => ({ view: { getState: () => state } }))
  );
  return {
    workspace: { getLeavesOfType } as unknown as Pick<
      Workspace,
      'getLeavesOfType'
    >,
    getLeavesOfType,
  };
}

/** Anything a view's state could hold where a sort order is expected. */
const unknownOrderArb = fc.oneof(
  fc.anything().filter((v) => !(SORT_ORDERS as unknown[]).includes(v)),
  fc.string().filter((s) => !(SORT_ORDERS as string[]).includes(s)),
  // What every object has, but no sort order is
  fc.constantFrom('toString', 'constructor', 'hasOwnProperty', '__proto__'),
  // Close, but not one
  fc.constantFrom('Alphabetical', 'byModifiedtime', 'alphabetical ', '')
);
// #endregion

describe('explorerComparator', () => {
  it('sorts consistently under every order: no entry before itself, and a reversed pair compares the other way', () => {
    fc.assert(
      fc.property(sortOrderArb, entryArb, entryArb, (order, a, b) => {
        const compare = explorerComparator(order);

        expect(sign(compare(a, a))).toBe(0);
        expect(sign(compare(a, b))).toBe(sign(-compare(b, a)));
      })
    );
  });

  it('sorts transitively under every order: a sorted list is in order pair by pair', () => {
    fc.assert(
      fc.property(
        sortOrderArb,
        fc.array(entryArb, { maxLength: 12 }),
        (order, entries) => {
          const compare = explorerComparator(order);

          const sorted = [...entries].sort(compare);

          for (let i = 0; i < sorted.length; i++) {
            for (let j = i + 1; j < sorted.length; j++) {
              expect(compare(sorted[i], sorted[j])).toBeLessThanOrEqual(0);
            }
          }
        }
      )
    );
  });

  it('puts every folder before every file, whatever the order', () => {
    fc.assert(
      fc.property(sortOrderArb, folderArb, fileArb, (order, folder, file) => {
        const compare = explorerComparator(order);

        expect(compare(folder, file)).toBeLessThan(0);
        expect(compare(file, folder)).toBeGreaterThan(0);
      })
    );
  });

  it('sorts folders by name as people count, whatever the order', () => {
    fc.assert(
      fc.property(sortOrderArb, folderArb, folderArb, (order, a, b) => {
        expect(sign(explorerComparator(order)(a, b))).toBe(
          naturalSign(a.name, b.name)
        );
      })
    );
  });

  it('sorts files A to Z by name without the extension, as people count', () => {
    fc.assert(
      fc.property(fileArb, fileArb, (a, b) => {
        expect(sign(explorerComparator('alphabetical')(a, b))).toBe(
          naturalSign(a.basename, b.basename)
        );
      })
    );
  });

  it('sorts files newest modified first', () => {
    fc.assert(
      fc.property(fileArb, fileArb, (a, b) => {
        expect(sign(explorerComparator('byModifiedTime')(a, b))).toBe(
          sign(b.stat.mtime - a.stat.mtime)
        );
      })
    );
  });

  it('sorts files newest created first', () => {
    fc.assert(
      fc.property(fileArb, fileArb, (a, b) => {
        expect(sign(explorerComparator('byCreatedTime')(a, b))).toBe(
          sign(b.stat.ctime - a.stat.ctime)
        );
      })
    );
  });

  it('reverses each order on files exactly, and leaves folders as they were', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...REVERSALS),
        entryArb,
        entryArb,
        ([forward, reverse], a, b) => {
          const forwards = sign(explorerComparator(forward)(a, b));
          const backwards = sign(explorerComparator(reverse)(a, b));

          if (a instanceof TFile && b instanceof TFile) {
            expect(backwards).toBe(sign(-forwards));
          } else {
            expect(backwards).toBe(forwards);
          }
        }
      )
    );
  });

  it('counts numbers in names, and ignores case and accents', () => {
    const file = (basename: string) =>
      makeFile({ basename, extension: 'md', mtime: 0, ctime: 0 });
    const compare = explorerComparator('alphabetical');

    expect(compare(file('Part 2'), file('part 10'))).toBeLessThan(0);
    expect(compare(file('Part 10'), file('Part 9'))).toBeGreaterThan(0);
    expect(compare(file('note'), file('NOTE'))).toBe(0);
    expect(compare(file('resume'), file('résumé'))).toBe(0);
    expect(compare(makeFolder('Part 2'), makeFolder('part 10'))).toBeLessThan(
      0
    );
    expect(compare(makeFolder('Notes'), makeFolder('notes'))).toBe(0);
  });

  it('ties files that differ only in extension under A to Z, leaving them as they were', () => {
    const md = makeFile({ basename: 'a', extension: 'md', mtime: 1, ctime: 1 });
    const pdf = makeFile({
      basename: 'a',
      extension: 'pdf',
      mtime: 2,
      ctime: 2,
    });

    expect(sign(explorerComparator('alphabetical')(pdf, md))).toBe(0);
    expect(sign(explorerComparator('alphabeticalReverse')(pdf, md))).toBe(0);
    expect([pdf, md].sort(explorerComparator('alphabetical'))).toEqual([
      pdf,
      md,
    ]);
  });
});

describe('readExplorerSortOrder', () => {
  it("reads the order from the file explorer's view state", () => {
    fc.assert(
      fc.property(
        sortOrderArb,
        fc.dictionary(fc.string(), fc.anything()),
        fc.array(fc.anything(), { maxLength: 2 }),
        (sortOrder, rest, otherExplorers) => {
          const { workspace } = makeWorkspace({
            'file-explorer': [{ ...rest, sortOrder }, ...otherExplorers],
          });

          expect(readExplorerSortOrder(workspace)).toBe(sortOrder);
        }
      )
    );
  });

  it("reads no other view's order", () => {
    fc.assert(
      fc.property(
        sortOrderArb,
        fc.constantFrom(
          'backlink',
          'search',
          'all-properties',
          'bookmarks',
          ''
        ),
        (sortOrder, otherType) => {
          const { workspace, getLeavesOfType } = makeWorkspace({
            [otherType]: [{ sortOrder }],
          });

          expect(readExplorerSortOrder(workspace)).toBe('alphabetical');
          expect(getLeavesOfType).toHaveBeenCalledWith('file-explorer');
        }
      )
    );
  });

  it('falls back to A to Z with no explorer open', () => {
    const { workspace } = makeWorkspace({});

    expect(readExplorerSortOrder(workspace)).toBe('alphabetical');
  });

  it('falls back to A to Z when the explorer holds no state yet', () => {
    // A deferred view not yet given any state answers `undefined`
    for (const state of [undefined, null, {}]) {
      const { workspace } = makeWorkspace({ 'file-explorer': [state] });

      expect(readExplorerSortOrder(workspace)).toBe('alphabetical');
    }
  });

  it('falls back to A to Z on an order it does not know', () => {
    fc.assert(
      fc.property(unknownOrderArb, (sortOrder) => {
        const { workspace } = makeWorkspace({
          'file-explorer': [{ sortOrder }],
        });

        expect(readExplorerSortOrder(workspace)).toBe('alphabetical');
      })
    );
  });
});
