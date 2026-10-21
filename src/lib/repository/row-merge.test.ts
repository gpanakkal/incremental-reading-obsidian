import { migrations } from '#/db/migrations';
import { evictedSpot } from '#/lib/moved-note-scan';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import initSqlJs, {
  type BindParams,
  type Database,
  type SqlJsStatic,
  type SqlValue,
} from 'sql.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  copyIntoAttached,
  INCOMING_SCHEMA,
  MERGE_TABLES,
  mergeInto,
  openIncoming,
  previewMerge,
  type MergeReport,
} from './row-merge';
import { armRowStamps, SYNCED_TABLES, type StampSource } from './row-stamps';

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

type Row = Record<string, number | string | null>;

interface Article {
  id: string;
  reference: string;
  priority?: number;
  fixed_interval_days?: number | null;
  deleted?: number;
  updated_at: number;
  updated_by: string;
}

interface Review {
  id: string;
  article_id: string;
  deleted?: number;
  updated_at: number;
  updated_by: string;
}

interface Rebind {
  article_id: string;
  new_reference: string;
  updated_at: number;
  updated_by: string;
}

/** One device's copy of the database: its rows, stamps as given. */
interface Copy {
  articles: Article[];
  reviews?: Review[];
  rebinds?: Rebind[];
  writeStamp?: Record<string, number>;
}

const THIS_DEVICE: StampSource = { deviceId: () => 'here', now: () => 1e12 };

let emptyBytes: Uint8Array | null = null;

/** A database holding `copy`, its stamps exactly as given. */
function build(copy: Copy, armed = false): Database {
  if (!emptyBytes) {
    const empty = new SQL.Database();
    empty.exec(SCHEMA);
    emptyBytes = empty.export();
    empty.close();
  }
  const db = new SQL.Database(emptyBytes);
  open.push(db);
  db.exec('PRAGMA foreign_keys = ON');
  for (const a of copy.articles) {
    db.run(
      `INSERT INTO article (id, reference, due, interval, priority,
         fixed_interval_days, deleted, updated_at, updated_by)
       VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?)`,
      [
        a.id,
        a.reference,
        a.priority ?? 30,
        a.fixed_interval_days ?? null,
        a.deleted ?? 0,
        a.updated_at,
        a.updated_by,
      ]
    );
  }
  for (const r of copy.reviews ?? []) {
    db.run(
      `INSERT INTO article_review (id, article_id, review_time, deleted,
         updated_at, updated_by) VALUES (?, ?, 1, ?, ?, ?)`,
      [r.id, r.article_id, r.deleted ?? 0, r.updated_at, r.updated_by]
    );
  }
  for (const r of copy.rebinds ?? []) {
    db.run(
      `INSERT INTO rebind (article_id, old_reference, new_reference,
         rebound_at, updated_at, updated_by) VALUES (?, 'old', ?, 1, ?, ?)`,
      [r.article_id, r.new_reference, r.updated_at, r.updated_by]
    );
  }
  for (const [device, generation] of Object.entries(copy.writeStamp ?? {})) {
    db.run('INSERT INTO write_stamp (device, generation) VALUES (?, ?)', [
      device,
      generation,
    ]);
  }
  if (armed) armRowStamps(db, THIS_DEVICE);
  return db;
}

/** `copy`'s database as another device's file, opened for merging. */
function incoming(copy: Copy): Database {
  const source = build(copy);
  const db = openIncoming(SQL, source.export(), migrations);
  open.push(db);
  return db;
}

function rowsOf(db: Database, table: string, key: string): Row[] {
  const [result] = db.exec(`SELECT * FROM ${table} ORDER BY ${key}`);
  return (result?.values ?? []).map((values) =>
    Object.fromEntries(values.map((v, i) => [result.columns[i], v]))
  ) as Row[];
}

/** Every synced table and the write stamp of `db`, whole. */
function everything(db: Database): Record<string, Row[]> {
  const tables: Record<string, Row[]> = {};
  for (const { name, key } of MERGE_TABLES)
    tables[name] = rowsOf(db, name, key);
  tables.write_stamp = rowsOf(db, 'write_stamp', 'device');
  return tables;
}

/** Merge `theirs` into a database holding `mine`; the merged database. */
function merged(
  mine: Copy,
  theirs: Copy
): { db: Database; report: MergeReport } {
  const db = build(mine, true);
  const report = mergeInto(db, incoming(theirs), THIS_DEVICE);
  return { db, report };
}

function articles(db: Database): Row[] {
  return rowsOf(db, 'article', 'id');
}

