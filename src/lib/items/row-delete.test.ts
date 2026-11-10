import { holdsItems } from '#/lib/crash-leftovers';
import type { ItemTable } from '#/lib/moved-note-scan';
import { SYNCED_TABLES } from '#/lib/repository/row-stamps';
import { TestRepository } from '#/test/item-vault';
import fc from 'fast-check';
import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  deleteRowStatements,
  NOT_PURGED,
  PURGED_REFERENCE_PREFIX,
  purgedReference,
  REVIEW_LOG_OF,
  tombstoneRowStatements,
} from './row-delete';

// #region HELPERS

const tableArb = fc.constantFrom<ItemTable>('article', 'snippet', 'srs_card');

/**
 * Add a `table` row `id` at `reference`, under `parent` in the tree, and
 * taken from `context`, its parent unless said otherwise.
 */
function insertItem(
  repo: TestRepository,
  table: ItemTable,
  id: string,
  {
    reference = `${table}/${id}.md`,
    parent = null,
    context = parent,
  }: {
    reference?: string;
    parent?: string | null;
    context?: string | null;
  } = {}
) {
  if (table === 'article') {
    repo.mutate(
      `INSERT INTO article (id, reference, due, interval, priority) VALUES ($1, $2, 0, 1, 30)`,
      [id, reference]
    );
  } else if (table === 'snippet') {
    repo.mutate(
      `INSERT INTO snippet (id, reference, parent, context, due, interval, priority) VALUES ($1, $2, $3, $4, 0, 1, 30)`,
      [id, reference, parent, context]
    );
  } else {
    repo.mutate(
      `INSERT INTO srs_card (id, reference, parent, context, created_at, due, stability, difficulty, elapsed_days, scheduled_days, state) VALUES ($1, $2, $3, $4, 0, 0, 0, 0, 0, 0, 0)`,
      [id, reference, parent, context]
    );
  }
}

/** Add a review of the `table` row `id`. */
function insertReview(
  repo: TestRepository,
  table: ItemTable,
  id: string,
  reviewId: string
) {
  if (table === 'srs_card') {
    repo.mutate(
      `INSERT INTO srs_card_review (id, card_id, due, review, stability, difficulty, elapsed_days, last_elapsed_days, scheduled_days, rating, state) VALUES ($1, $2, 0, 0, 0, 0, 0, 0, 0, 1, 0)`,
      [reviewId, id]
    );
    return;
  }
  const [log, column] = REVIEW_LOG_OF[table];
  repo.mutate(
    `INSERT INTO ${log} (id, ${column}, review_time) VALUES ($1, $2, 0)`,
    [reviewId, id]
  );
}

function run(
  repo: TestRepository,
  statements: { query: string; params?: unknown[] }[]
) {
  for (const { query, params } of statements) {
    repo.mutate(query, params as never);
  }
}

/** The source folder, scanned for hard deletes; nothing outside it is read. */
const SRC = resolve(__dirname, '../..');

/** `path` relative to {@link SRC}, with forward slashes on every platform. */
function fromSrc(path: string): string {
  return relative(SRC, path).split(sep).join('/');
}

/**
 * Where a hard delete of a synced row may still be written: migrations,
 * tests, and retention's pruning of rows past the sync horizon (0173).
 */
function mayHardDelete(path: string): boolean {
  const rel = fromSrc(path);
  return (
    rel === 'db/migrations.ts' ||
    rel === 'lib/repository/retention.ts' ||
    rel.startsWith('test/') ||
    /\.test\.[cm]?[jt]sx?$/.test(rel)
  );
}

/** Every source file under `dir`, at any depth. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.([cm]?[jt]sx?|sql)$/.test(entry.name) ? [path] : [];
  });
}

/**
 * `DELETE FROM` a synced table, however it is spaced, cased or quoted, or a
 * table named at run time (`${table}`), which could be any of them.
 */
const HARD_DELETE = new RegExp(
  String.raw`\bDELETE\s+FROM\s+(?:(?:main|temp)\s*\.\s*)?` +
    String.raw`(?:\$\{|["\x60\[]?(?:${SYNCED_TABLES.join('|')})(?![\w$]))`,
  'i'
);

