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
        ).resolves.toBe(1);

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
