import { purgedReference } from '#/lib/items/row-delete';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { rehomeOrphans } from './rehome-orphans';

// #region HELPERS

const SCHEMA = readFileSync(resolve(__dirname, '../../db/schema.sql'), 'utf-8');

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

/** Databases opened by a test, closed after it. */
let open: Database[] = [];
afterEach(() => {
  for (const db of open) db.close();
  open = [];
});

type Kind = 'article' | 'snippet' | 'srs_card';
const TABLES: readonly Kind[] = ['article', 'snippet', 'srs_card'];

/**
 * Where an item stands: live; trashed (deleted, its path kept, so it can
 * come back); deleted for good (a tombstone that let go of its path); or
 * gone, its tombstone pruned past the sync horizon, so no row at all.
 */
type State = 'live' | 'trashed' | 'purged' | 'pruned';

interface Item {
  id: string;
  kind: Kind;
  state: State;
  parent: string | null;
  context: string | null;
}

type Link =
  | { to: 'none' }
  | { to: 'earlier'; n: number }
  | { to: 'stranger'; n: number };

/**
 * What a link of a snippet or card can name: nothing, an earlier article or
 * snippet in any state, or an id no row ever had (a row pruned before this
 * database first saw it).
 */
const linkArb: fc.Arbitrary<Link> = fc.oneof(
  { weight: 1, arbitrary: fc.constant({ to: 'none' as const }) },
  {
    weight: 4,
    arbitrary: fc.nat().map((n) => ({ to: 'earlier' as const, n })),
  },
  {
    weight: 1,
    arbitrary: fc.nat(2).map((n) => ({ to: 'stranger' as const, n })),
  }
);

/**
 * A forest of items, each snippet and card under (and taken from) earlier
 * articles and snippets, so no chain of parents loops, as none can.
 */
const forestArb: fc.Arbitrary<Item[]> = fc
  .array(
    fc.record({
      kind: fc.constantFrom(...TABLES),
      state: fc.constantFrom<State>('live', 'trashed', 'purged', 'pruned'),
      parent: linkArb,
      context: fc.oneof(
        { weight: 3, arbitrary: fc.constant({ to: 'parent' as const }) },
        { weight: 2, arbitrary: linkArb }
      ),
    }),
    { minLength: 1, maxLength: 14 }
  )
  .map((specs) => {
    const items: Item[] = [];
    const pickLink = (link: Link): string | null => {
      if (link.to === 'none') return null;
      if (link.to === 'stranger') return `stranger${link.n}`;
      const holders = items.filter((item) => item.kind !== 'srs_card');
      return holders.length === 0 ? null : holders[link.n % holders.length].id;
    };
    for (const [i, spec] of specs.entries()) {
      const parent = spec.kind === 'article' ? null : pickLink(spec.parent);
      let context: string | null = null;
      if (spec.kind !== 'article') {
        context =
          spec.context.to === 'parent' ? parent : pickLink(spec.context);
      }
      items.push({
        id: `i${i}`,
        kind: spec.kind,
        state: spec.state,
        parent,
        context,
      });
    }
    return items;
  });

/** A database holding `items`, but for those pruned. */
function plant(items: readonly Item[]): Database {
  const db = new SQL.Database();
  open.push(db);
  db.exec(SCHEMA);
  for (const item of items) {
    if (item.state === 'pruned') continue;
    const reference =
      item.state === 'purged'
        ? purgedReference(item.id)
        : `${item.kind}/${item.id}.md`;
    const deleted = item.state === 'live' ? 0 : 1;
    if (item.kind === 'article') {
      db.run(
        `INSERT INTO article (id, reference, due, interval, priority, deleted)
         VALUES (?, ?, 1, 1, 30, ?)`,
        [item.id, reference, deleted]
      );
    } else if (item.kind === 'snippet') {
      db.run(
        `INSERT INTO snippet (id, reference, parent, context, due, interval, priority, deleted)
         VALUES (?, ?, ?, ?, 1, 1, 30, ?)`,
        [item.id, reference, item.parent, item.context, deleted]
      );
    } else {
      db.run(
        `INSERT INTO srs_card (id, reference, parent, context, created_at, due, stability,
           difficulty, elapsed_days, scheduled_days, state, deleted)
         VALUES (?, ?, ?, ?, 0, 1, 0, 0, 0, 0, 0, ?)`,
        [item.id, reference, item.parent, item.context, deleted]
      );
    }
  }
  return db;
}

