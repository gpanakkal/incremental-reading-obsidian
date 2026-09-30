import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import type { NoteType, SQLiteRepository } from '#/lib/types';
import fc from 'fast-check';
import type { CachedMetadata, TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ItemManager } from './ItemManager';

// #region HELPERS
/** Opens the protected `reconcileNote` to the tests. */
class TestManager extends ItemManager {
  reconcile(
    row: { id: string; deleted: boolean },
    file: TFile,
    type: NoteType,
    tag: string
  ): boolean {
    return this.reconcileNote(row, file, type, tag);
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
  const setFrontmatter = vi
    .spyOn(manager, 'setFrontmatter')
    .mockResolvedValue(undefined);
  const markDeleted = vi
    .spyOn(manager, 'markDeleted')
    .mockResolvedValue(undefined);
  const markUndeleted = vi
    .spyOn(manager, 'markUndeleted')
    .mockResolvedValue(undefined);
  return { manager, mutate, setFrontmatter, markDeleted, markUndeleted };
}

const FILE = { path: 'notes/item.md', extension: 'md' } as TFile;

// Row ids are UUIDs; any non-empty string stands in for one
const rowArb = fc.record({
  id: fc.string({ minLength: 1 }),
  deleted: fc.boolean(),
});
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
// #endregion

describe('reconcileNote', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves a note the cache is still re-reading alone and keeps the row', async () => {
    await fc.assert(
      fc.asyncProperty(rowArb, typeArb, fc.string(), async (row, type, tag) => {
        const { manager, mutate, setFrontmatter, markDeleted, markUndeleted } =
          wire(null);

        expect(manager.reconcile(row, FILE, type, tag)).toBe(true);

        expect(setFrontmatter).not.toHaveBeenCalled();
        expect(markDeleted).not.toHaveBeenCalled();
        expect(markUndeleted).not.toHaveBeenCalled();
        expect(mutate).not.toHaveBeenCalled();
      })
    );
  });

  it('gives up the row to a note claiming another id, and writes nothing to the note', async () => {
    await fc.assert(
      fc.asyncProperty(
        settledArb.filter(
          ({ row, frontmatter }) =>
            Boolean(frontmatter?.['ir-id']) && frontmatter?.['ir-id'] !== row.id
        ),
        async ({ row, type, tag, frontmatter }) => {
          const { manager, setFrontmatter, markDeleted, markUndeleted } = wire({
            // The read normalizes `tags` in place; keep the generated value intact
            frontmatter: structuredClone(frontmatter),
          } as CachedMetadata);

          expect(manager.reconcile(row, FILE, type, tag)).toBe(false);

          expect(markDeleted.mock.calls).toStrictEqual([[row.id, type]]);
          expect(setFrontmatter).not.toHaveBeenCalled();
          expect(markUndeleted).not.toHaveBeenCalled();
        }
      )
    );
  });

  it("keeps the row for a note making no other claim, restoring whichever of its id and tag it lacks and lifting the row's tombstone", async () => {
    await fc.assert(
      fc.asyncProperty(
        settledArb.filter(
          ({ row, frontmatter }) =>
            !frontmatter?.['ir-id'] || frontmatter['ir-id'] === row.id
        ),
        async ({ row, type, tag, frontmatter }) => {
          const irId: unknown = frontmatter?.['ir-id'];
          const tags: unknown = frontmatter?.tags;
          const hasTag =
            frontmatter !== undefined &&
            'tags' in frontmatter &&
            (Array.isArray(tags) ? tags.includes(tag) : tags === tag);
          const { manager, setFrontmatter, markDeleted, markUndeleted } = wire({
            // The read normalizes `tags` in place; keep the generated value intact
            frontmatter: structuredClone(frontmatter),
          } as CachedMetadata);

          expect(manager.reconcile(row, FILE, type, tag)).toBe(true);

          expect(setFrontmatter.mock.calls).toStrictEqual(
            irId === row.id && hasTag ? [] : [[FILE, row.id, tag]]
          );
          expect(markUndeleted.mock.calls).toStrictEqual(
            row.deleted ? [[row.id, type]] : []
          );
          expect(markDeleted).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('judges the note once its parse lands', () => {
    const cache: { current: CachedMetadata | null } = { current: null };
    const { manager, setFrontmatter } = wire(null);
    vi.spyOn(manager.app.metadataCache, 'getFileCache').mockImplementation(
      () => cache.current
    );
    const row = { id: 'a1', deleted: false };

    manager.reconcile(row, FILE, 'article', 'ir-article');
    expect(setFrontmatter).not.toHaveBeenCalled();

    cache.current = {
      frontmatter: { tags: ['ir-article'] },
    } as unknown as CachedMetadata;
    manager.reconcile(row, FILE, 'article', 'ir-article');
    expect(setFrontmatter.mock.calls).toStrictEqual([
      [FILE, 'a1', 'ir-article'],
    ]);
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
          const { manager, setFrontmatter, markDeleted, markUndeleted } = wire(
            settled
              ? ({
                  frontmatter: structuredClone(frontmatter),
                } as CachedMetadata)
              : null
          );

          expect(manager.reconcile(row, file, type, tag)).toBe(true);

          expect(setFrontmatter).not.toHaveBeenCalled();
          expect(markDeleted).not.toHaveBeenCalled();
          expect(markUndeleted).not.toHaveBeenCalled();
        }
      )
    );
  });
});

describe('setFrontmatter', () => {
  it('never writes to a file without frontmatter', async () => {
    await fc.assert(
      fc.asyncProperty(
        binaryFileArb,
        fc.string(),
        fc.oneof(fc.string(), fc.array(fc.string())),
        async (file, id, tags) => {
          const processFrontMatter = vi.fn().mockResolvedValue(undefined);
          const process = vi.fn().mockResolvedValue('');
          const manager = new TestManager(
            {
              app: { fileManager: { processFrontMatter }, vault: { process } },
            } as never,
            makeRepo().repo
          );

          await manager.setFrontmatter(file, id, tags);

          expect(processFrontMatter).not.toHaveBeenCalled();
          expect(process).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('writes the id and tags into a markdown note', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.oneof(fc.string(), fc.array(fc.string())),
        async (id, tags) => {
          const frontmatter: Record<string, unknown> = {};
          const processFrontMatter = vi.fn(
            async (_file: TFile, fn: (fm: Record<string, unknown>) => void) => {
              fn(frontmatter);
            }
          );
          const manager = new TestManager(
            { app: { fileManager: { processFrontMatter } } } as never,
            makeRepo().repo
          );

          await manager.setFrontmatter(FILE, id, tags);

          expect(processFrontMatter).toHaveBeenCalledOnce();
          expect(frontmatter).toStrictEqual({
            'ir-id': id,
            tags: Obsidian._mergeTags(undefined, tags),
          });
        }
      )
    );
  });
});