/** The schemas open on `db`'s connection, temp included once used. */
function attached(db: Database): string[] {
  const names = db.exec('PRAGMA database_list')[0].values.map((r) => r[1]);
  return [...new Set(['main', 'temp', ...names])] as string[];
}

const stamp = (row: Row) => [row.updated_at, row.updated_by] as const;

/** Whether `copy` holds the save `row` came in (an unstamped row: always). */
function seenBy(copy: Copy, row: Row) {
  return (
    row.updated_at === 0 ||
    (copy.writeStamp?.[row.updated_by as string] ?? -1) >=
      (row.updated_at as number)
  );
}

/** Whether stamp `x` is later than `y`: the later clock, then the device. */
function later(x: readonly [unknown, unknown], y: readonly [unknown, unknown]) {
  return (
    (x[0] as number) > (y[0] as number) ||
    (x[0] === y[0] && (x[1] as string) > (y[1] as string))
  );
}

const CONTENT_SKIP = new Set(['updated_at', 'updated_by']);
function sameContent(x: Row, y: Row, skip: readonly string[] = []) {
  return Object.keys(x).every(
    (c) => CONTENT_SKIP.has(c) || skip.includes(c) || x[c] === y[c]
  );
}

const REFERENCES = ['n0.md', 'n1.md', 'n2.md'];
const KEYS = ['k0', 'k1', 'k2', 'k3'];
const DEVICES = ['', 'a', 'b'];

const stampArb = fc.record({
  updated_at: fc.nat(3),
  updated_by: fc.constantFrom(...DEVICES),
});

/**
 * One device's copy: rows from a small pool of keys, references, stamps and
 * values, so that both copies often hold one row alike, stamped alike but
 * different, or under one reference with different ids.
 */
const copyArb: fc.Arbitrary<Copy> = fc
  .record({
    articles: fc.uniqueArray(
      fc.record({
        id: fc.constantFrom(...KEYS),
        reference: fc.constantFrom(...REFERENCES),
        priority: fc.constantFrom(10, 30, 50),
        fixed_interval_days: fc.option(fc.constantFrom(1, 2), { nil: null }),
        deleted: fc.constantFrom(0, 1),
        stamp: stampArb,
      }),
      { selector: (a) => a.id, maxLength: KEYS.length }
    ),
    reviews: fc.array(
      fc.record({
        id: fc.constantFrom('r0', 'r1', 'r2'),
        pick: fc.nat(),
        deleted: fc.constantFrom(0, 1),
        stamp: stampArb,
      }),
      { maxLength: 3 }
    ),
    rebinds: fc.array(
      fc.record({
        pick: fc.nat(),
        new_reference: fc.constantFrom('x.pdf', 'y.pdf'),
        stamp: stampArb,
      }),
      { maxLength: 2 }
    ),
    writeStamp: fc.dictionary(fc.constantFrom('a', 'b', 'c'), fc.nat(4)),
  })
  .map(({ articles, reviews, rebinds, writeStamp }): Copy => {
    // A copy holds each reference once, as UNIQUE makes it
    const seen = new Set<string>();
    const rows: Article[] = articles.map(({ stamp, ...a }) => {
      const reference = seen.has(a.reference) ? `own/${a.id}.md` : a.reference;
      seen.add(reference);
      return { ...a, reference, ...stamp };
    });
    const ids = rows.map((a) => a.id);
    const at = (n: number) => ids[n % ids.length];
    return {
      articles: rows,
      reviews: ids.length
        ? [
            ...new Map(
              reviews.map(({ stamp, pick, ...r }) => [
                r.id,
                { ...r, article_id: at(pick), ...stamp },
              ])
            ).values(),
          ]
        : [],
      rebinds: ids.length
        ? [
            ...new Map(
              rebinds.map(({ stamp, pick, ...r }) => [
                at(pick),
                { ...r, article_id: at(pick), ...stamp },
              ])
            ).values(),
          ]
        : [],
      writeStamp,
    };
  });

// #endregion