type Row = Record<string, unknown>;

/** Every item row of `db`, whole, by table. */
function snapshot(db: Database): Record<Kind, Row[]> {
  const tables = {} as Record<Kind, Row[]>;
  for (const table of TABLES) {
    const [result] = db.exec(`SELECT * FROM ${table} ORDER BY id`);
    tables[table] = (result?.values ?? []).map((values) =>
      Object.fromEntries(values.map((v, i) => [result.columns[i], v]))
    );
  }
  return tables;
}

/**
 * The item a link to `id` leaves its holder under, by the rule a drop
 * follows: a live or trashed article or snippet is kept; a snippet deleted
 * for good hands over to the item it sat under, walking up while that one is
 * deleted for good too; an article sits under nothing; a row gone, or never
 * there, leaves nothing to sit under.
 */
function above(items: readonly Item[], id: string | null): string | null {
  const byId = new Map(
    items
      .filter((item) => item.state !== 'pruned' && item.kind !== 'srs_card')
      .map((item) => [item.id, item])
  );
  let at = id;
  while (at !== null) {
    const item = byId.get(at);
    if (!item) return null;
    if (item.state !== 'purged') return at;
    if (item.kind === 'article') return null;
    at = item.parent;
  }
  return null;
}

/** Whether `id` names an article or snippet that is not deleted for good. */
function holds(items: readonly Item[], id: unknown): boolean {
  return typeof id === 'string' && above(items, id) === id;
}

// #endregion

