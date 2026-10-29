import { migrations } from '#/db/migrations';
import IRScheduler from '#/lib/IRScheduler';
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
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  copyIntoAttached,
  fuzzDueBy,
  fuzzTakenOn,
  INCOMING_SCHEMA,
  MERGE_TABLES,
  mergeInto,
  mergeUnlessLossy,
  openIncoming,
  previewMerge,
  type MergeReport,
} from './row-merge';
import { armRowStamps, SYNCED_TABLES, type StampSource } from './row-stamps';
import { type ReplaySettings } from './scheduling-replay';

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

/**
 * When the merges and take-ons that fuzz run (pinned with fake timers): noon
 * of a review day, by the local clock, as the queue's review days go.
 */
const NOW = new Date(2026, 9, 25, 12).getTime();
const HOUR = 60 * 60 * 1000;
/** The end of the review day {@link NOW} falls in, under a +4h rollover. */
const DUE_BY = new Date(2026, 9, 26, 4).getTime();
/** The settings of a device that fuzzes, with a +4h rollover. */
const FUZZING: ReplaySettings = {
  fsrsParams: {},
  fuzzTextReviews: true,
  dayRolloverOffset: 4,
};

/** An article or snippet row, for merges that fuzz the rows they bring. */
interface TextRow {
  id: string;
  reference: string;
  /** Mostly either side of {@link DUE_BY}, to tell due rows from the rest. */
  due: number;
  due_fuzz: number | null;
  deleted: number;
  /** Even in this device's copy, odd in the other's: where a row came from. */
  scroll_top: number;
  updated_at: number;
  updated_by: string;
}

/** A copy of the item tables, cards included, with any fuzz or none. */
interface TextCopy {
  article: TextRow[];
  snippet: TextRow[];
  cards: {
    id: string;
    reference: string;
    updated_at: number;
    updated_by: string;
  }[];
  writeStamp: Record<string, number>;
}

/** A database holding `copy`, its stamps exactly as given. */
function buildTexts(copy: TextCopy, armed = false): Database {
  const db = build({ articles: [], writeStamp: copy.writeStamp });
  for (const table of ['article', 'snippet'] as const) {
    for (const r of copy[table]) {
      db.run(
        `INSERT INTO ${table} (id, reference, due, due_fuzz, interval,
           priority, deleted, scroll_top, updated_at, updated_by)
         VALUES (?, ?, ?, ?, 1, 30, ?, ?, ?, ?)`,
        [
          r.id,
          r.reference,
          r.due,
          r.due_fuzz,
          r.deleted,
          r.scroll_top,
          r.updated_at,
          r.updated_by,
        ]
      );
    }
  }
  for (const c of copy.cards) {
    db.run(
      `INSERT INTO srs_card (id, reference, created_at, due, stability,
         difficulty, elapsed_days, scheduled_days, state, updated_at,
         updated_by) VALUES (?, ?, 1, 1, 1, 1, 0, 0, 0, ?, ?)`,
      [c.id, c.reference, c.updated_at, c.updated_by]
    );
  }
  if (armed) armRowStamps(db, THIS_DEVICE);
  return db;
}

/** Merge `theirs` into `mine` as a device that replays with `replay`. */
function mergedTexts(
  mine: TextCopy,
  theirs: TextCopy,
  replay?: ReplaySettings
): { db: Database; report: MergeReport } {
  const db = buildTexts(mine, true);
  const source = buildTexts(theirs);
  const copy = openIncoming(SQL, source.export(), migrations);
  open.push(copy);
  const report = mergeInto(db, copy, THIS_DEVICE, replay);
  return { db, report };
}

/** Copies of the item tables with `rows` as their articles, nothing else. */
function articlesOf(...rows: TextRow[]): TextCopy {
  return { article: rows, snippet: [], cards: [], writeStamp: {} };
}

/**
 * One copy of the item tables, from small pools of keys, references and
 * stamps (this device's among them) so that both copies often hold one row,
 * stamped alike or not, live or a tombstone, fuzzed or not. `parity` marks
 * each row's `scroll_top` with the copy it is from.
 */
