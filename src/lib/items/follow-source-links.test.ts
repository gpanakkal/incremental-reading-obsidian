import { MAX_SQL_QUERY_PARAMS } from '#/lib/constants';
import { SQLJSRepository } from '#/lib/repository/SQLJSRepository';
import { makeLinkVault } from '#/test/link-vault';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import type { App } from 'obsidian';
import { resolve } from 'path';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { followSourceLinks } from './follow-source-links';
import { ItemManager } from './ItemManager';

// #region HELPERS
const SCHEMA = readFileSync(resolve(__dirname, '../../db/schema.sql'), 'utf-8');
let SQL: SqlJsStatic;

/** A repository over a real in-memory database, with the disk write stubbed. */
class TestRepository extends SQLJSRepository {
  static create(): TestRepository {
    const repo = new TestRepository({
      app: { vault: { adapter: {} } } as unknown as App,
      dbFilePath: 'ir-test.sqlite',
      schema: SCHEMA,
    });
    repo.db = new SQL.Database();
    repo.db.exec(SCHEMA);
    return repo;
  }

  protected override async save() {}
}

type Table = 'article' | 'snippet' | 'srs_card';

/** A row of `table` for the note at `reference`, with its id the note's. */
function insertRow(
  repo: TestRepository,
  table: Table,
  reference: string,
  {
    parent = null,
    deleted = false,
  }: { parent?: string | null; deleted?: boolean } = {}
) {
  const id = idOf(reference);
  if (table === 'article') {
    repo.mutate(
      `INSERT INTO article (id, reference, deleted, due, interval, priority)
       VALUES ($1, $2, $3, 0, 86400000, 30)`,
      [id, reference, deleted]
    );
  } else if (table === 'snippet') {
    repo.mutate(
      `INSERT INTO snippet (id, reference, parent, deleted, due, interval, priority)
       VALUES ($1, $2, $3, $4, 0, 86400000, 30)`,
      [id, reference, parent, deleted]
    );
  } else {
    repo.mutate(
      `INSERT INTO srs_card (id, reference, parent, deleted, created_at, due,
         stability, difficulty, elapsed_days, scheduled_days, state)
       VALUES ($1, $2, $3, $4, 0, 0, 0, 0, 0, 0, 0)`,
      [id, reference, parent, deleted]
    );
  }
  return id;
}

const idOf = (path: string) => `id-of-${path}`;

/**
 * A vault of `notes` (path → its `source`, or null for a file with no
 * frontmatter), each an item's by its `ir-id`, over a real database, and the
 * manager to follow links with.
 */
function wire(notes: Record<string, string | null>) {
  const vault = makeLinkVault(
    Object.fromEntries(
      Object.entries(notes).map(([path, source]) => [
        path,
        source === null ? null : { 'ir-id': idOf(path), source },
      ])
    )
  );
  const repo = TestRepository.create();
  const manager = new ItemManager({ app: vault.app } as never, repo);
  return { ...vault, repo, manager };
}
// #endregion