/** Each hard delete of a synced table in `text`, as `line: statement`. */
function hardDeletesIn(text: string): string[] {
  return [...text.matchAll(new RegExp(HARD_DELETE, 'gi'))].map(
    (match) =>
      `${text.slice(0, match.index).split('\n').length}: ${match[0].replace(/\s+/g, ' ')}`
  );
}

/** One row of a tree of items: its id, table, and the two links up. */
interface TreeNode {
  id: string;
  table: ItemTable;
  parent: string | null;
  context: string | null;
}

/** A tree of items, and which of its rows are deleted, for now or for good. */
interface Tree {
  nodes: TreeNode[];
  trashed: Set<string>;
  purged: Set<string>;
}

/**
 * A tree of items at least three levels deep (an article, a snippet taken
 * from it, one taken from that, and a snippet or card from that), with more
 * rows hung anywhere: under no parent, an article or snippet of the tree, or
 * an id no row holds. Each row is taken from its parent, or from nothing
 * (its context erased by an earlier drop). Some rows are deleted for now
 * (trashed, which keeps their path), or for good with nothing else done, as
 * a drop did before it let go of what was taken from the row.
 */
const treeArb: fc.Arbitrary<Tree> = fc
  .record({
    leaf: fc.constantFrom<ItemTable>('snippet', 'srs_card'),
    articles: fc.integer({ min: 1, max: 2 }),
    extra: fc.array(
      fc.record({
        table: fc.constantFrom<ItemTable>('snippet', 'srs_card'),
        under: fc.oneof(fc.constantFrom('none', 'gone'), fc.nat()),
        takenFrom: fc.boolean(),
      }),
      { maxLength: 8 }
    ),
    trashed: fc.array(fc.nat(), { maxLength: 2 }),
    purged: fc.array(fc.nat(), { maxLength: 2 }),
  })
  .map(({ leaf, articles, extra, trashed, purged }) => {
    const nodes: TreeNode[] = [];
    for (let i = 0; i < articles; i++) {
      nodes.push({
        id: `a${i}`,
        table: 'article',
        parent: null,
        context: null,
      });
    }
    const spine: [string, ItemTable][] = [
      ['s0', 'snippet'],
      ['s1', 'snippet'],
      ['leaf', leaf],
    ];
    for (const [id, table] of spine) {
      const parent = nodes[nodes.length - 1].id;
      nodes.push({ id, table, parent, context: parent });
    }
    extra.forEach(({ table, under, takenFrom }, i) => {
      // Cards are never taken from, so no row hangs under one
      const parents = nodes.filter((node) => node.table !== 'srs_card');
      const parent =
        under === 'none'
          ? null
          : under === 'gone'
            ? 'gone'
            : parents[under % parents.length].id;
      nodes.push({
        id: `x${i}`,
        table,
        parent,
        context: takenFrom ? parent : null,
      });
    });
    const pick = (picks: number[]) =>
      new Set(picks.map((n) => nodes[n % nodes.length].id));
    return { nodes, trashed: pick(trashed), purged: pick(purged) };
  });

/** Put `tree` into `repo`. */
function plantTree(repo: TestRepository, { nodes, trashed, purged }: Tree) {
  for (const { id, table, parent, context } of nodes) {
    insertItem(repo, table, id, { parent, context });
  }
  for (const { id, table } of nodes) {
    if (trashed.has(id)) {
      repo.mutate(`UPDATE ${table} SET deleted = TRUE WHERE id = $1`, [id]);
    }
    if (purged.has(id)) run(repo, tombstoneRowStatements(table, id));
  }
}

/** Every snippet's and card's links up, by id, tombstones included. */
function links(
  repo: TestRepository
): Record<string, { parent: unknown; context: unknown }> {
  return Object.fromEntries(
    [...repo.storedRows('snippet'), ...repo.storedRows('srs_card')].map(
      ({ id, parent, context }) => [String(id), { parent, context }]
    )
  );
}

/** Where `id` of `repo` is: whether it is deleted, and its reference. */
function whereIs(repo: TestRepository, table: ItemTable, id: string) {
  return repo
    .storedRows(table, ` WHERE id = '${id}'`)
    .map(({ deleted, reference }) => [deleted, reference]);
}