describe('MERGE_TABLES', () => {
  it('lists every synced table once', () => {
    expect(MERGE_TABLES.map((t) => t.name).sort()).toEqual(
      [...SYNCED_TABLES].sort()
    );
  });

  it('lists a table after every table its foreign keys name, and keys each by its primary key', () => {
    const db = build({ articles: [] });
    for (const [i, { name, key }] of MERGE_TABLES.entries()) {
      const before = MERGE_TABLES.slice(0, i).map((t) => t.name);
      const [parents] = db.exec(`PRAGMA foreign_key_list(${name})`);
      for (const row of parents?.values ?? []) {
        expect(before).toContain(row[2]);
      }
      const [info] = db.exec(`PRAGMA table_info(${name})`);
      const pk = info.values.filter((row) => row[5] === 1).map((r) => r[1]);
      expect(pk).toEqual([key]);
    }
  });

  it('marks the review logs, and the unique reference of item rows', () => {
    const logs = MERGE_TABLES.filter((t) => t.log).map((t) => t.name);
    expect(logs.sort()).toEqual([
      'article_review',
      'snippet_review',
      'srs_card_review',
    ]);
    const db = build({ articles: [] });
    for (const { name, unique } of MERGE_TABLES) {
      const [indexes] = db.exec(`PRAGMA index_list(${name})`);
      const uniques = (indexes?.values ?? [])
        .filter((row) => row[2] === 1 && row[3] === 'u')
        .flatMap((row) => db.exec(`PRAGMA index_info(${String(row[1])})`))
        .map((r) => r.values[0][2]);
      expect(uniques).toEqual(unique ? [unique] : []);
    }
  });
});

