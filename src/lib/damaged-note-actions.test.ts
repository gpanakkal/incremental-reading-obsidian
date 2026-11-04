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
  reassociatedFrontmatter,
  type DamagedNote,
} from './damaged-note-actions';
import {
  createDamagedNotesNotice,
  type NoticeFactory,
  type NoticeTarget,
} from './ir-id-warning-notice';
import { createIrIdWatch } from './ir-id-watch';
import { TAG_BY_TABLE } from './item-tags';
import { ITEM_TABLES, type ItemTable } from './moved-note-scan';

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
  const actions = createDamagedNoteActions({ repo, ...vault.deps });
  return { repo, vault, actions };
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
 * What became of the `ir-id` of a note at `path`, as the rows have it:
 * nothing to tell (null) unless a live row is at its path. No id at all is
 * one taken off; an id other than a live row's there is one changed. Tags
 * play no part.
 */
function expectedDamage(
  rows: readonly StoredRow[],
  path: string,
  frontmatter: Frontmatter | undefined
): DamagedNote | null {
  const live = liveAt(rows, path);
  if (live.length === 0) return null;
  const irId = frontmatter?.['ir-id'];
  const restorable = live.length === 1;
  if (!irId) {
    return { path, table: live[0].table, change: 'removed', restorable };
  }
  return live.some((row) => row.id !== irId)
    ? { path, table: live[0].table, change: 'changed', restorable }
    : null;
}

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

describe('createDamagedNoteActions', () => {
  describe('describe', () => {
    it('answers, for each note, whether its ir-id was taken off or changed and the table of the row at its path, whatever its tags', async () => {
      await fc.assert(
        fc.asyncProperty(rowsArb, notesArb, async (rows, notes) => {
          const { actions } = await makeActions(rows, notes);

          const described = await actions.describe(PATHS);

          const expected = PATHS.flatMap((path) => {
            if (!(path in notes)) return [];
            const damage = expectedDamage(rows, path, notes[path]);
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
              { path: 'a.md', table, change: 'removed', restorable: true },
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
    const actions = createDamagedNoteActions({
      repo,
      vault: app.vault,
      metadataCache: app.metadataCache,
      fileManager: app.fileManager,
      workspace: { getLeaf: vi.fn() },
    });
    const manager = new ArticleManager(
      {
        app: { ...app, workspace: { trigger: vi.fn() } },
        settings: {},
      } as never,
      repo
    );
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