/** The links of `tree` once `target` is dropped from it, as a drop leaves them. */
function linksAfterDrop(
  before: ReturnType<typeof links>,
  tree: Tree,
  target: TreeNode
): ReturnType<typeof links> {
  // Where its children go: the item above it, while that is one a row can
  // sit under, an article or snippet not deleted for good
  const above = tree.nodes.find(
    (node) =>
      node.id === target.parent &&
      node.table !== 'srs_card' &&
      !tree.purged.has(node.id)
  );
  return Object.fromEntries(
    Object.entries(before).map(([id, { parent, context }]) => [
      id,
      {
        parent: parent === target.id ? (above?.id ?? null) : parent,
        context: context === target.id ? null : context,
      },
    ])
  );
}

// #endregion

describe('tombstoneRowStatements', () => {
  it('property: flags the row, its reviews and its rebind deleted, letting go of its path, and leaves every other row be', async () => {
    await fc.assert(
      fc.asyncProperty(
        tableArb,
        fc.nat({ max: 3 }),
        fc.nat({ max: 3 }),
        async (table, reviews, otherReviews) => {
          const repo = await TestRepository.create();
          insertItem(repo, table, 'target');
          insertItem(repo, table, 'other');
          for (let n = 0; n < reviews; n++)
            insertReview(repo, table, 'target', `t${n}`);
          for (let n = 0; n < otherReviews; n++)
            insertReview(repo, table, 'other', `o${n}`);
          if (table === 'article') {
            repo.mutate(
              `INSERT INTO rebind (article_id, old_reference, new_reference, rebound_at) VALUES ('target', 'a', 'b', 0)`
            );
          }
          const [log, column] = REVIEW_LOG_OF[table];
          const others = repo.storedRows(table, ` WHERE id = 'other'`);
          const otherLogs = repo.storedRows(log, ` WHERE ${column} = 'other'`);

          run(repo, tombstoneRowStatements(table, 'target'));

          expect(
            repo
              .storedRows(table, ` WHERE id = 'target'`)
              .map(({ deleted, reference }) => [deleted, reference])
          ).toEqual([[1, purgedReference('target')]]);
          expect(
            repo
              .storedRows(log, ` WHERE ${column} = 'target'`)
              .map(({ deleted }) => deleted)
          ).toEqual(Array.from({ length: reviews }, () => 1));
          expect(
            repo.storedRows('rebind').map(({ deleted }) => deleted)
          ).toEqual(table === 'article' ? [1] : []);
          expect(repo.storedRows(table, ` WHERE id = 'other'`)).toEqual(others);
          expect(repo.storedRows(log, ` WHERE ${column} = 'other'`)).toEqual(
            otherLogs
          );
        }
      ),
      { numRuns: 30 }
    );
  });

  it('frees the path for a new item there, which the tombstone does not hold', async () => {
    const repo = await TestRepository.create();
    insertItem(repo, 'article', 'old', { reference: 'n/a.md' });

    run(repo, tombstoneRowStatements('article', 'old'));
    insertItem(repo, 'article', 'new', { reference: 'n/a.md' });

    expect(repo.rows('article').map(({ id }) => id)).toEqual(['new']);
  });

  it('changes nothing run again on a row already deleted for good', async () => {
    const repo = await TestRepository.create();
    insertItem(repo, 'snippet', 'target');
    insertReview(repo, 'snippet', 'target', 'r');
    run(repo, tombstoneRowStatements('snippet', 'target'));
    const stored = [
      repo.storedRows('snippet'),
      repo.storedRows('snippet_review'),
    ];

    for (const { query, params } of tombstoneRowStatements(
      'snippet',
      'target'
    )) {
      repo.mutate(query, params as never);
      expect(repo.db!.getRowsModified()).toBe(0);
    }
    expect([
      repo.storedRows('snippet'),
      repo.storedRows('snippet_review'),
    ]).toEqual(stored);
  });

  it('flags the row last, so a run stopping short leaves it live', () => {
    for (const table of ['article', 'snippet', 'srs_card'] as const) {
      const statements = tombstoneRowStatements(table, 'x');
      expect(statements.at(-1)!.query).toMatch(
        new RegExp(`^UPDATE ${table} SET deleted = TRUE`)
      );
    }
  });
});