describe('mergeInto', () => {
  it('property: merging either copy into the other gives the same rows', () => {
    fc.assert(
      fc.property(copyArb, copyArb, (x, y) => {
        const one = merged(x, y).db;
        const other = merged(y, x).db;
        expect(everything(one)).toEqual(everything(other));
      }),
      { numRuns: 300 }
    );
  }, 60_000);

  it('property: merging either copy again changes nothing', () => {
    fc.assert(
      fc.property(copyArb, copyArb, (x, y) => {
        const { db } = merged(x, y);
        const before = everything(db);
        // The other copy again, or this device's own from before the merge,
        // as a third device that has not heard of the merge yet would send
        for (const copy of [y, x]) {
          const again = mergeInto(db, incoming(copy), THIS_DEVICE);
          expect(again).toEqual({ replaced: 0, written: 0 });
          expect(everything(db)).toEqual(before);
        }
      }),
      { numRuns: 200 }
    );
  }, 60_000);

  it('property: keeps every row of either copy, the later stamped of two, and the newer generation of every device', () => {
    fc.assert(
      fc.property(copyArb, copyArb, (mine, theirs) => {
        const { db } = merged(mine, theirs);
        const local = build(mine);
        const other = build(theirs);
        for (const { name, key } of MERGE_TABLES) {
          const result = new Map(rowsOf(db, name, key).map((r) => [r[key], r]));
          const a = new Map(rowsOf(local, name, key).map((r) => [r[key], r]));
          const b = new Map(rowsOf(other, name, key).map((r) => [r[key], r]));
          expect([...result.keys()].sort()).toEqual(
            [...new Set([...a.keys(), ...b.keys()])].sort()
          );
          for (const [k, row] of result) {
            const [x, y] = [a.get(k), b.get(k)];
            const candidates = [x, y].filter((r): r is Row => r !== undefined);
            const newest = candidates.reduce((p, q) =>
              later(stamp(q), stamp(p)) ? q : p
            );
            // A tombstone beats a live row from a copy without its save
            const tombstone = candidates.find((c) => c.deleted === 1);
            const live = candidates.find((c) => c.deleted === 0);
            const liveCopy = live === x ? mine : theirs;
            const winner =
              tombstone && live && !seenBy(liveCopy, tombstone)
                ? tombstone
                : newest;
            // A row parked by this merge keeps its stamp too
            expect(stamp(row)).toEqual(stamp(winner));
            // The same row, unless it gave up its reference
            expect(
              candidates.some((c) =>
                sameContent(row, c, name === 'article' ? ['reference'] : [])
              )
            ).toBe(true);
          }
        }
        const generations = { ...mine.writeStamp };
        for (const [d, g] of Object.entries(theirs.writeStamp ?? {})) {
          generations[d] = Math.max(generations[d] ?? -Infinity, g);
        }
        expect(
          Object.fromEntries(
            rowsOf(db, 'write_stamp', 'device').map((r) => [
              r.device,
              r.generation,
            ])
          )
        ).toEqual(generations);
      }),
      { numRuns: 300 }
    );
  }, 60_000);

  it('property: counts as replaced each row of this device that changed and the other copy never saw', () => {
    fc.assert(
      fc.property(copyArb, copyArb, (mine, theirs) => {
        const { db, report } = merged(mine, theirs);
        const local = build(mine);
        const other = build(theirs);
        let replaced = 0;
        let written = 0;
        for (const { name, key } of MERGE_TABLES) {
          const a = new Map(rowsOf(local, name, key).map((r) => [r[key], r]));
          const b = new Map(rowsOf(other, name, key).map((r) => [r[key], r]));
          for (const row of rowsOf(db, name, key)) {
            const m = a.get(row[key]);
            const i = b.get(row[key]);
            const spot = evictedSpot({
              table: 'article',
              id: row.id as string,
            });
            const evicted =
              name === 'article' &&
              m !== undefined &&
              row.reference === spot &&
              m.reference !== spot;
            const rewritten = !m || JSON.stringify(m) !== JSON.stringify(row);
            if (rewritten) written++;
            if (!m || sameContent(m, row)) continue;
            const tookTheirs =
              i !== undefined &&
              stamp(row).join() === stamp(i).join() &&
              sameContent(row, i, ['reference']);
            const unseen =
              m.updated_at === 0
                ? i?.updated_at === 0
                : (theirs.writeStamp?.[m.updated_by as string] ?? -1) <
                  (m.updated_at as number);
            if (evicted || (tookTheirs && unseen)) replaced++;
          }
        }
        expect(report).toEqual({ replaced, written });
      }),
      { numRuns: 300 }
    );
  }, 60_000);

  it('keeps the stamps of rows it copies though the stamp triggers are armed, and stamps the next write as this device', () => {
    const { db } = merged(
      {
        articles: [
          { id: 'k0', reference: 'n0.md', updated_at: 1, updated_by: 'a' },
        ],
      },
      {
        articles: [
          {
            id: 'k0',
            reference: 'n0.md',
            priority: 50,
            updated_at: 5,
            updated_by: 'b',
          },
          { id: 'k1', reference: 'n1.md', updated_at: 0, updated_by: '' },
        ],
      }
    );
    expect(articles(db).map((r) => [r.id, r.priority, ...stamp(r)])).toEqual([
      ['k0', 50, 5, 'b'],
      ['k1', 30, 0, ''],
    ]);

    db.run("UPDATE article SET priority = 10 WHERE id = 'k1'");
    expect(stamp(articles(db)[1])).toEqual([1e12, 'here']);
  });

  it('takes the copy of a row stamped alike by the greater device, then by content, whichever copy it merges into', () => {
    const row = (
      by: string,
      priority: number,
      fixed: number | null
    ): Article => ({
      id: 'k0',
      reference: 'n0.md',
      priority,
      fixed_interval_days: fixed,
      updated_at: 3,
      updated_by: by,
    });
    const cases: [Article, Article, Article][] = [
      [row('a', 10, null), row('b', 50, null), row('b', 50, null)],
      [row('a', 10, null), row('a', 50, null), row('a', 50, null)],
      // A null is no value, which every value orders after
      [row('a', 10, null), row('a', 10, 2), row('a', 10, 2)],
      [row('a', 10, 1), row('a', 10, 2), row('a', 10, 2)],
    ];
    for (const [x, y, winner] of cases) {
      for (const [mine, theirs] of [
        [x, y],
        [y, x],
      ]) {
        const [result] = articles(
          merged({ articles: [mine] }, { articles: [theirs] }).db
        );
        expect(result).toMatchObject(winner);
      }
    }
  });

  it("counts an unstamped row replaced only by another device's unstamped copy that differs", () => {
    const unstamped = (priority: number): Article => ({
      id: 'k0',
      reference: 'n0.md',
      priority,
      updated_at: 0,
      updated_by: '',
    });
    expect(
      merged(
        { articles: [unstamped(10)] },
        { articles: [{ ...unstamped(50), updated_at: 2, updated_by: 'b' }] }
      ).report
    ).toEqual({ replaced: 0, written: 1 });
    expect(
      merged({ articles: [unstamped(10)] }, { articles: [unstamped(50)] })
        .report
    ).toEqual({ replaced: 1, written: 1 });
    expect(
      merged({ articles: [unstamped(50)] }, { articles: [unstamped(10)] })
        .report
    ).toEqual({ replaced: 0, written: 0 });
  });

  it('counts a replaced row as seen by the other copy once it holds a save of the device that stamped it from then on', () => {
    const mine: Copy = {
      articles: [
        { id: 'k0', reference: 'n0.md', updated_at: 4, updated_by: 'a' },
      ],
    };
    const theirs = (generation?: number): Copy => ({
      articles: [
        {
          id: 'k0',
          reference: 'n0.md',
          priority: 50,
          updated_at: 9,
          updated_by: 'b',
        },
      ],
      writeStamp: generation === undefined ? {} : { a: generation },
    });
    expect(merged(mine, theirs()).report.replaced).toBe(1);
    expect(merged(mine, theirs(3)).report.replaced).toBe(1);
    expect(merged(mine, theirs(4)).report.replaced).toBe(0);
    expect(merged(mine, theirs(5)).report.replaced).toBe(0);
  });

  describe('a tombstone and a live copy of one row', () => {
    const live = (updated_at: number, updated_by = 'b'): Article => ({
      id: 'k0',
      reference: 'n0.md',
      priority: 50,
      updated_at,
      updated_by,
    });
    const tombstone = (updated_at: number, updated_by = 'a'): Article => ({
      id: 'k0',
      reference: '/ir-deleted/k0',
      deleted: 1,
      updated_at,
      updated_by,
    });

    /** Merge both ways round; the one row both results agree on. */
    function settled(x: Copy, y: Copy): Row {
      const [one] = articles(merged(x, y).db);
      expect(articles(merged(y, x).db)).toEqual([one]);
      return one;
    }

    it.each([
      {
        name: 'a newer write that never saw the delete',
        vector: { a: 4 },
        deleted: 1,
      },
      {
        name: 'a write from a copy that holds the delete',
        vector: { a: 5 },
        deleted: 0,
      },
    ])('settles $name against the delete', ({ vector, deleted }) => {
      const row = settled(
        { articles: [tombstone(5)], writeStamp: { a: 5 } },
        { articles: [live(9)], writeStamp: { b: 9, ...vector } }
      );
      expect(row.deleted).toBe(deleted);
    });

    it("counts this device's newer write replaced by a delete it never saw", () => {
      const { db, report } = merged(
        { articles: [live(9)], writeStamp: { b: 9 } },
        { articles: [tombstone(5)], writeStamp: { a: 5 } }
      );
      expect(articles(db)[0]).toMatchObject({ deleted: 1, updated_at: 5 });
      expect(report).toEqual({ replaced: 1, written: 1 });
    });

    it('keeps a delete it has taken over a newer copy that never saw it, when that copy comes again', () => {
      const { db } = merged(
        { articles: [tombstone(5)], writeStamp: { a: 5 } },
        { articles: [live(9)], writeStamp: { b: 9 } }
      );
      const again = mergeInto(
        db,
        incoming({ articles: [live(9)], writeStamp: { b: 9 } }),
        THIS_DEVICE
      );
      expect(again).toEqual({ replaced: 0, written: 0 });
      expect(articles(db)[0].deleted).toBe(1);
    });

    it('lets any newer write beat an unstamped tombstone, as from before row stamps', () => {
      const row = settled(
        { articles: [tombstone(0, '')] },
        { articles: [live(9)], writeStamp: { b: 9 } }
      );
      expect(row).toMatchObject({ deleted: 0, updated_at: 9 });
    });

    it('lets a newer delete win as before, seen or not', () => {
      const row = settled(
        { articles: [live(5)], writeStamp: { b: 5 } },
        { articles: [tombstone(9)], writeStamp: { a: 9 } }
      );
      expect(row).toMatchObject({ deleted: 1, updated_at: 9 });
    });
  });

  describe('two rows under one reference', () => {
    const at = (
      id: string,
      updated_at: number,
      updated_by = 'a',
      deleted = 0
    ): Article => ({ id, reference: 'n0.md', updated_at, updated_by, deleted });

    it.each([
      { name: 'the newer row', kept: at('k1', 2), parked: at('k0', 1) },
      {
        name: 'by device on a tie',
        kept: at('k1', 1, 'b'),
        parked: at('k0', 1, 'a'),
      },
      { name: 'by id on a tie', kept: at('k1', 1), parked: at('k0', 1) },
      {
        name: 'a live row over a newer tombstone',
        kept: at('k0', 1),
        parked: at('k1', 9, 'b', 1),
      },
    ])(
      'keeps it for $name, and parks the other where no note can be',
      ({ kept, parked }) => {
        for (const [mine, theirs] of [
          [kept, parked],
          [parked, kept],
        ]) {
          const { db, report } = merged(
            { articles: [mine] },
            { articles: [theirs] }
          );
          const references: Record<string, unknown> = {};
          for (const r of articles(db)) references[String(r.id)] = r.reference;
          expect(references).toEqual({
            [kept.id]: 'n0.md',
            [parked.id]: evictedSpot({ table: 'article', id: parked.id }),
          });
          // This device's row giving its reference up is a change it loses
          expect(report.replaced).toBe(mine === parked ? 1 : 0);
          expect(report.written).toBe(mine === parked ? 2 : 1);
        }
      }
    );

    // Found by the two-device simulation: parked one past its stamp, the row
    // tied with the next write of the device that stamped it, and beat it
    it('lets a later write of the device that stamped a parked row win over it, whichever copy holds which', () => {
      const parkedHere = merged(
        { articles: [at('k1', 2)] },
        { articles: [at('k0', 1, 'b')] }
      ).db;
      expect(articles(parkedHere)[0].reference).toBe(
        evictedSpot({ table: 'article', id: 'k0' })
      );
      const parkedBytes = parkedHere.export();
      // `b` un-imports its own copy next, one past its stamp
      const tombstone: Copy = {
        articles: [{ ...at('k0', 2, 'b', 1), reference: '/ir-deleted/k0' }],
      };
      mergeInto(parkedHere, incoming(tombstone), THIS_DEVICE);
      const tombstoneHere = build(tombstone, true);
      const parked = openIncoming(SQL, parkedBytes, migrations);
      open.push(parked);
      mergeInto(tombstoneHere, parked, THIS_DEVICE);
      for (const db of [parkedHere, tombstoneHere]) {
        expect(articles(db)[0]).toMatchObject({
          deleted: 1,
          updated_at: 2,
          updated_by: 'b',
        });
      }
    });

    it('trades references between rows moved across each other', () => {
      const { db } = merged(
        {
          articles: [
            { id: 'k0', reference: 'n0.md', updated_at: 1, updated_by: 'a' },
            { id: 'k1', reference: 'n1.md', updated_at: 1, updated_by: 'a' },
          ],
        },
        {
          articles: [
            { id: 'k0', reference: 'n1.md', updated_at: 2, updated_by: 'b' },
            { id: 'k1', reference: 'n0.md', updated_at: 2, updated_by: 'b' },
          ],
        }
      );
      expect(articles(db).map((r) => r.reference)).toEqual(['n1.md', 'n0.md']);
    });

    it("parks this device's row for the other copy's new one", () => {
      const { db, report } = merged(
        { articles: [at('k0', 1), { ...at('k2', 1), reference: 'n2.md' }] },
        { articles: [at('k1', 2), { ...at('k2', 5, 'b'), reference: 'n1.md' }] }
      );
      expect(articles(db).map((r) => r.reference)).toEqual([
        evictedSpot({ table: 'article', id: 'k0' }),
        'n0.md',
        'n1.md',
      ]);
      expect(report).toEqual({ replaced: 2, written: 3 });
    });
  });

  it('merges every synced table, and takes a row only one copy has', () => {
    const db = build({ articles: [] }, true);
    const theirs = build({ articles: [] });
    theirs.exec(`
      INSERT INTO snippet (id, reference, due, interval, priority, updated_at, updated_by)
        VALUES ('s', 's.md', 1, 1, 30, 2, 'b');
      INSERT INTO snippet_review (id, snippet_id, review_time, updated_at, updated_by)
        VALUES ('sr', 's', 1, 2, 'b');
      INSERT INTO srs_card (id, reference, created_at, due, stability, difficulty,
          elapsed_days, scheduled_days, state, updated_at, updated_by)
        VALUES ('c', 'c.md', 1, 1, 1, 1, 0, 0, 0, 2, 'b');
      INSERT INTO srs_card_review (id, card_id, due, review, stability, difficulty,
          elapsed_days, last_elapsed_days, scheduled_days, rating, state,
          updated_at, updated_by)
        VALUES ('cr', 'c', 1, 1, 1, 1, 0, 0, 0, 3, 0, 2, 'b');
    `);
    const copy = openIncoming(SQL, theirs.export(), migrations);
    open.push(copy);

    expect(mergeInto(db, copy, THIS_DEVICE)).toEqual({
      replaced: 0,
      written: 4,
    });
    for (const table of [
      'snippet',
      'snippet_review',
      'srs_card',
      'srs_card_review',
    ]) {
      expect(rowsOf(db, table, 'id')).toEqual(rowsOf(theirs, table, 'id'));
    }
  });

  it('merges review logs and rebinds by their keys, tombstones included', () => {
    const { db } = merged(
      {
        articles: [
          { id: 'k0', reference: 'n0.md', updated_at: 1, updated_by: 'a' },
        ],
        reviews: [
          { id: 'r0', article_id: 'k0', updated_at: 1, updated_by: 'a' },
        ],
        rebinds: [
          {
            article_id: 'k0',
            new_reference: 'x.pdf',
            updated_at: 3,
            updated_by: 'a',
          },
        ],
      },
      {
        articles: [
          { id: 'k0', reference: 'n0.md', updated_at: 1, updated_by: 'a' },
        ],
        reviews: [
          {
            id: 'r0',
            article_id: 'k0',
            deleted: 1,
            updated_at: 2,
            updated_by: 'b',
          },
          { id: 'r1', article_id: 'k0', updated_at: 2, updated_by: 'b' },
        ],
        rebinds: [
          {
            article_id: 'k0',
            new_reference: 'y.pdf',
            updated_at: 2,
            updated_by: 'b',
          },
        ],
      }
    );
    expect(
      rowsOf(db, 'article_review', 'id').map((r) => [r.id, r.deleted])
    ).toEqual([
      ['r0', 1],
      ['r1', 0],
    ]);
    expect(
      rowsOf(db, 'rebind', 'article_id').map((r) => r.new_reference)
    ).toEqual(['x.pdf']);
  });

  it('takes from the write stamp only devices and generations that can be one', () => {
    const db = build({ articles: [], writeStamp: { a: 5, b: 1 } });
    const theirs = build({ articles: [], writeStamp: { a: 3, b: 7, c: 2 } });
    theirs.exec(`
      INSERT INTO write_stamp (device, generation) VALUES (x'01', 9);
      INSERT INTO write_stamp (device, generation) VALUES ('junk', 'later');
    `);
    const copy = new SQL.Database(theirs.export());
    open.push(copy);

    mergeInto(db, copy, THIS_DEVICE);

    expect(rowsOf(db, 'write_stamp', 'device')).toEqual([
      { device: 'a', generation: 5 },
      { device: 'b', generation: 7 },
      { device: 'c', generation: 2 },
    ]);
  });

  it('changes nothing, and detaches the copy, when a statement fails', () => {
    const db = build(
      {
        articles: [
          { id: 'k0', reference: 'n0.md', updated_at: 1, updated_by: 'a' },
        ],
      },
      true
    );
    const theirs = build({
      articles: [
        { id: 'k1', reference: 'n1.md', updated_at: 2, updated_by: 'b' },
      ],
    });
    // A review of an article neither copy has: only a hand-edited file has one
    theirs.exec('PRAGMA foreign_keys = OFF');
    theirs.exec(`INSERT INTO article_review (id, article_id, review_time)
      VALUES ('r', 'missing', 1)`);
    const copy = new SQL.Database(theirs.export());
    open.push(copy);
    const before = everything(db);

    expect(() => mergeInto(db, copy, THIS_DEVICE)).toThrow(/FOREIGN KEY/);

    expect(everything(db)).toEqual(before);
    expect(attached(db)).toEqual(['main', 'temp']);
    // Armed again: a write is stamped
    db.run("UPDATE article SET priority = 10 WHERE id = 'k0'");
    expect(stamp(articles(db)[0])).toEqual([1e12, 'here']);
  });
});