describe('followSourceLinks', () => {
  beforeAll(async () => {
    const wasmBinary = readFileSync(
      require.resolve('sql.js/dist/sql-wasm.wasm')
    );
    SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('points the links of the parentless snippets and cards taken from a moved file at where it went', async () => {
    const wired = wire({
      'notes/Paper.md': null,
      'IR/snippets/s.md': '[[notes/Paper|Paper]]',
      'IR/cards/c.md': '[[notes/Paper.md]]',
    });
    insertRow(wired.repo, 'snippet', 'IR/snippets/s.md');
    insertRow(wired.repo, 'srs_card', 'IR/cards/c.md');
    wired.move('notes/Paper.md', 'archive/Paper 2.md');

    await expect(
      followSourceLinks(wired.manager, [
        {
          from: 'notes/Paper.md',
          file: wired.files.get('archive/Paper 2.md')!,
        },
      ])
    ).resolves.toBe(2);

    expect(wired.sourceOf('IR/snippets/s.md')).toBe(
      '[[archive/Paper 2|Paper 2]]'
    );
    expect(wired.sourceOf('IR/cards/c.md')).toBe('[[archive/Paper 2]]');
  });

  it("points the links of a moved row's live snippets and cards, and of a copied article, at where it went", async () => {
    const wired = wire({
      'IR/articles/A.md': '[[notes/Original]]',
      'notes/Original.md': null,
      'IR/snippets/child.md': '[[IR/articles/A|A]]',
      'IR/cards/child.md': '[A](IR/articles/A.md)',
      'IR/snippets/gone.md': '[[IR/articles/A]]',
      'IR/articles/Copy.md': '[Original](notes/Original.md)',
    });
    const article = insertRow(wired.repo, 'article', 'IR/articles/A.md');
    insertRow(wired.repo, 'snippet', 'IR/snippets/child.md', {
      parent: article,
    });
    insertRow(wired.repo, 'srs_card', 'IR/cards/child.md', { parent: article });
    insertRow(wired.repo, 'snippet', 'IR/snippets/gone.md', {
      parent: article,
      deleted: true,
    });
    insertRow(wired.repo, 'article', 'IR/articles/Copy.md');
    wired.move('IR/articles/A.md', 'IR/articles/B.md');
    wired.move('notes/Original.md', 'notes/Renamed.md');

    await expect(
      followSourceLinks(wired.manager, [
        {
          from: 'IR/articles/A.md',
          file: wired.files.get('IR/articles/B.md')!,
          id: article,
        },
        {
          from: 'notes/Original.md',
          file: wired.files.get('notes/Renamed.md')!,
        },
      ])
    ).resolves.toBe(4);

    expect(wired.sourceOf('IR/snippets/child.md')).toBe('[[IR/articles/B|B]]');
    expect(wired.sourceOf('IR/cards/child.md')).toBe('[B](IR/articles/B.md)');
    expect(wired.sourceOf('IR/articles/Copy.md')).toBe(
      '[Renamed](notes/Renamed.md)'
    );
    // The moved article's own link, too
    expect(wired.sourceOf('IR/articles/B.md')).toBe('[[notes/Renamed]]');
    expect(wired.sourceOf('IR/snippets/gone.md')).toBe('[[IR/articles/A]]');
  });

  it("leaves alone, without a write, a link that still resolves, a source that is no link, and another item's child", async () => {
    const wired = wire({
      'notes/Paper.md': null,
      'other/Paper.md': null,
      'IR/articles/X.md': null,
      // Obsidian updated it already
      'IR/snippets/updated.md': '[[archive/Paper]]',
      // Names the moved file's old path, but another file there takes it
      'IR/snippets/ambiguous.md': '[[Paper]]',
      // Taken from the moved file, but another item's now
      'IR/snippets/adopted.md': '[[notes/Paper]]',
      // Imported from the web
      'IR/articles/Web.md': 'https://example.com/notes/Paper',
    });
    insertRow(wired.repo, 'article', 'IR/articles/Web.md');
    insertRow(wired.repo, 'snippet', 'IR/snippets/updated.md');
    insertRow(wired.repo, 'snippet', 'IR/snippets/ambiguous.md');
    const other = insertRow(wired.repo, 'article', 'IR/articles/X.md');
    insertRow(wired.repo, 'snippet', 'IR/snippets/adopted.md', {
      parent: other,
    });
    wired.move('notes/Paper.md', 'archive/Paper.md');

    await expect(
      followSourceLinks(wired.manager, [
        { from: 'notes/Paper.md', file: wired.files.get('archive/Paper.md')! },
      ])
    ).resolves.toBe(0);

    expect(wired.processFrontMatter).not.toHaveBeenCalled();
    expect(wired.sourceOf('IR/snippets/adopted.md')).toBe('[[notes/Paper]]');
  });

  it('points a moved item note’s relative link, broken by its own move, back at the file it named', async () => {
    const wired = wire({
      'papers/P.pdf': null,
      'notes/P.md': null,
      // Written in `notes/`
      'notes/s.md': '[[../papers/P.pdf#page=2|P, page 2]]',
      'notes/c.md': '[P](./P.md)',
      'notes/t.md': '[[../papers/P.pdf]]',
      // With spaces around its path, as a hand-written link may have
      'notes/u.md': '[[ ../papers/P.pdf ]]',
    });
    const snippet = insertRow(wired.repo, 'snippet', 'notes/s.md', {
      parent: 'some-article',
    });
    const card = insertRow(wired.repo, 'srs_card', 'notes/c.md');
    const other = insertRow(wired.repo, 'srs_card', 'notes/t.md');
    const spaced = insertRow(wired.repo, 'srs_card', 'notes/u.md');
    wired.move('notes/s.md', 'archive/deep/s.md');
    // One batch: the card's source moved elsewhere at the same time
    wired.move('notes/c.md', 'archive/c.md');
    wired.move('notes/P.md', 'elsewhere/P.md');
    wired.move('notes/t.md', 'archive/t.md');
    wired.move('notes/u.md', 'archive/deep/u.md');

    await expect(
      followSourceLinks(wired.manager, [
        {
          from: 'notes/s.md',
          file: wired.files.get('archive/deep/s.md')!,
          id: snippet,
        },
        {
          from: 'notes/c.md',
          file: wired.files.get('archive/c.md')!,
          id: card,
        },
        { from: 'notes/P.md', file: wired.files.get('elsewhere/P.md')! },
        {
          from: 'notes/t.md',
          file: wired.files.get('archive/t.md')!,
          id: other,
        },
        {
          from: 'notes/u.md',
          file: wired.files.get('archive/deep/u.md')!,
          id: spaced,
        },
      ])
    ).resolves.toBe(3);

    expect(wired.sourceOf('archive/deep/s.md')).toBe(
      '[[papers/P.pdf#page=2|P, page 2]]'
    );
    expect(wired.sourceOf('archive/c.md')).toBe('[P](elsewhere/P.md)');
    expect(wired.sourceOf('archive/deep/u.md')).toBe('[[papers/P.pdf]]');
    // Still resolves where it went
    expect(wired.sourceOf('archive/t.md')).toBe('[[../papers/P.pdf]]');
  });

  it('rewrites exactly the live links, of the items it covers, that the move broke, as they were written (property-based)', async () => {
    /** Where each kind of link points, by path without `.md`. */
    const TARGETS = {
      // By its old full path: broken by the move
      old: 'src/M',
      // By its old name: broken too, unless a namesake takes it
      short: 'M',
      // Updated by Obsidian already
      updated: 'dst/N',
      other: 'other/O',
      missing: 'nowhere/X',
      // From the vault root: broken by the move, and by its whole path only
      rooted: '/src/M',
      rootedTail: '/M',
      // From the note's folder, `IR/`: broken by the move
      relative: '../src/M',
    } as const;
    const ALIASES = { none: null, name: 'M', own: 'my (own) words' } as const;
    const linkArb = fc.record({
      target: fc.constantFrom(
        ...(Object.keys(TARGETS) as (keyof typeof TARGETS)[])
      ),
      form: fc.constantFrom('wiki', 'markdown'),
      alias: fc.constantFrom(
        ...(Object.keys(ALIASES) as (keyof typeof ALIASES)[])
      ),
      subpath: fc.constantFrom('', '#Heading'),
    });
    type Link = { form: string; subpath: string };
    const written = (link: Link, path: string, alias: string | null) =>
      link.form === 'wiki'
        ? `[[${path}${link.subpath}${alias === null ? '' : `|${alias}`}]]`
        : `[${alias ?? ''}](${path}.md${link.subpath})`;
    const rowArb = fc.record({
      table: fc.constantFrom<Table>('article', 'snippet', 'srs_card'),
      parent: fc.constantFrom(null, 'moved-row', 'other-row'),
      deleted: fc.boolean(),
      link: fc.option(linkArb, { nil: null }),
      ownId: fc.boolean(),
    });

    await fc.assert(
      fc.asyncProperty(
        fc.array(rowArb, { maxLength: 8 }),
        fc.boolean(),
        fc.boolean(),
        async (rows, movedIsRow, namesake) => {
          const notes: Record<string, string | null> = {
            'src/M.md': null,
            'other/O.md': null,
            'other/Z.md': null,
          };
          if (namesake) notes['twin/M.md'] = null;
          const wired = wire(notes);
          const sources = rows.map(({ link }) =>
            link
              ? written(link, TARGETS[link.target], ALIASES[link.alias])
              : undefined
          );
          const paths = rows.map((row, i) => {
            const path = `IR/${i}.md`;
            const fm: Record<string, unknown> = {
              'ir-id': row.ownId ? idOf(path) : 'someone-else',
            };
            if (sources[i] !== undefined) fm.source = sources[i];
            wired.add(path, fm);
            insertRow(wired.repo, row.table, path, {
              parent: row.table === 'article' ? null : row.parent,
              deleted: row.deleted,
            });
            return path;
          });
          const file = wired.move('src/M.md', 'dst/N.md');
          // Another file of the same batch, which no link names
          const other = wired.move('other/Z.md', 'elsewhere/Z.md');

          const rewritten = await followSourceLinks(wired.manager, [
            {
              from: 'src/M.md',
              file,
              ...(movedIsRow ? { id: 'moved-row' } : {}),
            },
            { from: 'other/Z.md', file: other },
          ]);

          const expected = rows.map(
            ({ table, parent, deleted, ownId, link }) => {
              if (deleted || !ownId || !link) return null;
              // The moved row's own child, which a namesake can't take
              const child =
                table !== 'article' && parent === 'moved-row' && movedIsRow;
              const covered = table === 'article' || parent === null;
              const broken =
                ['old', 'rooted', 'relative'].includes(link.target) ||
                (link.target === 'short' && (!namesake || child));
              if (!broken || !(covered || child)) return null;
              const alias = ALIASES[link.alias];
              return written(link, 'dst/N', alias === 'M' ? 'N' : alias);
            }
          );
          const count = expected.filter((link) => link !== null).length;
          expect(rewritten).toBe(count);
          rows.forEach((_, i) => {
            expect(wired.sourceOf(paths[i])).toBe(expected[i] ?? sources[i]);
          });
          expect(wired.processFrontMatter).toHaveBeenCalledTimes(count);
        }
      )
    );
  });

  it('follows a file that moved on again to where it is now, and none that is gone', async () => {
    const wired = wire({
      'a.pdf': null,
      'gone.pdf': null,
      'IR/cards/c.md': '[[a.pdf#page=1|a, page 1]]',
      'IR/cards/d.md': '[[gone.pdf]]',
      'papers/P.pdf': null,
      // Written in `notes/`
      'notes/e.md': '[[../papers/P.pdf]]',
    });
    insertRow(wired.repo, 'srs_card', 'IR/cards/c.md');
    insertRow(wired.repo, 'srs_card', 'IR/cards/d.md');
    const card = insertRow(wired.repo, 'srs_card', 'notes/e.md');
    const file = wired.move('a.pdf', 'b.pdf');
    wired.move('b.pdf', 'c.pdf');
    const gone = wired.move('gone.pdf', 'went.pdf');
    wired.files.delete('went.pdf');
    const note = wired.move('notes/e.md', 'x/y/e.md');
    wired.move('x/y/e.md', 'z/w/e.md');

    await expect(
      followSourceLinks(wired.manager, [
        { from: 'a.pdf', file },
        { from: 'b.pdf', file },
        { from: 'gone.pdf', file: gone },
        { from: 'notes/e.md', file: note, id: card },
        { from: 'x/y/e.md', file: note, id: card },
      ])
    ).resolves.toBe(2);

    // Read from where it was written, not from where it passed through
    expect(wired.sourceOf('z/w/e.md')).toBe('[[papers/P.pdf]]');

    expect(wired.sourceOf('IR/cards/c.md')).toBe('[[c.pdf#page=1|c, page 1]]');
    expect(wired.sourceOf('IR/cards/d.md')).toBe('[[gone.pdf]]');
  });

  it("follows a moved row's children by its id, though a namesake of its old path now takes their links", async () => {
    const wired = wire({
      'a/Doc.pdf': null,
      'b/Doc.pdf': null,
      'IR/snippets/s.md': '[[Doc.pdf#page=2|Doc, page 2]]',
      // Not its child: left to whichever file its link names
      'IR/snippets/t.md': '[[Doc.pdf#page=2|Doc, page 2]]',
      'c/Paper.pdf': null,
      // Names its parent's old path by a name that still finds it
      'IR/snippets/u.md': '[[Paper.pdf]]',
    });
    insertRow(wired.repo, 'snippet', 'IR/snippets/s.md', { parent: 'pdf' });
    insertRow(wired.repo, 'snippet', 'IR/snippets/t.md');
    insertRow(wired.repo, 'snippet', 'IR/snippets/u.md', { parent: 'paper' });
    const file = wired.move('a/Doc.pdf', 'a/Doc2.pdf');
    const paper = wired.move('c/Paper.pdf', 'd/Paper.pdf');

    await expect(
      followSourceLinks(wired.manager, [
        { from: 'a/Doc.pdf', file, id: 'pdf' },
        { from: 'c/Paper.pdf', file: paper, id: 'paper' },
      ])
    ).resolves.toBe(1);

    expect(wired.processFrontMatter).toHaveBeenCalledOnce();
    expect(wired.sourceOf('IR/snippets/u.md')).toBe('[[Paper.pdf]]');

    expect(wired.sourceOf('IR/snippets/s.md')).toBe(
      '[[a/Doc2.pdf#page=2|Doc2, page 2]]'
    );
    expect(wired.sourceOf('IR/snippets/t.md')).toBe(
      '[[Doc.pdf#page=2|Doc, page 2]]'
    );
  });

  it("points a moved row's child at its own parent, of moved files that share a name", async () => {
    const wired = wire({
      'Course/W2/slides.pdf': null,
      'Course/W1/slides.pdf': null,
      'Notes/Other.md': null,
      // Written while the name was unique: the second week's has it now
      'IR/s.md': '[[slides.pdf]]',
      // Resolves to a file no move names: right as it is, if not in its form
      'IR/t.md': '[[Other]]',
    });
    insertRow(wired.repo, 'snippet', 'IR/s.md', { parent: 'week-1' });
    insertRow(wired.repo, 'snippet', 'IR/t.md', { parent: 'week-1' });
    // The second week's moves first
    const week2 = wired.move('Course/W2/slides.pdf', 'Class/W2/slides.pdf');
    const week1 = wired.move('Course/W1/slides.pdf', 'Class/W1/slides.pdf');

    await expect(
      followSourceLinks(wired.manager, [
        { from: 'Course/W2/slides.pdf', file: week2, id: 'week-2' },
        { from: 'Course/W1/slides.pdf', file: week1, id: 'week-1' },
      ])
    ).resolves.toBe(1);

    expect(wired.sourceOf('IR/s.md')).toBe('[[Class/W1/slides.pdf]]');
    expect(wired.sourceOf('IR/t.md')).toBe('[[Other]]');
    expect(wired.processFrontMatter).toHaveBeenCalledOnce();
  });

  it("leaves a moved row's child alone when its link resolves to a file other than its parent, though another move names it", async () => {
    const wired = wire({
      'inbox/P.md': null,
      'inbox/Notes.md': null,
      'archive/Notes.md': null,
      // Edited by hand: finds the archive's, not the inbox's
      'IR/s.md': '[[Notes]]',
    });
    insertRow(wired.repo, 'snippet', 'IR/s.md', { parent: 'p' });
    const parent = wired.move('inbox/P.md', 'done/P.md');
    const notes = wired.move('inbox/Notes.md', 'done/Notes.md');

    await expect(
      followSourceLinks(wired.manager, [
        { from: 'inbox/P.md', file: parent, id: 'p' },
        { from: 'inbox/Notes.md', file: notes },
      ])
    ).resolves.toBe(0);

    expect(wired.processFrontMatter).not.toHaveBeenCalled();
    expect(wired.sourceOf('IR/s.md')).toBe('[[Notes]]');
  });

  it("leaves a moved row's child alone when its own move leaves its link resolving to a file other than its parent, though it named another from where it was", async () => {
    const wired = wire({
      'inbox/P.md': null,
      'notes/O.md': null,
      'x/O.md': null,
      // Written in `notes/`, where it found `notes/O.md`
      'notes/c.md': '[[./O]]',
    });
    insertRow(wired.repo, 'srs_card', 'notes/c.md', { parent: 'p' });
    const parent = wired.move('inbox/P.md', 'done/P.md');
    const note = wired.move('notes/c.md', 'x/c.md');

    await expect(
      followSourceLinks(wired.manager, [
        { from: 'inbox/P.md', file: parent, id: 'p' },
        { from: 'notes/c.md', file: note, id: idOf('notes/c.md') },
      ])
    ).resolves.toBe(0);

    expect(wired.processFrontMatter).not.toHaveBeenCalled();
    expect(wired.sourceOf('x/c.md')).toBe('[[./O]]');
  });

  it('finds the children of however many moved rows, a parameter-limited chunk of them at a time', async () => {
    const count = MAX_SQL_QUERY_PARAMS + 1;
    const wired = wire({});
    const moves = [];
    for (let i = 0; i < count; i++) {
      wired.add(`a/${i}.pdf`);
      moves.push({
        from: `a/${i}.pdf`,
        file: wired.move(`a/${i}.pdf`, `b/${i}.pdf`),
        id: `row-${i}`,
      });
    }
    // Children of the first and the last
    for (const i of [0, count - 1]) {
      wired.add(`IR/${i}.md`, {
        'ir-id': idOf(`IR/${i}.md`),
        source: `[[a/${i}.pdf]]`,
      });
      insertRow(wired.repo, 'srs_card', `IR/${i}.md`, { parent: `row-${i}` });
    }
    const query = vi.spyOn(wired.repo, 'query');

    await expect(followSourceLinks(wired.manager, moves)).resolves.toBe(2);

    expect(wired.sourceOf('IR/0.md')).toBe('[[b/0.pdf]]');
    expect(wired.sourceOf(`IR/${count - 1}.md`)).toBe(`[[b/${count - 1}.pdf]]`);
    for (const [, params = []] of query.mock.calls) {
      expect(params.length).toBeLessThanOrEqual(MAX_SQL_QUERY_PARAMS);
    }
  });

  it('reads the database once for any number of moves that are no item', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}$/), { minLength: 1 }),
        async (names) => {
          const wired = wire({ 'IR/snippets/s.md': '[[elsewhere]]' });
          insertRow(wired.repo, 'snippet', 'IR/snippets/s.md');
          const query = vi.spyOn(wired.repo, 'query');

          for (const name of names) wired.add(`${name}.md`);
          const moves = names.map((name) => ({
            from: `${name}.md`,
            file: wired.move(`${name}.md`, `new/${name}.md`),
          }));

          await followSourceLinks(wired.manager, moves);

          expect(query).toHaveBeenCalledOnce();
        }
      )
    );
  });

  it('reads the notes only once the metadata cache has settled', async () => {
    const wired = wire({
      'notes/Paper.md': null,
      'IR/snippets/s.md': '[[notes/Paper]]',
    });
    insertRow(wired.repo, 'snippet', 'IR/snippets/s.md');
    wired.move('notes/Paper.md', 'notes/Moved.md');
    let settle!: () => void;
    Object.assign(wired.app.metadataCache, {
      onCleanCache: (callback: () => void) => (settle = callback),
    });

    const following = followSourceLinks(wired.manager, [
      { from: 'notes/Paper.md', file: wired.files.get('notes/Moved.md')! },
    ]);
    await new Promise((done) => setTimeout(done, 0));
    expect(wired.app.metadataCache.getFileCache).not.toHaveBeenCalled();

    settle();
    await expect(following).resolves.toBe(1);
    expect(wired.sourceOf('IR/snippets/s.md')).toBe('[[notes/Moved]]');
  });
});
