// @vitest-environment jsdom
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { ArticleManager } from '#/lib/items/ArticleManager';
import { insertItemAt, makeItemVault, TestRepository } from '#/test/item-vault';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTICLE_TAG, CARD_TAG, SNIPPET_TAG } from './constants';
import {
  createDamagedNoteActions,
  mismatchOf,
  reassociatedFrontmatter,
  type Candidate,
  type DamagedNote,
  type LiveRow,
} from './damaged-note-actions';
import {
  createDamagedNotesNotice,
  type NoticeFactory,
  type NoticeTarget,
} from './ir-id-warning-notice';
import { createIrIdWatch } from './ir-id-watch';
import { TAG_BY_TABLE } from './item-tags';
import { claimedId } from './items/note-holding';
import { ITEM_TABLES, type ItemTable } from './moved-note-scan';

// lucide-react's icons use hooks, which under Vitest resolve against another
// preact instance than the one the notice renders its type icon with (see the
// react→preact aliasing TODO in vitest.config.ts): stand-ins that draw an
// SVG, as the real ones do
vi.mock('lucide-react', async () => {
  const { h } = await import('preact');
  return {
    FileText: () => h('svg', { 'data-icon': 'file-text' }),
    Scissors: () => h('svg', { 'data-icon': 'scissors' }),
  };
});

// #region HELPERS

interface StoredRow {
  table: ItemTable;
  id: string;
  reference: string;
  deleted: boolean;
}

type Frontmatter = Record<string, unknown>;

/**
 * Notes by path, as the vault holds them and, unless `staleCache` says what
 * the metadata cache last parsed instead, as the cache has them. A path held
 * with `undefined` frontmatter is a note with none; one in `parsing` is a note
 * the cache is part way through re-reading.
 */
function makeVault(initial: Record<string, Frontmatter | undefined> = {}) {
  const notes = new Map(Object.entries(initial));
  const parsing = new Set<string>();
  const staleCache = new Map<string, Frontmatter | undefined>();
  const files = new Map<string, TFile>();
  const fileAt = (path: string) => {
    const file =
      files.get(path) ?? ({ path, extension: 'md' } as unknown as TFile);
    files.set(path, file);
    return file;
  };
  const leaf = { openFile: vi.fn(async (_file: TFile) => {}) };
  return {
    notes,
    parsing,
    staleCache,
    leaf,
    fileAt,
    deps: {
      vault: {
        getFileByPath: vi.fn((path: string) =>
          notes.has(path) ? fileAt(path) : null
        ),
      },
      metadataCache: {
        getFileCache: vi.fn((file: TFile) =>
          notes.has(file.path) && !parsing.has(file.path)
            ? {
                frontmatter: staleCache.has(file.path)
                  ? staleCache.get(file.path)
                  : notes.get(file.path),
              }
            : null
        ),
      },
      fileManager: {
        /** Rewrites the note, as Obsidian's does, through a copy of it. */
        processFrontMatter: vi.fn(
          async (file: TFile, edit: (frontmatter: Frontmatter) => void) => {
            const frontmatter = structuredClone(notes.get(file.path) ?? {});
            edit(frontmatter);
            notes.set(file.path, frontmatter);
          }
        ),
      },
      workspace: { getLeaf: vi.fn((_newLeaf?: boolean) => leaf) },
    },
  };
}

async function makeActions(
  rows: readonly StoredRow[],
  notes: Record<string, Frontmatter | undefined> = {}
) {
  const repo = await TestRepository.create();
  for (const { table, ...row } of rows) insertItemAt(repo, table, row);
  const vault = makeVault(notes);
  const reassociateNote = vi.fn(
    async (_file: TFile, _table: ItemTable, _id: string, _from?: string) => {}
  );
  const onRepaired = vi.fn((_path: string) => {});
  const actions = createDamagedNoteActions({
    repo,
    ...vault.deps,
    reassociateNote,
    onRepaired,
  });
  return { repo, vault, actions, reassociateNote, onRepaired };
}

const PATHS = ['notes/one.md', 'notes/two.md', 'three.md', 'copy.md'];
const IDS = ['i1', 'i2', 'i3'];

/**
 * Rows over a few paths and ids, so they collide: a note is often at a path
 * some row holds, and an id often held by a row at another path (a copy).
 * Neither an id nor a reference repeats within a table, as the schema has it.
 */
const rowsArb: fc.Arbitrary<StoredRow[]> = fc
  .array(
    fc.record({
      table: fc.constantFrom(...ITEM_TABLES),
      id: fc.constantFrom(...IDS),
      reference: fc.constantFrom(...PATHS),
      deleted: fc.boolean(),
    }),
    { maxLength: 6 }
  )
  .map((rows) =>
    rows
      .filter(
        (row, i) =>
          rows.findIndex(
            (other) =>
              other.table === row.table &&
              (other.id === row.id || other.reference === row.reference)
          ) === i
      )
      .map((row) => ({ ...row }))
  );