describe('previewMerge', () => {
  it('property: reports what the merge would do, writing nothing', () => {
    fc.assert(
      fc.property(copyArb, copyArb, (mine, theirs) => {
        const db = build(mine, true);
        const before = everything(db);
        const copy = incoming(theirs);

        const preview = previewMerge(db, copy);

        expect(everything(db)).toEqual(before);
        expect(attached(db)).toEqual(['main', 'temp']);
        // Nor leaves its working tables behind
        expect(
          db.exec(
            "SELECT name FROM temp.sqlite_master WHERE name LIKE 'ir_merge%'"
          )
        ).toEqual([]);
        expect(mergeInto(db, copy, THIS_DEVICE)).toEqual(preview);
      }),
      { numRuns: 150 }
    );
  }, 60_000);
});

describe('attaching the copy', () => {
  it("attaches the copy's own file rather than copying its rows", () => {
    const db = build({ articles: [] }, true);
    const copy = incoming({
      articles: [
        { id: 'k0', reference: 'n0.md', updated_at: 2, updated_by: 'b' },
      ],
    });
    const prepare = vi.spyOn(db, 'prepare');

    expect(mergeInto(db, copy, THIS_DEVICE)).toEqual({
      replaced: 0,
      written: 1,
    });
    expect(previewMerge(db, copy)).toEqual({ replaced: 0, written: 0 });

    for (const [sql] of prepare.mock.calls) {
      expect(sql).not.toMatch(new RegExp(`INSERT INTO ${INCOMING_SCHEMA}`));
    }
    expect(articles(db).map((r) => r.id)).toEqual(['k0']);
  });

  /** A copy whose sql.js file name is `name`, as a later sql.js may lack. */
  function renamed(copy: Database, name: unknown): () => void {
    const own = Object.getOwnPropertyDescriptor(copy, 'filename');
    Object.defineProperty(copy, 'filename', {
      value: name,
      configurable: true,
    });
    return () => Object.defineProperty(copy, 'filename', own!);
  }

  it.each([
    { name: 'no file name', filename: undefined },
    { name: 'the name of a file that is no database', filename: 'nowhere' },
  ])(
    'copies the rows over one by one when the copy has $name',
    ({ filename }) => {
      const mine: Copy = {
        articles: [
          { id: 'k0', reference: 'n0.md', updated_at: 1, updated_by: 'a' },
        ],
        writeStamp: { a: 1 },
      };
      const theirs: Copy = {
        articles: [
          {
            id: 'k0',
            reference: 'n0.md',
            priority: 50,
            updated_at: 2,
            updated_by: 'b',
          },
          { id: 'k1', reference: 'n1.md', updated_at: 2, updated_by: 'b' },
        ],
        reviews: [
          { id: 'r', article_id: 'k1', updated_at: 2, updated_by: 'b' },
        ],
        writeStamp: { b: 2 },
      };
      const expected = merged(mine, theirs);
      const db = build(mine, true);
      const copy = incoming(theirs);
      const restore = renamed(copy, filename);

      expect(previewMerge(db, copy)).toEqual(expected.report);
      expect(mergeInto(db, copy, THIS_DEVICE)).toEqual(expected.report);
      restore();

      expect(everything(db)).toEqual(everything(expected.db));
      expect(attached(db)).toEqual(['main', 'temp']);
    }
  );

  it('detaches what it attached when a copied table is missing a column', () => {
    const db = build({ articles: [] });
    const copy = new SQL.Database();
    open.push(copy);
    copy.exec('CREATE TABLE article (id TEXT)');

    expect(() => copyIntoAttached(db, copy)).toThrow();
    expect(attached(db)).toEqual(['main', 'temp']);
    expect(INCOMING_SCHEMA).not.toBe('main');
  });
});

