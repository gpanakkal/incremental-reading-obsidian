import type { ItemTable } from '#/lib/moved-note-scan';
import { TestRepository } from '#/test/item-vault';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { childrenOf, type ItemChild } from './item-children';
import {
  deleteRowStatements,
  NOT_PURGED,
  tombstoneRowStatements,
} from './row-delete';

// #region HELPERS

interface Node {
  id: string;
  table: ItemTable;
  /** The id of the row it sits under, an id no row holds, or none. */
  parent: string | null;
  /** The id of the row it was taken from, an id no row holds, or none. */
  context: string | null;
}

/** Items in any shape a database can hold, and which are deleted, for now or for good. */
interface Forest {
  nodes: Node[];
  trashed: Set<string>;
  purged: Set<string>;
}

/** Where `node`'s note is: what a row taking `node` as its context highlights in. */
const referenceOf = (node: Pick<Node, 'id' | 'table'>) =>
  `${node.table}/${node.id}.md`;

/**
 * A link of a row: none, an id no row holds, or one of the rows before it, of
 * any table, cards included (merged data may hold what this device never
 * writes).
 */
const linkArb = fc.oneof(
  fc.constant<'none'>('none'),
  fc.constant<'gone'>('gone'),
  fc.nat()
);

/**
 * Up to a dozen rows of the three tables, each under a row made before it
 * (so the links never loop, as no write ever makes them), or none, or a row
 * that is gone; taken from its parent, another row, or nothing. Some deleted
 * for now (trashed, keeping their path), some for good.
 */
const forestArb: fc.Arbitrary<Forest> = fc
  .record({
    rows: fc.array(
      fc.record({
        table: fc.constantFrom<ItemTable>('article', 'snippet', 'srs_card'),
        parent: linkArb,
        context: fc.oneof(fc.constant<'parent'>('parent'), linkArb),
      }),
      { minLength: 1, maxLength: 12 }
    ),
    trashed: fc.array(fc.nat(), { maxLength: 4 }),
    purged: fc.array(fc.nat(), { maxLength: 3 }),
  })
  .map(({ rows, trashed, purged }) => {
    const nodes: Node[] = [];
    const resolve = (link: 'none' | 'gone' | number, i: number) =>
      link === 'none'
        ? null
        : link === 'gone'
          ? 'gone'
          : i === 0
            ? null
            : nodes[link % i].id;
    rows.forEach(({ table, parent, context }, i) => {
      const above = table === 'article' ? null : resolve(parent, i);
      nodes.push({
        id: `${table[0]}${i}`,
        table,
        parent: above,
        context:
          table === 'article'
            ? null
            : context === 'parent'
              ? above
              : resolve(context, i),
      });
    });
    const pick = (picks: number[]) =>
      new Set(picks.map((n) => nodes[n % nodes.length].id));
    return { nodes, trashed: pick(trashed), purged: pick(purged) };
  });

/** A forest, and the ids of some of its rows, or of none, to ask about. */
const askedArb = forestArb.chain((forest) =>
  fc.record({
    forest: fc.constant(forest),
    roots: fc.uniqueArray(
      fc.oneof(
        fc.constantFrom(...forest.nodes.map(({ id }) => id)),
        fc.constant('gone')
      ),
      { maxLength: 4 }
    ),
  })
);