/** Every `ir-id` a note can be left with: an id, none, or a value that isn't one. */
const irIdArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom<unknown>(...IDS),
  fc.constantFrom<unknown>(undefined, null, '', 0, false),
  fc.constantFrom<unknown>(7, true, 'other-id')
);

/** A tag entry: an item tag, a lookalike, or anything else. */
const tagEntryArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom<unknown>(
    ...Object.values(TAG_BY_TABLE),
    ...Object.values(TAG_BY_TABLE).map((tag) => `#${tag}`),
    'mine',
    null
  ),
  fc.string({ maxLength: 6 })
);

/** Every shape a frontmatter `tags` value can take. */
const tagsArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.array(tagEntryArb, { maxLength: 4 }),
  fc
    .array(tagEntryArb, { maxLength: 3 })
    .map((tags) => tags.filter((tag) => typeof tag === 'string').join(', ')),
  fc.constantFrom<unknown>(undefined, null, 0)
);

/** A note's frontmatter: its id, tags and a property of the user's own. */
const frontmatterArb: fc.Arbitrary<Frontmatter | undefined> = fc.option(
  fc
    .record(
      { 'ir-id': irIdArb, tags: tagsArb, mine: fc.string({ maxLength: 4 }) },
      { requiredKeys: [] }
    )
    .map((frontmatter) => ({ ...frontmatter })),
  { nil: undefined }
);

/** Notes at some of {@link PATHS}. */
const notesArb: fc.Arbitrary<Record<string, Frontmatter | undefined>> = fc
  .tuple(
    fc.subarray(PATHS),
    fc.array(frontmatterArb, {
      minLength: PATHS.length,
      maxLength: PATHS.length,
    })
  )
  .map(([paths, frontmatters]) =>
    Object.fromEntries(paths.map((path, i) => [path, frontmatters[i]]))
  );

/** The live rows at `path`, in the order the item tables are read. */
const liveAt = (rows: readonly StoredRow[], path: string) =>
  ITEM_TABLES.flatMap((table) =>
    rows.filter(
      (row) => row.table === table && row.reference === path && !row.deleted
    )
  );

/**
 * What became of the `ir-id` of a note at `path` as the rows have it, the
 * candidates as {@link mismatchOf} finds them over the live rows (it has tests
 * of its own): nothing to tell (null) for a note one of them holds, or none
 * of them could be re-associated with. A note with no row at its path is one
 * whose row moved away; else no id at all is one taken off, and any other
 * claim one changed. Tags play no part.
 */
function expectedDamage(
  rows: readonly StoredRow[],
  notes: Record<string, Frontmatter | undefined>,
  path: string
): DamagedNote | null {
  const irId = notes[path]?.['ir-id'];
  const live = ITEM_TABLES.flatMap((table) =>
    rows.filter((row) => row.table === table && !row.deleted)
  );
  const candidates = mismatchOf(
    path,
    claimedId(irId) ?? null,
    live.map(({ table, id, reference }) => ({ table, id, reference })),
    (reference) => reference in notes
  );
  if (!candidates) return null;
  const atPath = candidates.filter((candidate) => candidate.by === 'path');
  return {
    path,
    table: (atPath[0] ?? candidates[0]).table,
    change: atPath.length === 0 ? 'moved' : irId ? 'changed' : 'removed',
    restorable: atPath.length === 1,
    candidates,
  };
}

/** A candidate at the note's path `path`, as {@link mismatchOf} lists one. */
const atPathCandidate = (
  path: string,
  table: ItemTable,
  id: string
): Candidate => ({ by: 'path', table, id, reference: path, blocked: null });

/** Type tags, plain words and lookalikes, as a hand-kept list holds them. */
const plainTagsArb: fc.Arbitrary<string[] | undefined> = fc.option(
  fc.array(
    fc.constantFrom(...Object.values(TAG_BY_TABLE), 'mine', 'ir-cardish'),
    { maxLength: 4 }
  ),
  { nil: undefined }
);

/**
 * `tags` as an explicit re-association to an item of `table` leaves them:
 * every other item type's tag taken off, its own added last if missing.
 */
function reassociatedTags(
  tags: readonly string[] | undefined,
  table: ItemTable
): string[] {
  const own = TAG_BY_TABLE[table];
  const others = Object.values(TAG_BY_TABLE).filter((tag) => tag !== own);
  const kept = (tags ?? []).filter((tag) => !others.includes(tag));
  return kept.includes(own) ? kept : [...kept, own];
}

/** Notices that hide on a click, as Obsidian's do. */
function makeNotices() {
  const raised: (NoticeTarget & { hides: number })[] = [];
  const createNotice = vi.fn<NoticeFactory>((message: string) => {
    const containerEl = document.body.createDiv('notice');
    containerEl.createDiv({ cls: 'notice-message', text: message });
    const notice = {
      containerEl,
      hides: 0,
      setMessage(next: string) {
        containerEl.querySelector('.notice-message')!.textContent = next;
        return notice;
      },
      hide() {
        notice.hides += 1;
        containerEl.remove();
      },
    };
    containerEl.addEventListener('click', () => notice.hide());
    raised.push(notice);
    return notice;
  });
  return { raised, createNotice };
}