describe('openIncoming', () => {
  it("migrates an older plugin version's file, whose rows read as unstamped", () => {
    // As 0.6 wrote it: before the rebind table and the write stamp
    const old = build({
      articles: [
        { id: 'k0', reference: 'n0.md', updated_at: 0, updated_by: '' },
      ],
    });
    old.exec(
      'DROP TABLE rebind; DROP TABLE write_stamp; PRAGMA user_version = 9'
    );

    const copy = openIncoming(SQL, old.export(), migrations);
    open.push(copy);

    expect(copy.exec('PRAGMA user_version')[0].values[0][0]).toBe(
      migrations[migrations.length - 1].version
    );
    expect(articles(copy).map((r) => [r.id, ...stamp(r)])).toEqual([
      ['k0', 0, ''],
    ]);
  });

  /** sql.js whose databases answer `integrity_check` with `answer`. */
  function checkingAs(answer: SqlValue[][] | null): SqlJsStatic {
    class Checked extends SQL.Database {
      override exec(sql: string, params?: BindParams) {
        if (sql === 'PRAGMA integrity_check') {
          return answer
            ? [{ columns: ['integrity_check'], values: answer }]
            : [];
        }
        return super.exec(sql, params);
      }
    }
    return { ...SQL, Database: Checked } as unknown as SqlJsStatic;
  }

  it.each([
    { name: 'a fault', answer: [['page 2 is never used']], said: /page 2/ },
    { name: 'no rows', answer: [], said: /integrity_check failed/ },
    { name: 'no result', answer: null, said: /integrity_check failed/ },
  ])(
    'refuses a file whose integrity check reports $name, closing it',
    ({ answer, said }) => {
      const bytes = build({ articles: [] }).export();
      const close = vi.spyOn(SQL.Database.prototype, 'close');

      expect(() => openIncoming(checkingAs(answer), bytes, migrations)).toThrow(
        said
      );
      expect(close).toHaveBeenCalledOnce();
      close.mockRestore();
    }
  );

  it('refuses a damaged file', () => {
    const bytes = build({
      articles: [
        { id: 'k0', reference: 'n0.md', updated_at: 1, updated_by: 'a' },
      ],
    }).export();
    // Scribble over the second page, where the tables begin
    bytes.fill(0xff, 4096 + 8, 4096 + 64);

    expect(() => openIncoming(SQL, bytes, migrations)).toThrow();
  });

  it('refuses a file whose migration fails', () => {
    const bytes = build({ articles: [] }).export();
    const failing = [
      ...migrations,
      {
        version: 999,
        description: 'fails',
        up: () => {
          throw new Error('no');
        },
      },
    ];

    expect(() => openIncoming(SQL, bytes, failing)).toThrow(/Migration 999/);
  });
});