describe('deleteRowStatements', () => {
  it('property: moves what was under the row up to its parent, or to the top, erasing what was taken from it, and changes no other link', async () => {
    await fc.assert(
      fc.asyncProperty(treeArb, fc.nat(), async (tree, pick) => {
        const repo = await TestRepository.create();
        plantTree(repo, tree);
        const target = tree.nodes[pick % tree.nodes.length];
        const before = links(repo);

        run(repo, deleteRowStatements(target.table, target.id));

        expect(links(repo)).toEqual(linksAfterDrop(before, tree, target));
      }),
      { numRuns: 200 }
    );
  });

  it('property: leaves no row under the row it drops', async () => {
    await fc.assert(
      fc.asyncProperty(treeArb, fc.nat(), async (tree, pick) => {
        const repo = await TestRepository.create();
        plantTree(repo, tree);
        const target = tree.nodes[pick % tree.nodes.length];

        run(repo, deleteRowStatements(target.table, target.id));

        expect(
          Object.values(links(repo)).filter(
            ({ parent, context }) =>
              parent === target.id || context === target.id
          )
        ).toEqual([]);
      }),
      { numRuns: 100 }
    );
  });

  it('property: tombstones the row last, after letting go of what was taken from it, and keeps its own links', async () => {
    await fc.assert(
      fc.asyncProperty(treeArb, fc.nat(), async (tree, pick) => {
        const target = tree.nodes[pick % tree.nodes.length];
        const statements = deleteRowStatements(target.table, target.id);
        const tombstone = tombstoneRowStatements(target.table, target.id);

        expect(statements.slice(-tombstone.length)).toEqual(tombstone);
        expect(
          statements
            .slice(0, -tombstone.length)
            .every(({ query }) => /^UPDATE (snippet|srs_card) SET /.test(query))
        ).toBe(true);

        // Its tombstone still says where it sat in the tree
        const repo = await TestRepository.create();
        plantTree(repo, tree);
        const own = links(repo)[target.id];
        run(repo, statements);
        expect(links(repo)[target.id]).toEqual(own);
      }),
      { numRuns: 50 }
    );
  });

  it('property: run again after stopping short anywhere, ends where one run does', async () => {
    await fc.assert(
      fc.asyncProperty(treeArb, fc.nat(), fc.nat(), async (tree, pick, cut) => {
        const target = tree.nodes[pick % tree.nodes.length];
        const statements = deleteRowStatements(target.table, target.id);
        const once = await TestRepository.create();
        plantTree(once, tree);
        run(once, statements);
        const stopped = await TestRepository.create();
        plantTree(stopped, tree);

        run(stopped, statements.slice(0, cut % (statements.length + 1)));
        run(stopped, statements);

        expect(links(stopped)).toEqual(links(once));
        expect(whereIs(stopped, target.table, target.id)).toEqual(
          whereIs(once, target.table, target.id)
        );
      }),
      { numRuns: 50 }
    );
  });
});

describe('NOT_PURGED', () => {
  it('passes a live row and one deleted for now, never one deleted for good', async () => {
    const repo = await TestRepository.create();
    insertItem(repo, 'article', 'live');
    insertItem(repo, 'article', 'trashed');
    insertItem(repo, 'article', 'purged');
    repo.mutate(`UPDATE article SET deleted = TRUE WHERE id = 'trashed'`);
    run(repo, tombstoneRowStatements('article', 'purged'));

    expect(
      repo
        .query(`SELECT id FROM article WHERE ${NOT_PURGED} ORDER BY id`)
        .map(({ id }) => id)
    ).toEqual(['live', 'trashed']);
  });

  it('names no vault path', () => {
    expect(PURGED_REFERENCE_PREFIX.startsWith('/')).toBe(true);
    expect(purgedReference('x')).toBe(`${PURGED_REFERENCE_PREFIX}x`);
  });
});

describe('holdsItems', () => {
  it('counts no item deleted for good', async () => {
    const repo = await TestRepository.create();
    insertItem(repo, 'srs_card', 'card');
    expect(await holdsItems(repo)).toBe(true);

    run(repo, tombstoneRowStatements('srs_card', 'card'));

    expect(await holdsItems(repo)).toBe(false);
  });

  it('rejects, rather than answering none, when a table cannot be read', async () => {
    const repo = await TestRepository.create();
    vi.spyOn(repo, 'query').mockImplementation((_sql, _params, options) => {
      if (options?.throwOnError) throw new Error('unreadable');
      return [];
    });

    await expect(holdsItems(repo)).rejects.toThrow('unreadable');
    vi.restoreAllMocks();
  });
});