/** The row a notice shows for the note at `path`, if any. */
const rowFor = (notice: NoticeTarget, path: string) =>
  [
    ...notice.containerEl.querySelectorAll<HTMLElement>('.ir-damaged-note'),
  ].find((row) => row.dataset.path === path) ?? null;

/** Let every promise that can settle without a timer settle. */
const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** Paths a note or row may be at, and ids; few, so they collide. */
const MISMATCH_PATHS = ['a.md', 'b.md', 'c.md'];
const MISMATCH_IDS = ['i1', 'i2', 'i3'];

/**
 * Live rows of any table over {@link MISMATCH_PATHS} and {@link MISMATCH_IDS},
 * unconstrained: broader than the schema allows, which repeats neither an id
 * nor a reference within a table.
 */
const liveRowsArb: fc.Arbitrary<LiveRow[]> = fc.array(
  fc.record({
    table: fc.constantFrom(...ITEM_TABLES),
    id: fc.constantFrom(...MISMATCH_IDS),
    reference: fc.constantFrom(...MISMATCH_PATHS),
  }),
  { maxLength: 6 }
);

describe('mismatchOf', () => {
  it("lists every row at the note's path, then every row holding its claim elsewhere, unless a row at its path holds that claim or nothing could be re-associated", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MISMATCH_PATHS),
        fc.option(fc.constantFrom(...MISMATCH_IDS, 'other'), { nil: null }),
        liveRowsArb,
        fc.subarray(MISMATCH_PATHS),
        (path, claim, rows, files) => {
          const fileAt = (reference: string) => files.includes(reference);

          const found = mismatchOf(path, claim, rows, fileAt);

          const atPath = rows.filter((row) => row.reference === path);
          const elsewhere = rows.filter(
            (row) =>
              claim !== null && row.id === claim && row.reference !== path
          );
          const held = atPath.some((row) => row.id === claim);
          const movable = elsewhere.some((row) => !fileAt(row.reference));
          if (held || (atPath.length === 0 && !movable)) {
            expect(found).toBeNull();
            return;
          }
          expect(found).toStrictEqual([
            ...atPath.map((row) => ({ ...row, by: 'path', blocked: null })),
            ...elsewhere.map((row) => ({
              ...row,
              by: 'id',
              blocked: fileAt(row.reference)
                ? 'occupied'
                : atPath.length > 0
                  ? 'held'
                  : null,
            })),
          ]);
        }
      )
    );
  });

  it('offers both rows of two tables sharing the path of a note neither holds, and nothing once either does', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...ITEM_TABLES), {
          minLength: 2,
          maxLength: 2,
        }),
        fc.constantFrom(null, 'other', 'i1', 'i2'),
        ([first, second], claim) => {
          const rows: LiveRow[] = [
            { table: first, id: 'i1', reference: 'a.md' },
            { table: second, id: 'i2', reference: 'a.md' },
          ];

          const found = mismatchOf('a.md', claim, rows, () => true);

          if (claim === 'i1' || claim === 'i2') expect(found).toBeNull();
          else {
            expect(found?.map(({ table, by }) => [table, by])).toStrictEqual([
              [first, 'path'],
              [second, 'path'],
            ]);
          }
        }
      )
    );
  });

  it('says nothing of a copy, a note claiming an id whose row points where a file is, with no row at its path', () => {
    expect(
      mismatchOf(
        'copy.md',
        'i1',
        [{ table: 'article', id: 'i1', reference: 'a.md' }],
        () => true
      )
    ).toBeNull();
  });
});