const textCopyArb = (parity: 0 | 1): fc.Arbitrary<TextCopy> => {
  const rowsArb = (prefix: string) =>
    fc
      .uniqueArray(
        fc.record({
          id: fc.constantFrom(...KEYS),
          reference: fc.constantFrom(...REFERENCES),
          due: fc.constantFrom(
            DUE_BY - HOUR,
            DUE_BY,
            DUE_BY + 1,
            DUE_BY + HOUR
          ),
          due_fuzz: fc.option(fc.integer({ min: -3, max: 3 }), { nil: null }),
          deleted: fc.constantFrom(0, 1),
          scroll_top: fc.constantFrom(parity, parity + 2),
          updated_at: fc.nat(3),
          updated_by: fc.constantFrom('', 'a', 'here'),
        }),
        { selector: (r) => r.id, maxLength: KEYS.length }
      )
      .map((rows) => {
        // A copy holds each reference once, as UNIQUE makes it
        const seen = new Set<string>();
        return rows.map((r) => {
          const reference = seen.has(r.reference)
            ? `own/${r.id}.md`
            : r.reference;
          seen.add(reference);
          return { ...r, id: `${prefix}${r.id}`, reference };
        });
      });
  return fc.record({
    article: rowsArb('a-'),
    snippet: rowsArb('s-'),
    cards: fc
      .uniqueArray(
        fc.record({
          id: fc.constantFrom(...KEYS),
          reference: fc.constantFrom(...REFERENCES),
          updated_at: fc.nat(3),
          updated_by: fc.constantFrom('', 'a', 'here'),
        }),
        { selector: (c) => c.reference, maxLength: 3 }
      )
      .map((cards) => [...new Map(cards.map((c) => [c.id, c])).values()]),
    writeStamp: fc.dictionary(fc.constantFrom('a', 'here'), fc.nat(4)),
  });
};

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

  it('marks as fuzzed exactly the tables whose rows carry a due_fuzz', () => {
    const db = build({ articles: [] });
    for (const { name, fuzzed } of MERGE_TABLES) {
      const [info] = db.exec(`PRAGMA table_info(${name})`);
      const columns = info.values.map((row) => row[1]);
      expect(!!fuzzed).toBe(columns.includes('due_fuzz'));
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

describe('mergeInto, fuzzing the text rows it brings (0176)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A text row of {@link buildTexts} from the other copy, live, unfuzzed. */
  const theirRow = (due: number): TextRow => ({
    id: 'k0',
    reference: 'n0.md',
    due,
    due_fuzz: null,
    deleted: 0,
    scroll_top: 1,
    updated_at: 1,
    updated_by: 'a',
  });

  it('property: gives each live text row it takes from the other copy without fuzz the fuzz this device held for it, else, due by the end of the review day, a new one, as it does a row of its own, and changes nothing else', () => {
    fc.assert(
      fc.property(
        textCopyArb(0),
        textCopyArb(1),
        fc.boolean(),
        (mine, theirs, fuzzTextReviews) => {
          // Reset per case: afterEach runs once per `it`, and a failed case
          // (while shrinking, say) leaves its spy and its calls behind
          vi.restoreAllMocks();
          let drawn = 0;
          const draw = vi
            .spyOn(IRScheduler, 'getDueFuzz')
            .mockImplementation(() => 1000 + drawn++);
          const plain = mergedTexts(mine, theirs, {
            ...FUZZING,
            fuzzTextReviews: false,
          });
          expect(draw).not.toHaveBeenCalled();
          const unfuzzed = everything(plain.db);

          const merged = mergedTexts(mine, theirs, {
            ...FUZZING,
            fuzzTextReviews,
          });
          const fuzzed = everything(merged.db);

          // What the merge without fuzz gives, with the fuzz each row should get
          let fresh = 0;
          let kept = 0;
          const expected = { ...unfuzzed };
          for (const table of ['article', 'snippet'] as const) {
            const held = new Map(mine[table].map((r) => [r.id, r.due_fuzz]));
            expected[table] = unfuzzed[table].map((row) => {
              if (
                !fuzzTextReviews ||
                row.deleted !== 0 ||
                row.due_fuzz !== null
              ) {
                return row;
              }
              const fromTheirs = (row.scroll_top as number) % 2 === 1;
              const own = fromTheirs
                ? (held.get(row.id as string) ?? null)
                : null;
              // This device's fuzz for the row, due or not: no draw to save
              if (own !== null) return { ...row, due_fuzz: own };
              if ((row.due as number) > DUE_BY) return row;
              fresh++;
              // A row of this device's the merge leaves, written only for it
              if (!fromTheirs) kept++;
              return { ...row, due_fuzz: expect.any(Number) as number };
            });
          }
          expect(fuzzed).toEqual(expected);
          expect(draw).toHaveBeenCalledTimes(fresh);
          expect(merged.report).toEqual({
            ...plain.report,
            written: plain.report.written + kept,
          });
          // Each new fuzz is a draw of its own
          const draws = ['article', 'snippet']
            .flatMap((table) => fuzzed[table].map((row) => row.due_fuzz))
            .filter((fuzz) => (fuzz as number) >= 1000);
          expect(new Set(draws).size).toBe(fresh);
        }
      ),
      { numRuns: 200 }
    );
  }, 60_000);

  it('gives a row it brings without fuzz, not yet due, the fuzz this device held for it', () => {
    const draw = vi.spyOn(IRScheduler, 'getDueFuzz');
    const own = { ...theirRow(DUE_BY - HOUR), due_fuzz: 7, scroll_top: 0 };
    const theirs = { ...theirRow(DUE_BY + HOUR), updated_at: 2 };

    const { db } = mergedTexts(articlesOf(own), articlesOf(theirs), FUZZING);

    expect(rowsOf(db, 'article', 'id')[0]).toMatchObject({
      due: DUE_BY + HOUR,
      due_fuzz: 7,
      updated_at: 2,
    });
    expect(draw).not.toHaveBeenCalled();
  });

  it('leaves a row it brings that falls due after the review day without fuzz, and fuzzes it at the first merge after it falls due', () => {
    vi.spyOn(IRScheduler, 'getDueFuzz').mockReturnValue(9);
    const due = DUE_BY + 8 * HOUR;
    const db = buildTexts(articlesOf(), true);
    const copy = () => {
      const source = buildTexts(articlesOf(theirRow(due)));
      const incoming = openIncoming(SQL, source.export(), migrations);
      open.push(source, incoming);
      return incoming;
    };

    mergeInto(db, copy(), THIS_DEVICE, FUZZING);
    expect(rowsOf(db, 'article', 'id')[0].due_fuzz).toBeNull();

    // The next review day, the row due in it: the copy brings nothing new
    vi.setSystemTime(due + HOUR);
    const report = mergeInto(db, copy(), THIS_DEVICE, FUZZING);

    expect(rowsOf(db, 'article', 'id')[0]).toMatchObject({
      due_fuzz: 9,
      updated_at: 1,
      updated_by: 'a',
    });
    expect(report).toEqual({ replaced: 0, written: 1 });
  });

  it.each([
    [4, 9],
    [undefined, 9],
    [0, null],
    [-5, null],
  ])(
    'counts a row due at 02:00 as due by the end of the review day under a rollover offset of %s',
    (dayRolloverOffset, fuzz) => {
      vi.spyOn(IRScheduler, 'getDueFuzz').mockReturnValue(9);

      const { db } = mergedTexts(
        articlesOf(),
        articlesOf(theirRow(DUE_BY - 2 * HOUR)),
        { fsrsParams: {}, fuzzTextReviews: true, dayRolloverOffset }
      );

      expect(rowsOf(db, 'article', 'id')[0].due_fuzz).toBe(fuzz);
    }
  );

  it('fuzzes nothing given no settings to replay with', () => {
    const draw = vi.spyOn(IRScheduler, 'getDueFuzz');
    const row = theirRow(NOW);
    const { db } = mergedTexts(articlesOf(), {
      article: [row],
      snippet: [row],
      cards: [],
      writeStamp: {},
    });

    expect(rowsOf(db, 'article', 'id')[0].due_fuzz).toBeNull();
    expect(rowsOf(db, 'snippet', 'id')[0].due_fuzz).toBeNull();
    expect(draw).not.toHaveBeenCalled();
  });
});

describe('fuzzDueBy (0176)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { at: 'noon', now: NOW, dayRolloverOffset: 4, end: DUE_BY },
    { at: 'noon', now: NOW, dayRolloverOffset: undefined, end: DUE_BY },
    {
      at: 'noon',
      now: NOW,
      dayRolloverOffset: -5,
      end: new Date(2026, 9, 25, 19).getTime(),
    },
    // Before the rollover: still the day before
    {
      at: '03:00 the day after',
      now: new Date(2026, 9, 26, 3).getTime(),
      dayRolloverOffset: 4,
      end: DUE_BY,
    },
    {
      at: 'the rollover',
      now: DUE_BY,
      dayRolloverOffset: 4,
      end: new Date(2026, 9, 27, 4).getTime(),
    },
  ])(
    'at $at under a rollover offset of $dayRolloverOffset, is the end of the review day the queue counts as due',
    ({ now, dayRolloverOffset, end }) => {
      vi.setSystemTime(now);

      expect(fuzzDueBy({ dayRolloverOffset })).toBe(end);
    }
  );
});