describe('hard deletes of synced rows', () => {
  it('appear nowhere in the source but migrations and tests, which tombstone instead', () => {
    const found = sourceFiles(SRC)
      .filter((path) => !mayHardDelete(path))
      .flatMap((path) =>
        hardDeletesIn(readFileSync(path, 'utf8')).map(
          (hit) => `${fromSrc(path)}:${hit}`
        )
      );

    expect(found).toEqual([]);
  });

  it('property: are found however the statement is spaced, cased, quoted or qualified', () => {
    const caseArb = (word: string) =>
      fc
        .array(fc.boolean(), { minLength: word.length, maxLength: word.length })
        .map((upper) =>
          [...word]
            .map((c, i) => (upper[i] ? c.toUpperCase() : c.toLowerCase()))
            .join('')
        );
    const spaceArb = fc
      .array(fc.constantFrom(' ', '\t', '\n', '\r\n'), {
        minLength: 1,
        maxLength: 4,
      })
      .map((parts) => parts.join(''));
    fc.assert(
      fc.property(
        caseArb('delete'),
        spaceArb,
        caseArb('from'),
        spaceArb,
        fc.constantFrom('', 'main.', 'temp.', 'main . '),
        fc.constantFrom(...SYNCED_TABLES, '${table}'),
        fc.constantFrom(['', ''], ['"', '"'], ['`', '`'], ['[', ']']),
        fc.constantFrom('', ' WHERE id = $1', ';', '\n'),
        (del, gap1, from, gap2, schema, table, [open, close], tail) => {
          const quoted = table.startsWith('$') ? table : open + table + close;
          const sql = `x = '${del}${gap1}${from}${gap2}${schema}${quoted}${tail}'`;
          expect(hardDeletesIn(sql)).toHaveLength(1);
        }
      )
    );
  });

  it('property: are not taken for a delete from any other table, or for other words', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          ...SYNCED_TABLES.map((table) => `${table}_old`),
          ...SYNCED_TABLES.map((table) => `${table}$`),
          'unrelated',
          'sqlite_sequence'
        ),
        fc.constantFrom('DELETE FROM ', 'delete\n  from '),
        (table, verb) => {
          expect(hardDeletesIn(`${verb}${table} WHERE 1`)).toEqual([]);
        }
      )
    );
  });

  it('are not taken for a longer word ending or starting the same', () => {
    expect(hardDeletesIn(`UNDELETE FROM ${SYNCED_TABLES[0]}`)).toEqual([]);
    expect(hardDeletesIn(`DELETEFROM ${SYNCED_TABLES[0]}`)).toEqual([]);
  });

  it('reports each hit with its line', () => {
    expect(
      hardDeletesIn('a\nb DELETE\n  FROM rebind c\nDELETE FROM snippet')
    ).toEqual(['2: DELETE FROM rebind', '4: DELETE FROM snippet']);
  });

  it('may be written in migrations, retention and tests alone', () => {
    expect(
      [
        'db/migrations.ts',
        'lib/repository/retention.ts',
        'lib/repository/row-merge.ts',
        'db/migration-helpers.ts',
        'test/item-vault.ts',
        'lib/foo.test.ts',
        'lib/foo.test.tsx',
        'lib/foo.ts',
        'lib/test-utils.ts',
      ].map((rel) => mayHardDelete(join(SRC, rel)))
    ).toEqual([true, true, false, false, true, true, true, false, false]);
  });

  it('are looked for in every source file of every folder, nothing else', () => {
    const files = sourceFiles(SRC).map(fromSrc);
    expect(files).toEqual(
      expect.arrayContaining([
        'main.ts',
        'db/schema.sql',
        'lib/items/row-delete.ts',
      ])
    );
    expect(files.some((file) => file.includes('node_modules'))).toBe(false);
    expect(files.every((file) => /\.([cm]?[jt]sx?|sql)$/.test(file))).toBe(
      true
    );
  });
});