describe('createDamagedNoteActions', () => {
  describe('describe', () => {
    it('answers, for each note no live row holds, whether its ir-id was taken off or changed or its row moved away, the table of the row at its path, and the rows it could be re-associated with, whatever its tags', async () => {
      await fc.assert(
        fc.asyncProperty(rowsArb, notesArb, async (rows, notes) => {
          const { actions } = await makeActions(rows, notes);

          const described = await actions.describe(PATHS);

          const expected = PATHS.flatMap((path) => {
            if (!(path in notes)) return [];
            const damage = expectedDamage(rows, notes, path);
            return damage ? [damage] : [];
          });
          expect(described).toStrictEqual(expected);
        })
      );
    });

    it("names the live row's table, whatever row's tombstone shares its path", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...ITEM_TABLES),
          fc.constantFrom(...ITEM_TABLES),
          async (table, buried) => {
            fc.pre(table !== buried);
            const { actions } = await makeActions(
              [
                { table, id: 'i1', reference: 'a.md', deleted: false },
                { table: buried, id: 'i2', reference: 'a.md', deleted: true },
              ],
              { 'a.md': {} }
            );

            expect(await actions.describe(['a.md'])).toStrictEqual([
              {
                path: 'a.md',
                table,
                change: 'removed',
                restorable: true,
                candidates: [atPathCandidate('a.md', table, 'i1')],
              },
            ]);
          }
        )
      );
    });

    it('passes over a note the metadata cache is part way through re-reading', async () => {
      const { vault, actions } = await makeActions(
        [{ table: 'article', id: 'i1', reference: 'a.md', deleted: false }],
        { 'a.md': {} }
      );
      vault.parsing.add('a.md');

      expect(await actions.describe(['a.md'])).toStrictEqual([]);
    });

    it('passes over a file with no frontmatter at a live row, a PDF, which holds the row by its path', async () => {
      const { vault, actions } = await makeActions(
        [{ table: 'article', id: 'i1', reference: 'a.pdf', deleted: false }],
        { 'a.pdf': undefined }
      );
      (vault.fileAt('a.pdf') as { extension: string }).extension = 'pdf';

      expect(await actions.describe(['a.pdf'])).toStrictEqual([]);
    });

    it("lists the row holding the note's id elsewhere beside the row at its path, no action for it while a file is where it points, and alone for a note whose row moved away", async () => {
      const { actions } = await makeActions(
        [
          { table: 'article', id: 'i1', reference: 'a.md', deleted: false },
          { table: 'snippet', id: 'i2', reference: 'b.md', deleted: false },
          { table: 'srs_card', id: 'i3', reference: 'c.md', deleted: false },
        ],
        { 'a.md': { 'ir-id': 'i2' }, 'b.md': {}, 'd.md': { 'ir-id': 'i3' } }
      );

      expect(await actions.describe(['a.md', 'd.md'])).toStrictEqual([
        {
          path: 'a.md',
          table: 'article',
          change: 'changed',
          restorable: true,
          candidates: [
            atPathCandidate('a.md', 'article', 'i1'),
            {
              by: 'id',
              table: 'snippet',
              id: 'i2',
              reference: 'b.md',
              blocked: 'occupied',
            },
          ],
        },
        {
          path: 'd.md',
          table: 'srs_card',
          change: 'moved',
          restorable: false,
          candidates: [
            {
              by: 'id',
              table: 'srs_card',
              id: 'i3',
              reference: 'c.md',
              blocked: null,
            },
          ],
        },
      ]);
    });
  });

  describe('unread', () => {
    it('is true of a note the metadata cache has not read yet, and false of one it has or of no note', async () => {
      const { vault, actions } = await makeActions(
        [{ table: 'article', id: 'i1', reference: 'a.md', deleted: false }],
        { 'a.md': {}, 'b.md': { 'ir-id': 'i1' } }
      );
      vault.parsing.add('a.md');

      expect(
        ['a.md', 'b.md', 'gone.md'].map((path) => actions.unread(path))
      ).toStrictEqual([true, false, false]);
    });
  });

  describe('reassociate', () => {
    it("writes the id of the path row chosen of two sharing the note's path into it, through the item layer, and tells of the repair", async () => {
      const { actions, vault, reassociateNote, onRepaired } = await makeActions(
        [
          { table: 'article', id: 'i1', reference: 'a.md', deleted: false },
          { table: 'snippet', id: 'i2', reference: 'a.md', deleted: false },
        ],
        { 'a.md': {} }
      );

      expect(
        await actions.reassociate(
          'a.md',
          atPathCandidate('a.md', 'snippet', 'i2')
        )
      ).toBe(true);

      expect(reassociateNote).toHaveBeenCalledExactlyOnceWith(
        vault.fileAt('a.md'),
        'snippet',
        'i2',
        'a.md'
      );
      expect(onRepaired).toHaveBeenCalledExactlyOnceWith('a.md');
    });

    it("brings the row holding the note's id here from where it points, when no file is there and no live row holds this path", async () => {
      const { actions, vault, reassociateNote, onRepaired } = await makeActions(
        [{ table: 'article', id: 'i1', reference: 'old.md', deleted: false }],
        { 'new.md': { 'ir-id': 'i1' } }
      );

      expect(
        await actions.reassociate('new.md', {
          by: 'id',
          table: 'article',
          id: 'i1',
          reference: 'old.md',
          blocked: null,
        })
      ).toBe(true);

      expect(reassociateNote).toHaveBeenCalledExactlyOnceWith(
        vault.fileAt('new.md'),
        'article',
        'i1',
        'old.md'
      );
      expect(onRepaired).toHaveBeenCalledExactlyOnceWith('new.md');
    });

    it("does nothing, answering false, for a row it would not offer now: blocked, not at the note's path, holding the note already, or for a note gone or mid-parse", async () => {
      const { actions, vault, reassociateNote, onRepaired } = await makeActions(
        [
          { table: 'article', id: 'i1', reference: 'a.md', deleted: false },
          { table: 'snippet', id: 'i2', reference: 'b.md', deleted: false },
          { table: 'srs_card', id: 'i3', reference: 'c.md', deleted: false },
        ],
        {
          'a.md': { 'ir-id': 'i2' },
          'b.md': {},
          'c.md': { 'ir-id': 'i3' },
          'p.md': {},
        }
      );
      vault.parsing.add('p.md');

      const asked: [string, Candidate][] = [
        // A file is at its reference, and the article holds a.md
        [
          'a.md',
          {
            by: 'id',
            table: 'snippet',
            id: 'i2',
            reference: 'b.md',
            blocked: null,
          },
        ],
        ['a.md', atPathCandidate('a.md', 'snippet', 'i2')],
        // Each one field off the article at a.md's path
        [
          'a.md',
          {
            ...atPathCandidate('a.md', 'article', 'i1'),
            by: 'id',
          },
        ],
        ['a.md', atPathCandidate('a.md', 'snippet', 'i1')],
        ['a.md', atPathCandidate('a.md', 'article', 'i9')],
        ['c.md', atPathCandidate('c.md', 'srs_card', 'i3')],
        ['gone.md', atPathCandidate('gone.md', 'article', 'i1')],
        ['p.md', atPathCandidate('p.md', 'article', 'i1')],
      ];
      for (const [path, candidate] of asked) {
        expect(await actions.reassociate(path, candidate)).toBe(false);
      }

      expect(reassociateNote).not.toHaveBeenCalled();
      expect(onRepaired).not.toHaveBeenCalled();
    });

    it('writes nothing while writes are refused, and says why', async () => {
      const notify = vi.spyOn(Obsidian, 'notify').mockImplementation(() => {});
      const { repo, actions, reassociateNote } = await makeActions(
        [{ table: 'article', id: 'i1', reference: 'a.md', deleted: false }],
        { 'a.md': {} }
      );
      repo.refuseWrites();

      expect(
        await actions.reassociate(
          'a.md',
          atPathCandidate('a.md', 'article', 'i1')
        )
      ).toBe(false);

      expect(reassociateNote).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledOnce();
    });

    it('writes nothing when the row has left the path by the time the database settles', async () => {
      const { repo, actions, reassociateNote } = await makeActions(
        [{ table: 'article', id: 'i1', reference: 'a.md', deleted: false }],
        { 'a.md': {} }
      );
      const release = repo.holdMerging();
      const done = actions.reassociate(
        'a.md',
        atPathCandidate('a.md', 'article', 'i1')
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      repo.mutate(`UPDATE article SET reference = 'c.md' WHERE id = 'i1'`);
      release();

      expect(await done).toBe(false);
      expect(reassociateNote).not.toHaveBeenCalled();
    });

    it('rejects with what the item layer threw, telling of no repair', async () => {
      const { actions, reassociateNote, onRepaired } = await makeActions(
        [{ table: 'article', id: 'i1', reference: 'a.md', deleted: false }],
        { 'a.md': {} }
      );
      const failure = new Error('write failed');
      reassociateNote.mockRejectedValueOnce(failure);

      await expect(
        actions.reassociate('a.md', atPathCandidate('a.md', 'article', 'i1'))
      ).rejects.toBe(failure);
      expect(onRepaired).not.toHaveBeenCalled();
    });
  });

  describe('restore', () => {
    it("writes the id of the one live row at the note's path back into it, with that row's type tag in place of any other type's, and nothing to any other note", async () => {
      await fc.assert(
        fc.asyncProperty(
          rowsArb,
          notesArb,
          fc.constantFrom(...PATHS),
          fc.option(plainTagsArb, { nil: null }),
          async (rows, notes, path, tags) => {
            // Some notes with tags simple enough to model the rewrite of
            if (tags !== null && path in notes) {
              notes = { ...notes, [path]: { ...notes[path], tags } };
            }
            const { vault, actions } = await makeActions(rows, notes);
            const before = structuredClone(notes);

            const restored = await actions.restore(path);

            const live = liveAt(rows, path);
            const owner = path in notes && live.length === 1 ? live[0] : null;
            expect(restored).toBe(owner !== null);
            for (const at of PATHS) {
              if (!(at in before)) {
                expect(vault.notes.has(at)).toBe(false);
                continue;
              }
              const was = before[at];
              if (at !== path || !owner || was?.['ir-id'] === owner.id) {
                expect(vault.notes.get(at)).toStrictEqual(was);
                continue;
              }
              const written = vault.notes.get(at)!;
              expect({ ...written, tags: undefined }).toStrictEqual({
                ...was,
                'ir-id': owner.id,
                tags: undefined,
              });
              if (tags !== null) {
                expect(written.tags).toStrictEqual(
                  reassociatedTags(tags, owner.table)
                );
              }
            }
          }
        )
      );
    });

    it('tells of the repair of a note it wrote, and of none when it wrote nothing', async () => {
      const { vault, actions, onRepaired } = await makeActions(
        [
          { table: 'article', id: 'i1', reference: 'a.md', deleted: false },
          { table: 'article', id: 'i2', reference: 'b.md', deleted: false },
        ],
        { 'a.md': {}, 'b.md': { 'ir-id': 'i2' } }
      );

      expect(await actions.restore('a.md')).toBe(true);
      expect(onRepaired).toHaveBeenCalledExactlyOnceWith('a.md');
      onRepaired.mockClear();
      vault.deps.fileManager.processFrontMatter.mockResolvedValueOnce(
        undefined
      );
      vault.notes.set('a.md', {});

      expect(await actions.restore('a.md')).toBe(false);
      expect(await actions.restore('b.md')).toBe(true);
      expect(onRepaired).not.toHaveBeenCalled();
    });

    it('restores a note that lost its id and one that claims another alike', async () => {
      for (const irId of [undefined, 'another-item']) {
        const { vault, actions } = await makeActions(
          [{ table: 'snippet', id: 'i1', reference: 'a.md', deleted: false }],
          { 'a.md': { 'ir-id': irId, tags: 'mine #ir-card', extra: 1 } }
        );

        expect(await actions.restore('a.md')).toBe(true);

        expect(vault.notes.get('a.md')).toStrictEqual({
          'ir-id': 'i1',
          tags: ['mine', SNIPPET_TAG],
          extra: 1,
        });
      }
    });

    it('never writes to a copy, which no live row holds at its path, nor where two live rows share it', async () => {
      const { vault, actions } = await makeActions(
        [
          { table: 'article', id: 'i1', reference: 'one.md', deleted: false },
          { table: 'snippet', id: 'i2', reference: 'two.md', deleted: false },
          { table: 'srs_card', id: 'i3', reference: 'two.md', deleted: false },
          { table: 'srs_card', id: 'i4', reference: 'gone.md', deleted: true },
        ],
        { 'copy.md': { 'ir-id': 'i1' }, 'two.md': {}, 'gone.md': {} }
      );

      expect(await actions.restore('copy.md')).toBe(false);
      expect(await actions.restore('two.md')).toBe(false);
      expect(await actions.restore('gone.md')).toBe(false);

      expect(vault.deps.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    it('writes nothing to a note whose file already carries the id, whatever the cache last read', async () => {
      const { vault, actions } = await makeActions(
        [{ table: 'article', id: 'i1', reference: 'a.md', deleted: false }],
        { 'a.md': { 'ir-id': 'i1', tags: ['mine'] } }
      );
      // Mended on disk since the cache last parsed it
      vault.staleCache.set('a.md', { tags: ['mine'] });

      expect(await actions.restore('a.md')).toBe(true);

      expect(vault.notes.get('a.md')).toStrictEqual({
        'ir-id': 'i1',
        tags: ['mine'],
      });
    });

    it('tries no write to a note whose cache already carries the id', async () => {
      const { vault, actions } = await makeActions(
        [{ table: 'article', id: 'i1', reference: 'a.md', deleted: false }],
        { 'a.md': { 'ir-id': 'i1' } }
      );

      expect(await actions.restore('a.md')).toBe(true);

      expect(vault.deps.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    it('answers false, writing nothing, for a note gone or mid-parse', async () => {
      const { vault, actions } = await makeActions(
        [
          { table: 'article', id: 'i1', reference: 'a.md', deleted: false },
          { table: 'snippet', id: 'i2', reference: 'b.md', deleted: false },
        ],
        { 'a.md': {} }
      );
      vault.parsing.add('a.md');

      expect(await actions.restore('a.md')).toBe(false);
      expect(await actions.restore('b.md')).toBe(false);

      expect(vault.deps.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    it('writes nothing while writes are refused, and says why', async () => {
      const notify = vi.spyOn(Obsidian, 'notify').mockImplementation(() => {});
      const { repo, vault, actions } = await makeActions(
        [{ table: 'srs_card', id: 'i1', reference: 'a.md', deleted: false }],
        { 'a.md': {} }
      );
      repo.refuseWrites();

      expect(await actions.restore('a.md')).toBe(false);

      expect(vault.notes.get('a.md')).toStrictEqual({});
      expect(notify).toHaveBeenCalledOnce();
    });

    it('gives the id of the row at the path once the database settles, not the one read before', async () => {
      const { repo, vault, actions } = await makeActions(
        [
          { table: 'article', id: 'i1', reference: 'a.md', deleted: false },
          { table: 'article', id: 'i2', reference: 'b.md', deleted: false },
        ],
        { 'a.md': {} }
      );
      // A merge under way, bringing a database where another row holds the path
      const release = repo.holdMerging();
      const restored = actions.restore('a.md');
      await new Promise((resolve) => setTimeout(resolve, 0));
      repo.mutate(`UPDATE article SET reference = 'c.md' WHERE id = 'i1'`);
      repo.mutate(`UPDATE article SET reference = 'a.md' WHERE id = 'i2'`);
      release();

      expect(await restored).toBe(true);
      expect(vault.notes.get('a.md')).toStrictEqual({
        'ir-id': 'i2',
        tags: [ARTICLE_TAG],
      });
    });
    it('writes nothing when the row has left the path by the time the database settles', async () => {
      const { repo, vault, actions } = await makeActions(
        [{ table: 'article', id: 'i1', reference: 'a.md', deleted: false }],
        { 'a.md': {} }
      );
      const release = repo.holdMerging();
      const restored = actions.restore('a.md');
      await new Promise((resolve) => setTimeout(resolve, 0));
      repo.mutate(`UPDATE article SET reference = 'c.md' WHERE id = 'i1'`);
      release();

      expect(await restored).toBe(false);
      expect(vault.deps.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });
    it('answers false when the write never reached the frontmatter', async () => {
      const { vault, actions } = await makeActions(
        [{ table: 'article', id: 'i1', reference: 'a.md', deleted: false }],
        { 'a.md': {} }
      );
      // As Obsidian's does for a file it keeps no frontmatter in: silently
      vault.deps.fileManager.processFrontMatter.mockResolvedValueOnce(
        undefined
      );

      expect(await actions.restore('a.md')).toBe(false);
    });
  });

  describe('reassociatedFrontmatter', () => {
    it('writes the id and type tag of each table, taking off every other type tag', () => {
      for (const [table, tag] of [
        ['article', ARTICLE_TAG],
        ['snippet', SNIPPET_TAG],
        ['srs_card', CARD_TAG],
      ] as const) {
        const frontmatter: Frontmatter = {
          'ir-id': 'old',
          tags: Object.values(TAG_BY_TABLE),
          kept: 'x',
        };

        reassociatedFrontmatter(frontmatter, { table, id: 'new' });

        expect(frontmatter).toStrictEqual({
          'ir-id': 'new',
          tags: [tag],
          kept: 'x',
        });
      }
    });

    it('leaves its own type tag where it was, and every other tag in order', () => {
      const frontmatter: Frontmatter = {
        tags: [SNIPPET_TAG, 'mine', ARTICLE_TAG, 'also'],
      };

      reassociatedFrontmatter(frontmatter, { table: 'snippet', id: 'i1' });

      expect(frontmatter).toStrictEqual({
        'ir-id': 'i1',
        tags: [SNIPPET_TAG, 'mine', 'also'],
      });
    });

    it('adds the type tag under the tags key the note spells, in whatever case', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('Tags', 'TAGS', 'tAgS'),
          fc.constantFrom(...ITEM_TABLES),
          (key, table) => {
            const frontmatter: Frontmatter = { [key]: ['mine'] };

            reassociatedFrontmatter(frontmatter, { table, id: 'i1' });

            expect(frontmatter).toStrictEqual({
              'ir-id': 'i1',
              [key]: ['mine', TAG_BY_TABLE[table]],
            });
          }
        )
      );
    });
  });

  describe('open', () => {
    it('opens the note in the current tab', async () => {
      const { vault, actions } = await makeActions([], { 'a.md': {} });

      expect(await actions.open('a.md')).toBe(true);

      expect(vault.deps.workspace.getLeaf).toHaveBeenCalledExactlyOnceWith(
        false
      );
      expect(vault.leaf.openFile).toHaveBeenCalledExactlyOnceWith(
        vault.fileAt('a.md')
      );
    });

    it('answers false, opening nothing, when the note is gone', async () => {
      const { vault, actions } = await makeActions([]);

      expect(await actions.open('a.md')).toBe(false);

      expect(vault.deps.workspace.getLeaf).not.toHaveBeenCalled();
    });
  });
});

describe('an item note edited on screen', () => {
  const ROW: StoredRow = {
    table: 'article',
    id: 'a1',
    reference: 'notes/one.md',
    deleted: false,
  };

  /** The watch, the notice and its actions over one item and its note. */
  async function wireAll() {
    const { repo, vault, actions } = await makeActions([ROW], {
      [ROW.reference]: { 'ir-id': 'a1', tags: ['keep', ARTICLE_TAG] },
    });
    const { raised, createNotice } = makeNotices();
    const notice = createDamagedNotesNotice(createNotice, actions);
    const reports: Promise<void>[] = [];
    const watch = createIrIdWatch({
      repo,
      vault: vault.deps.vault,
      metadataCache: vault.deps.metadataCache,
      onDamage: (paths) => reports.push(notice.report(paths)),
      isShown: () => true,
      settle: async () => {},
      schedule: () => () => {},
    });
    /** One pass over the note, as its `changed` brings one on. */
    const pass = async () => {
      watch.handleChange({ path: ROW.reference, extension: 'md' });
      const reported = await watch.flush();
      await Promise.all(reports);
      return reported;
    };
    const edit = (frontmatter: Frontmatter) => {
      vault.notes.set(ROW.reference, frontmatter);
      return pass();
    };
    return { vault, raised, createNotice, pass, edit };
  }

  it('raises no notice for its type tag taken off, and one to open it from once its ir-id is changed', async () => {
    const { vault, raised, createNotice, edit } = await wireAll();

    await edit({ 'ir-id': 'a1', tags: ['keep'] });
    await edit({ 'ir-id': 'a1', tags: ['keep', TAG_BY_TABLE.snippet] });
    expect(createNotice).not.toHaveBeenCalled();

    await edit({ 'ir-id': 'typed-over', tags: ['keep'] });
    expect(createNotice).toHaveBeenCalledOnce();
    rowFor(raised[0], ROW.reference)
      ?.querySelector<HTMLElement>('.ir-damaged-note-open')
      ?.click();
    await drain();

    expect(vault.leaf.openFile).toHaveBeenCalledExactlyOnceWith(
      vault.fileAt(ROW.reference)
    );
    expect(raised[0].hides).toBe(0);
  });

  it('gets its ir-id back from Restore, leaves the notice, goes untold by the next pass, and is told of afresh if changed again', async () => {
    const { vault, raised, createNotice, pass, edit } = await wireAll();

    expect(await edit({ 'ir-id': 'typed-over', tags: ['keep'] })).toStrictEqual(
      [ROW.reference]
    );
    const row = rowFor(raised[0], ROW.reference);
    expect(row).not.toBeNull();
    row?.querySelector<HTMLElement>('.ir-damaged-note-restore')?.click();
    // The only note it listed, so the notice goes with it
    await vi.waitFor(() => expect(raised[0].hides).toBe(1));
    expect(vault.notes.get(ROW.reference)).toStrictEqual({
      'ir-id': 'a1',
      tags: ['keep', ARTICLE_TAG],
    });

    // The restore's own write, as the metadata cache raises it
    expect(await pass()).toStrictEqual([]);
    expect(await edit({ 'ir-id': 'again', tags: ['keep'] })).toStrictEqual([
      ROW.reference,
    ]);
    expect(createNotice).toHaveBeenCalledTimes(2);
    expect(rowFor(raised[1], ROW.reference)).not.toBeNull();
  });
});

describe('a note given its id back by Restore, as the rest of the plugin reads it after', () => {
  const NOTE = 'notes/item.md';
  const OTHER = 'notes/other.md';

  /**
   * Article `y` at {@link NOTE}, whose note carries `frontmatter`, and article
   * `x` at {@link OTHER} with its note whole. Each row's fingerprint is the
   * note's mtime as the plugin last wrote its identity: `y`'s from before the
   * user's edit, `x`'s its note's mtime now.
   */
  async function world(frontmatter: Frontmatter) {
    const vault = makeItemVault({
      [NOTE]: frontmatter,
      [OTHER]: { 'ir-id': 'x', tags: [ARTICLE_TAG] },
    });
    const repo = await TestRepository.create();
    insertItemAt(repo, 'article', { id: 'y', reference: NOTE, deleted: false });
    insertItemAt(repo, 'article', {
      id: 'x',
      reference: OTHER,
      deleted: false,
    });
    const mtime = (path: string) => vault.files.get(path)!.stat.mtime;
    repo.mutate(`UPDATE article SET note_mtime = $1 WHERE id = 'y'`, [
      mtime(NOTE) - 1,
    ]);
    repo.mutate(`UPDATE article SET note_mtime = $1 WHERE id = 'x'`, [
      mtime(OTHER),
    ]);
    const { app } = vault;
    const manager = new ArticleManager(
      {
        app: { ...app, workspace: { trigger: vi.fn() } },
        settings: {},
      } as never,
      repo
    );
    const actions = createDamagedNoteActions({
      repo,
      vault: app.vault,
      metadataCache: app.metadataCache,
      fileManager: app.fileManager,
      workspace: { getLeaf: vi.fn() },
      reassociateNote: (...args) => manager.reassociateNote(...args),
      onRepaired: vi.fn(),
    });
    const onDamage = vi.fn();
    const watch = createIrIdWatch({
      repo,
      vault: app.vault,
      metadataCache: app.metadataCache,
      onDamage,
      isShown: () => true,
      settle: async () => {},
      schedule: () => () => {},
    });
    return { vault, repo, actions, manager, watch, onDamage };
  }

  it.each([
    ['taken off', { tags: ['keep'] }],
    ["typed over with another item's", { 'ir-id': 'x', tags: ['keep'] }],
  ])(
    "is its row's note again once its id was %s, and nothing changes either row or the other note",
    async (_, frontmatter) => {
      const { vault, repo, actions, manager, watch, onDamage } =
        await world(frontmatter);
      const rowsBefore = repo.storedRows('article');
      const otherBefore = structuredClone(vault.frontmatterOf(OTHER));

      expect(await actions.restore(NOTE)).toBe(true);

      expect(vault.frontmatterOf(NOTE)).toStrictEqual({
        'ir-id': 'y',
        tags: ['keep', ARTICLE_TAG],
      });
      // The metadata cache's `changed` for the write, as the watch hears it
      watch.handleChange(vault.files.get(NOTE)!);
      expect(await watch.flush()).toStrictEqual([]);
      expect(onDamage).not.toHaveBeenCalled();
      // A review fetch squares each row with the note at its path
      expect((await manager.fetch('y'))?.file?.path).toBe(NOTE);
      expect((await manager.fetch('x'))?.file?.path).toBe(OTHER);
      expect(await manager.getItemType(vault.files.get(NOTE)!)).toBe('article');
      expect(await manager.getItemType(vault.files.get(OTHER)!)).toBe(
        'article'
      );
      // Neither row tombstoned, re-pointed or given a new fingerprint
      expect(repo.storedRows('article')).toStrictEqual(rowsBefore);
      expect(vault.frontmatterOf(OTHER)).toStrictEqual(otherBefore);
    }
  );
});