describe('fuzzTakenOn (0176)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A text row of {@link buildTexts}, live, unfuzzed and due unless told. */
  const textRow = (id: string, over: Partial<TextRow> = {}): TextRow => ({
    id,
    reference: `${id}.md`,
    due: DUE_BY,
    due_fuzz: null,
    deleted: 0,
    scroll_top: 0,
    updated_at: 2,
    updated_by: 'a',
    ...over,
  });

  /** `rows` with each live unfuzzed one due by `dueBy` given a fuzz. */
  const fuzzedBy = (rows: Row[], dueBy: number) => {
    let fresh = 0;
    const expected = rows.map((row) => {
      if (
        row.deleted !== 0 ||
        row.due_fuzz !== null ||
        (row.due as number) > dueBy
      ) {
        return row;
      }
      fresh++;
      return { ...row, due_fuzz: expect.any(Number) as number };
    });
    return { expected, fresh };
  };

  it('property: gives each live text row due by the cutoff without fuzz a new one of its own, leaving stamps and every other row as they were, and at a later cutoff the rows that fell due since', () => {
    fc.assert(
      fc.property(textCopyArb(0), (copy) => {
        // Reset per case: afterEach runs once per `it`
        vi.restoreAllMocks();
        let drawn = 0;
        const draw = vi
          .spyOn(IRScheduler, 'getDueFuzz')
          .mockImplementation(() => 1000 + drawn++);
        const db = buildTexts(copy, true);
        let total = 0;

        // Again at one cutoff: nothing left; at a later one, what fell due
        for (const dueBy of [DUE_BY, DUE_BY, DUE_BY + HOUR]) {
          const before = everything(db);
          const expected = { ...before };
          let fresh = 0;
          for (const table of ['article', 'snippet'] as const) {
            const next = fuzzedBy(before[table], dueBy);
            expected[table] = next.expected;
            fresh += next.fresh;
          }

          expect(fuzzTakenOn(db, THIS_DEVICE, dueBy)).toBe(fresh);

          expect(everything(db)).toEqual(expected);
          total += fresh;
          expect(draw).toHaveBeenCalledTimes(total);
        }
        const after = everything(db);
        const draws = ['article', 'snippet']
          .flatMap((table) => after[table].map((row) => row.due_fuzz))
          .filter((fuzz) => (fuzz as number) >= 1000);
        expect(new Set(draws).size).toBe(total);
      }),
      { numRuns: 200 }
    );
  }, 60_000);

  it('arms the row stamps again after, so the next write is stamped', () => {
    const db = buildTexts(articlesOf(textRow('k0')), true);

    fuzzTakenOn(db, THIS_DEVICE, DUE_BY);
    db.run("UPDATE article SET priority = 40 WHERE id = 'k0'");

    expect(rowsOf(db, 'article', 'id')[0]).toMatchObject({
      updated_at: 1e12,
      updated_by: 'here',
    });
  });

  it('changes nothing, and arms the row stamps again, when a row fails', () => {
    const db = buildTexts(articlesOf(textRow('k0'), textRow('k1')), true);
    const before = everything(db);
    vi.spyOn(IRScheduler, 'getDueFuzz')
      .mockReturnValueOnce(5)
      .mockImplementationOnce(() => {
        throw new Error('no fuzz');
      });

    expect(() => fuzzTakenOn(db, THIS_DEVICE, DUE_BY)).toThrow('no fuzz');

    expect(everything(db)).toEqual(before);
    db.run("UPDATE article SET priority = 40 WHERE id = 'k0'");
    expect(rowsOf(db, 'article', 'id')[0]).toMatchObject({
      updated_by: 'here',
    });
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

describe('mergeUnlessLossy', () => {
  it('property: merges as mergeInto does, unless that would replace a row, then changes nothing', () => {
    fc.assert(
      fc.property(copyArb, copyArb, (mine, theirs) => {
        const db = build(mine, true);
        const before = everything(db);
        const copy = incoming(theirs);
        const { replaced } = previewMerge(db, copy);

        const report = mergeUnlessLossy(db, copy, THIS_DEVICE);

        if (replaced > 0) {
          expect(report).toBeNull();
          expect(everything(db)).toEqual(before);
        } else {
          const expected = merged(mine, theirs);
          expect(report).toEqual(expected.report);
          expect(everything(db)).toEqual(everything(expected.db));
        }
        expect(attached(db)).toEqual(['main', 'temp']);
        // Nor leaves its working tables behind, whichever it did
        expect(
          db.exec(
            "SELECT name FROM temp.sqlite_master WHERE name LIKE 'ir_merge%'"
          )
        ).toEqual([]);
      }),
      { numRuns: 200 }
    );
  }, 60_000);

  it('arms the stamp triggers again whether it merges or changes nothing', () => {
    // Unstamped copies of one row: the greater content wins, replacing this
    // device's row when the other copy holds it
    const holding = (priority: number): Copy => ({
      articles: [
        {
          id: 'k0',
          reference: 'n0.md',
          priority,
          updated_at: 0,
          updated_by: '',
        },
      ],
    });
    for (const [mine, theirs, lossy] of [
      [10, 50, true],
      [50, 10, false],
    ] as const) {
      const db = build(holding(mine), true);

      const report = mergeUnlessLossy(
        db,
        incoming(holding(theirs)),
        THIS_DEVICE
      );

      expect(report === null).toBe(lossy);
      db.run("UPDATE article SET priority = 20 WHERE id = 'k0'");
      expect(stamp(articles(db)[0])).toEqual([1e12, 'here']);
    }
  });
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