describe('rehomeOrphans', () => {
  it('property: moves every snippet and card not deleted for good off a parent deleted for good or gone, to the nearest item above it still there, and erases a context deleted for good or gone', () => {
    fc.assert(
      fc.property(forestArb, (items) => {
        const db = plant(items);

        rehomeOrphans(db);

        const after = snapshot(db);
        for (const item of items) {
          if (item.kind === 'article' || item.state === 'pruned') continue;
          const row = after[item.kind].find((r) => r.id === item.id)!;
          const expected = {
            parent: above(items, item.parent),
            context: holds(items, item.context) ? item.context : null,
          };
          if (item.state === 'purged') {
            // A tombstone's links say where it sat; one may move up with
            // the rest, as a drop moves it, or be left as it was
            expect([item.parent, expected.parent]).toContain(row.parent);
            expect([item.context, expected.context]).toContain(row.context);
          } else {
            expect({ parent: row.parent, context: row.context }).toEqual(
              expected
            );
          }
        }
      })
    );
  });

  it('property: changes no column but a link, and no link that names an item still there', () => {
    fc.assert(
      fc.property(forestArb, (items) => {
        const db = plant(items);
        const before = snapshot(db);

        rehomeOrphans(db);

        const after = snapshot(db);
        for (const table of TABLES) {
          expect(after[table].map((row) => row.id)).toEqual(
            before[table].map((row) => row.id)
          );
          for (const [i, row] of before[table].entries()) {
            const { parent, context, ...rest } = after[table][i];
            const { parent: wasParent, context: wasContext, ...was } = row;
            expect(rest).toEqual(was);
            if (holds(items, wasParent)) expect(parent).toBe(wasParent);
            if (holds(items, wasContext)) expect(context).toBe(wasContext);
          }
        }
      })
    );
  });

  it('property: says whether it wrote anything, writing nothing run again', () => {
    fc.assert(
      fc.property(forestArb, (items) => {
        const db = plant(items);
        const before = snapshot(db);

        const written = rehomeOrphans(db);

        const once = snapshot(db);
        const changed = TABLES.reduce(
          (count, table) =>
            count +
            once[table].filter(
              (row, i) =>
                JSON.stringify(row) !== JSON.stringify(before[table][i])
            ).length,
          0
        );
        // One row can take two writes, its context and its parent
        expect(written).toBeGreaterThanOrEqual(changed);
        expect(written > 0).toBe(changed > 0);
        expect(rehomeOrphans(db)).toBe(0);
        expect(snapshot(db)).toEqual(once);
      })
    );
  });

  it('stops a card walking up at a snippet only trashed, which can come back, above one deleted for good', () => {
    const db = plant([
      { id: 'a', kind: 'article', state: 'live', parent: null, context: null },
      {
        id: 's2',
        kind: 'snippet',
        state: 'trashed',
        parent: 'a',
        context: 'a',
      },
      {
        id: 's1',
        kind: 'snippet',
        state: 'purged',
        parent: 's2',
        context: 's2',
      },
      { id: 'c', kind: 'srs_card', state: 'live', parent: 's1', context: 's1' },
    ]);

    rehomeOrphans(db);

    const { snippet, srs_card } = snapshot(db);
    expect(srs_card).toEqual([
      expect.objectContaining({ id: 'c', parent: 's2', context: null }),
    ]);
    expect(snippet).toContainEqual(
      expect.objectContaining({ id: 's2', parent: 'a', context: 'a' })
    );
  });

  it('moves a card to the top when every item above it was deleted for good', () => {
    const db = plant([
      {
        id: 'a',
        kind: 'article',
        state: 'purged',
        parent: null,
        context: null,
      },
      { id: 's2', kind: 'snippet', state: 'purged', parent: 'a', context: 'a' },
      {
        id: 's1',
        kind: 'snippet',
        state: 'purged',
        parent: 's2',
        context: 's2',
      },
      { id: 'c', kind: 'srs_card', state: 'live', parent: 's1', context: 'a' },
    ]);

    rehomeOrphans(db);

    expect(snapshot(db).srs_card).toEqual([
      expect.objectContaining({ id: 'c', parent: null, context: null }),
    ]);
  });

  it('ends at the top when parents deleted for good loop', () => {
    const db = plant([
      {
        id: 's0',
        kind: 'snippet',
        state: 'purged',
        parent: 's1',
        context: null,
      },
      {
        id: 's1',
        kind: 'snippet',
        state: 'purged',
        parent: 's0',
        context: null,
      },
      { id: 'c', kind: 'srs_card', state: 'live', parent: 's0', context: 's0' },
    ]);

    rehomeOrphans(db);

    expect(snapshot(db).srs_card).toEqual([
      expect.objectContaining({ id: 'c', parent: null, context: null }),
    ]);
  });

  it('writes nothing when a write fails partway, passing the failure on and leaving no transaction open', () => {
    const db = plant([
      { id: 'a', kind: 'article', state: 'live', parent: null, context: null },
      { id: 's', kind: 'snippet', state: 'purged', parent: 'a', context: 'a' },
      { id: 'kid', kind: 'snippet', state: 'live', parent: 's', context: 's' },
      { id: 'c', kind: 'srs_card', state: 'live', parent: 's', context: 's' },
    ]);
    db.exec(`CREATE TEMP TRIGGER refuse BEFORE UPDATE ON main.srs_card
      BEGIN SELECT RAISE(ABORT, 'refused'); END`);
    const before = snapshot(db);

    expect(() => rehomeOrphans(db)).toThrow('refused');

    expect(snapshot(db)).toEqual(before);
    expect(() => db.exec('BEGIN; COMMIT')).not.toThrow();
  });

  it('nests in a transaction the caller holds, which can still undo it', () => {
    const db = plant([
      {
        id: 'c',
        kind: 'srs_card',
        state: 'live',
        parent: 'stranger',
        context: null,
      },
    ]);
    const before = snapshot(db);

    db.exec('BEGIN');
    expect(rehomeOrphans(db)).toBe(1);
    db.exec('ROLLBACK');

    expect(snapshot(db)).toEqual(before);
  });
});