function insert(repo: TestRepository, { id, table, parent, context }: Node) {
  const reference = referenceOf({ id, table });
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

async function plant({ nodes, trashed, purged }: Forest) {
  const repo = await TestRepository.create();
  for (const node of nodes) insert(repo, node);
  for (const { id, table } of nodes) {
    if (trashed.has(id)) {
      repo.mutate(`UPDATE ${table} SET deleted = TRUE WHERE id = $1`, [id]);
    }
    if (purged.has(id)) {
      for (const { query, params } of tombstoneRowStatements(table, id)) {
        repo.mutate(query, params);
      }
    }
  }
  return repo;
}

/**
 * What hangs under `roots` in `forest`, worked out row by row: every snippet
 * and card not deleted for good whose chain of parents, through rows not
 * deleted for good, reaches one of them; the roots themselves left out. With
 * `liveRoots`, only what hangs under the roots that are rows neither trashed
 * nor deleted for good.
 */
function expectedChildren(
  { nodes, trashed, purged }: Forest,
  roots: readonly string[],
  { liveRoots = false }: { liveRoots?: boolean } = {}
): ItemChild[] {
  const linked = nodes.filter(
    ({ table, id }) => table !== 'article' && !purged.has(id)
  );
  const reached = new Set<string>();
  let frontier = new Set(
    liveRoots
      ? roots.filter(
          (root) =>
            nodes.some(({ id }) => id === root) &&
            !trashed.has(root) &&
            !purged.has(root)
        )
      : roots
  );
  while (frontier.size > 0) {
    const next = new Set<string>();
    for (const node of linked) {
      if (node.parent === null || !frontier.has(node.parent)) continue;
      if (reached.has(node.id)) continue;
      reached.add(node.id);
      next.add(node.id);
    }
    frontier = next;
  }
  return linked
    .filter(({ id }) => reached.has(id) && !roots.includes(id))
    .map(({ id, table, context }) => {
      const from = nodes.find(
        (node) =>
          node.id === context &&
          node.table !== 'srs_card' &&
          !purged.has(node.id)
      );
      return {
        table: table as ItemChild['table'],
        id,
        trashed: trashed.has(id),
        reference: referenceOf({ id, table }),
        highlightedIn: from ? referenceOf(from) : null,
      };
    });
}

const byId = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

// #endregion

describe('childrenOf', () => {
  it('property: finds every snippet and card under the items asked about, however deep, with its own note, and nothing else', async () => {
    await fc.assert(
      fc.asyncProperty(askedArb, async ({ forest, roots }) => {
        const repo = await plant(forest);

        const found = await childrenOf(repo, roots);

        expect([...found].sort(byId)).toEqual(
          expectedChildren(forest, roots).sort(byId)
        );
      }),
      { numRuns: 300 }
    );
  });

  it('property: finds only what hangs under the live items asked about, when told to', async () => {
    await fc.assert(
      fc.asyncProperty(askedArb, async ({ forest, roots }) => {
        const repo = await plant(forest);

        const found = await childrenOf(repo, roots, { liveRoots: true });

        expect([...found].sort(byId)).toEqual(
          expectedChildren(forest, roots, { liveRoots: true }).sort(byId)
        );
      }),
      { numRuns: 300 }
    );
  });

  it('leaves out what hangs under an item asked about that is in the trash, when told to find under live ones only', async () => {
    const forest: Forest = {
      nodes: [
        { id: 'a', table: 'article', parent: null, context: null },
        { id: 's', table: 'snippet', parent: 'a', context: 'a' },
        { id: 'b', table: 'article', parent: null, context: null },
        { id: 'c', table: 'srs_card', parent: 'b', context: 'b' },
      ],
      trashed: new Set(['a']),
      purged: new Set(),
    };
    const repo = await plant(forest);

    const found = await childrenOf(repo, ['a', 'b'], { liveRoots: true });

    expect(found.map(({ id }) => id)).toEqual(['c']);
  });

  it('property: lists each one ahead of the row it sits under, deepest first', async () => {
    await fc.assert(
      fc.asyncProperty(askedArb, async ({ forest, roots }) => {
        const repo = await plant(forest);

        const found = await childrenOf(repo, roots);

        const at = new Map(found.map(({ id }, i) => [id, i]));
        for (const { id } of found) {
          const { parent } = forest.nodes.find((node) => node.id === id)!;
          const above = parent === null ? undefined : at.get(parent);
          if (above !== undefined) expect(at.get(id)!).toBeLessThan(above);
        }
      }),
      { numRuns: 300 }
    );
  });

  it('property: deleted in the order listed, and the items asked about after them, leave no row under or taken from any of them, and move no other row', async () => {
    await fc.assert(
      fc.asyncProperty(askedArb, async ({ forest, roots }) => {
        const repo = await plant(forest);
        const links = () =>
          repo.query(
            `SELECT id, parent, context FROM snippet WHERE ${NOT_PURGED}
             UNION ALL
             SELECT id, parent, context FROM srs_card WHERE ${NOT_PURGED}`
          ) as unknown as Pick<Node, 'id' | 'parent' | 'context'>[];
        const before = new Map(links().map(({ id, parent }) => [id, parent]));

        const found = await childrenOf(repo, roots);
        const removed = [
          ...found,
          ...forest.nodes.filter(
            ({ id }) => roots.includes(id) && !forest.purged.has(id)
          ),
        ];
        for (const { table, id } of removed) {
          for (const { query, params } of deleteRowStatements(table, id)) {
            repo.mutate(query, params);
          }
        }

        const gone = new Set(removed.map(({ id }) => id));
        for (const { id, parent, context } of links()) {
          expect(gone.has(id)).toBe(false);
          expect(parent === null || !gone.has(parent)).toBe(true);
          expect(context === null || !gone.has(context)).toBe(true);
          expect(parent).toBe(before.get(id));
        }
      }),
      { numRuns: 300 }
    );
  });

  it('lists a chain bottom up', async () => {
    const forest: Forest = {
      nodes: [
        { id: 'a', table: 'article', parent: null, context: null },
        { id: 's1', table: 'snippet', parent: 'a', context: 'a' },
        { id: 's2', table: 'snippet', parent: 's1', context: 's1' },
        { id: 's3', table: 'snippet', parent: 's2', context: 's2' },
        { id: 'c', table: 'srs_card', parent: 's3', context: 's3' },
      ],
      trashed: new Set(),
      purged: new Set(),
    };
    const repo = await plant(forest);

    const found = await childrenOf(repo, ['a']);

    expect(found.map(({ id }) => id)).toEqual(['c', 's3', 's2', 's1']);
  });

  it('ends, listing each row once, when links loop back through an item asked about', async () => {
    const forest: Forest = {
      nodes: [
        { id: 'r', table: 'snippet', parent: 'y', context: null },
        { id: 'x', table: 'snippet', parent: 'r', context: null },
        { id: 'y', table: 'snippet', parent: 'x', context: null },
        { id: 'c', table: 'srs_card', parent: 'y', context: null },
      ],
      trashed: new Set(),
      purged: new Set(),
    };
    const repo = await plant(forest);

    const found = await childrenOf(repo, ['r']);

    expect(found.map(({ id }) => id).sort()).toEqual(['c', 'x', 'y']);
  });

  it('property: reads everything it lists, notes included, in one query', async () => {
    await fc.assert(
      fc.asyncProperty(askedArb, async ({ forest, roots }) => {
        const repo = await plant(forest);
        const query = vi.spyOn(repo, 'query');

        await childrenOf(repo, roots);

        expect(query).toHaveBeenCalledTimes(roots.length === 0 ? 0 : 1);
        query.mockRestore();
      }),
      { numRuns: 50 }
    );
  });

  it('asks nothing of the database when asked about no items', async () => {
    const query = () => Promise.reject(new Error('asked'));

    await expect(childrenOf({ query }, [])).resolves.toEqual([]);
  });

  it('throws when the database cannot be read, rather than finding nothing under the items', async () => {
    // As the repository reads: a failed read resolves to no rows unless told
    // to throw
    const failure = new Error('unreadable');
    const query = (_sql: string, _params?: unknown[], options?: object) =>
      options && 'throwOnError' in options && options.throwOnError
        ? Promise.reject(failure)
        : Promise.resolve([]);

    await expect(childrenOf({ query }, ['a'])).rejects.toBe(failure);
  });
});
