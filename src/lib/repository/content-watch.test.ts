import fc from 'fast-check';
import { readFileSync } from 'fs';
import initSqlJs, { type Database, type SqlValue } from 'sql.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ContentWatch } from './content-watch';
import { bumpWriteStamp } from './write-stamp';

// #region HELPERS

let SQL: initSqlJs.SqlJsStatic;

beforeAll(async () => {
  const wasmBinary = readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
  SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
});

/** A database with a stamped table `t`, holding the row `a` with x = 1. */
function makeDb(): Database {
  const db = new SQL.Database();
  db.exec(`
    CREATE TABLE t (
      id TEXT PRIMARY KEY, x INTEGER, y TEXT, updated_at INTEGER, updated_by TEXT
    );
    INSERT INTO t (id, x, y, updated_at, updated_by) VALUES ('a', 1, NULL, 0, 'me');
  `);
  return db;
}

/** Whether running `sql` on `db` counts as a change. */
function changes(watch: ContentWatch, db: Database, sql: string): boolean {
  const mark = watch.mark(db);
  expect(mark).not.toBeNull();
  db.exec(sql);
  return watch.changedSince(db, mark);
}

/**
 * A database for arbitrary writes: `t` has a column of every affinity, one
 * that ignores case, and the stamps; `c` rows go when their `t` row does.
 */
function makeWideDb(): Database {
  const db = new SQL.Database();
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE t (
      id INTEGER PRIMARY KEY, n INTEGER, r REAL, s TEXT COLLATE NOCASE,
      b BLOB, updated_at INTEGER, updated_by TEXT
    );
    CREATE TABLE c (
      id INTEGER PRIMARY KEY,
      t_id INTEGER NOT NULL REFERENCES t(id) ON DELETE CASCADE
    );
    INSERT INTO t (id, n, s) VALUES (1, 1, 'a');
    INSERT INTO c VALUES (1, 1);
  `);
  return db;
}

/** What `makeWideDb` holds, stamps included. */
function content(db: Database): string {
  return JSON.stringify(
    db
      .exec(
        `SELECT 't', id, n, r, s, b, updated_at, updated_by FROM t
         UNION ALL SELECT 'c', id, t_id, NULL, NULL, NULL, NULL, NULL FROM c
         ORDER BY 1, 2`
      )
      .flatMap(({ values }) => values)
      .map((row) =>
        row.map((cell) => (cell instanceof Uint8Array ? [...cell] : cell))
      )
  );
}

interface Step {
  sql: string;
  params: SqlValue[];
  /** INSERT OR REPLACE, which counts even when it stores what was there. */
  replaces?: boolean;
}

const valueArb: fc.Arbitrary<SqlValue> = fc.oneof(
  fc.constant(null),
  fc.integer({ min: -2, max: 2 }),
  fc.constantFrom(0.5, -0, 1.0, 1e300),
  fc.constantFrom('a', 'A', 'a ', '1', ''),
  fc.constantFrom(new Uint8Array([1]), new Uint8Array([1, 0]), new Uint8Array())
);
const idArb = fc.integer({ min: 1, max: 3 });
const columnArb = fc.constantFrom('n', 'r', 's', 'b');

/** Every kind of write the repository makes, on a few rows and values. */
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.tuple(columnArb, valueArb, idArb).map(([column, value, id]) => ({
    sql: `UPDATE t SET ${column} = ? WHERE id = ?`,
    params: [value, id],
  })),
  fc.tuple(columnArb, valueArb).map(([column, value]) => ({
    sql: `UPDATE t SET ${column} = ?`,
    params: [value],
  })),
  fc.tuple(fc.integer(), idArb).map(([at, id]) => ({
    sql: `UPDATE t SET updated_at = ?, updated_by = 'x' || ? WHERE id = ?`,
    params: [at, at, id],
  })),
  fc.tuple(idArb, valueArb).map(([id, value]) => ({
    sql: `INSERT OR IGNORE INTO t (id, n) VALUES (?, ?)`,
    params: [id, value],
  })),
  fc.tuple(idArb, columnArb, valueArb).map(([id, column, value]) => ({
    sql: `INSERT INTO t (id, ${column}) VALUES (?, ?)
          ON CONFLICT(id) DO UPDATE SET ${column} = excluded.${column}`,
    params: [id, value],
  })),
  fc.tuple(idArb, valueArb).map(([id, value]) => ({
    sql: `INSERT OR REPLACE INTO t (id, n, r, s, b)
          SELECT ?, ?, r, s, b FROM t WHERE id = 1`,
    params: [id, value],
    replaces: true,
  })),
  idArb.map((id) => ({ sql: `DELETE FROM t WHERE id = ?`, params: [id] })),
  fc.tuple(idArb, idArb).map(([id, tId]) => ({
    sql: `INSERT OR IGNORE INTO c (id, t_id) SELECT ?, id FROM t WHERE id = ?`,
    params: [id, tId],
  })),
  idArb.map((id) => ({ sql: `DELETE FROM c WHERE id = ?`, params: [id] }))
);

/** One write as the repository makes it: statements, maybe rolled back. */
const writeArb = fc.record({
  steps: fc.array(stepArb, { minLength: 1, maxLength: 4 }),
  rollback: fc.boolean(),
  /** Whether a save reopened the connection before it. */
  saved: fc.boolean(),
});

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ContentWatch', () => {
  it.each([
    ['an update to the same value', `UPDATE t SET x = 1 WHERE id = 'a'`, false],
    ['an update of NULL to NULL', `UPDATE t SET y = NULL`, false],
    ['an update matching no row', `UPDATE t SET x = 2 WHERE id = 'zz'`, false],
    ['an ignored insert', `INSERT OR IGNORE INTO t (id) VALUES ('a')`, false],
    [
      'an upsert storing what is there',
      `INSERT INTO t (id, x) VALUES ('a', 1) ON CONFLICT(id) DO UPDATE SET x = excluded.x`,
      false,
    ],
    ['a read', `SELECT * FROM t`, false],
    [
      'a stamp kept as it is',
      `UPDATE t SET updated_at = 0, updated_by = 'me'`,
      false,
    ],
    ['a stamp alone', `UPDATE t SET updated_at = 5, updated_by = 'you'`, true],
    ['an update to a new value', `UPDATE t SET x = 2 WHERE id = 'a'`, true],
    ['NULL to a value', `UPDATE t SET y = 'v'`, true],
    ['a value to NULL', `UPDATE t SET x = NULL`, true],
    ['a stamp with a change', `UPDATE t SET x = 3, updated_at = 9`, true],
    ['an insert', `INSERT INTO t (id) VALUES ('b')`, true],
    ['a delete', `DELETE FROM t`, true],
    ['a new table', `CREATE TABLE u (v)`, true],
    ['a new column', `ALTER TABLE t ADD COLUMN z`, true],
  ])('counts %s as a change: %s', (_, sql, expected) => {
    expect(changes(new ContentWatch(), makeDb(), sql)).toBe(expected);
  });

  it('counts a write iff a statement changed what the database holds', () => {
    fc.assert(
      fc.property(fc.array(writeArb, { maxLength: 12 }), (writes) => {
        const db = makeWideDb();
        const watch = new ContentWatch();
        for (const { steps, rollback, saved } of writes) {
          if (saved) {
            db.export();
            db.exec('PRAGMA foreign_keys = ON');
          }
          const mark = watch.mark(db);
          expect(mark).not.toBeNull();
          db.exec('BEGIN');
          // Whether any statement changed what the database holds, even one
          // a later statement or the rollback undid
          let stepChanged = false;
          for (const { sql, params } of steps) {
            const prior = content(db);
            db.run(sql, params);
            if (content(db) !== prior) stepChanged = true;
          }
          db.exec(rollback ? 'ROLLBACK' : 'COMMIT');
          const changed = watch.changedSince(db, mark);

          if (stepChanged || !steps.some((step) => step.replaces)) {
            expect(changed).toBe(stepChanged);
          }
        }
      }),
      { numRuns: 300 }
    );
  });

  it('counts a change of case in a column that ignores case', () => {
    const db = makeWideDb();

    expect(changes(new ContentWatch(), db, `UPDATE t SET s = 'A'`)).toBe(true);
  });

  it('counts each changed update, and only those, over any sequence', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 2 }), { maxLength: 15 }),
        fc.array(fc.boolean(), { maxLength: 15 }),
        (values, exports) => {
          const db = makeDb();
          const watch = new ContentWatch();
          let current = 1;
          let expected = 0;
          let counted = 0;
          values.forEach((x, i) => {
            // A save reopens the connection: what watched it goes with it
            if (exports[i]) db.export();
            if (x !== current) expected++;
            current = x;
            if (changes(watch, db, `UPDATE t SET x = ${x}`)) counted++;
          });
          expect(counted).toBe(expected);
        }
      )
    );
  });

  it('watches a column added after it began', () => {
    const db = makeDb();
    const watch = new ContentWatch();
    changes(watch, db, `ALTER TABLE t ADD COLUMN z`);

    expect(changes(watch, db, `UPDATE t SET z = z`)).toBe(false);
    expect(changes(watch, db, `UPDATE t SET z = 4`)).toBe(true);
  });

  it('watches a database swapped in for the last one', () => {
    const watch = new ContentWatch();
    changes(watch, makeDb(), `UPDATE t SET x = 2`);
    const swapped = makeDb();

    expect(changes(watch, swapped, `UPDATE t SET x = 1`)).toBe(false);
    expect(changes(watch, swapped, `UPDATE t SET x = 5`)).toBe(true);
  });

  it('watches tables with awkward names, and a table of stamps alone', () => {
    const db = new SQL.Database();
    db.exec(`
      CREATE TABLE "it's ""odd""" (k TEXT, "v'v" INTEGER);
      INSERT INTO "it's ""odd""" VALUES ('a', 1);
      CREATE TABLE stamps (updated_at INTEGER, updated_by TEXT);
    `);
    const watch = new ContentWatch();

    expect(changes(watch, db, `UPDATE "it's ""odd""" SET "v'v" = 1`)).toBe(
      false
    );
    expect(changes(watch, db, `UPDATE "it's ""odd""" SET "v'v" = 2`)).toBe(
      true
    );
    expect(changes(watch, db, `INSERT INTO stamps VALUES (1, 'me')`)).toBe(
      true
    );
    expect(changes(watch, db, `UPDATE stamps SET updated_at = 1`)).toBe(false);
    expect(changes(watch, db, `UPDATE stamps SET updated_at = 2`)).toBe(true);
  });

  it('counts no bump of the write stamp, as `save()` makes before it exports, while still counting other tables', () => {
    const db = makeDb();
    db.exec(
      'CREATE TABLE write_stamp (device TEXT NOT NULL PRIMARY KEY, generation INTEGER NOT NULL)'
    );
    const watch = new ContentWatch();

    for (const now of [1, 1, 5]) {
      const mark = watch.mark(db);
      bumpWriteStamp(db, 'me', now);
      expect(watch.changedSince(db, mark)).toBe(false);
    }
    expect(changes(watch, db, `UPDATE t SET x = 2`)).toBe(true);
  });

  it('keeps its triggers out of the saved file', () => {
    const db = makeDb();
    changes(new ContentWatch(), db, `UPDATE t SET x = 2`);

    const saved = new SQL.Database(db.export());

    expect(
      saved.exec(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)
    ).toEqual([]);
  });

  it('builds its triggers once per connection and schema', () => {
    const db = makeDb();
    const watch = new ContentWatch();
    const createFunction = vi.spyOn(db, 'create_function');

    changes(watch, db, `UPDATE t SET x = 2`);
    changes(watch, db, `UPDATE t SET x = 3`);
    expect(createFunction).toHaveBeenCalledTimes(1);

    changes(watch, db, `CREATE TABLE u (v)`);
    changes(watch, db, `INSERT INTO u VALUES (1)`);
    expect(createFunction).toHaveBeenCalledTimes(2);
    // Rebuilt, not doubled: one set of triggers for each of t and u
    expect(
      db.exec(
        `SELECT count(*) FROM temp.sqlite_master WHERE type = 'trigger'`
      )[0].values[0][0]
    ).toBe(6);
  });

  it('rebuilds triggers something dropped', () => {
    const db = makeDb();
    const watch = new ContentWatch();
    changes(watch, db, `UPDATE t SET x = 2`);
    db.exec(`DROP TRIGGER temp."ir_content_0_UPDATE"`);

    expect(changes(watch, db, `UPDATE t SET x = 2`)).toBe(false);
    expect(changes(watch, db, `UPDATE t SET x = 3`)).toBe(true);
  });

  it('takes every write as a change on a database it cannot read', () => {
    const stub = { exec: vi.fn(() => []) } as unknown as Database;
    const watch = new ContentWatch();

    const mark = watch.mark(stub);

    expect(mark).toBeNull();
    expect(watch.changedSince(stub, mark)).toBe(true);
  });

  it('takes every write as a change when watching fails, and says so', () => {
    const db = makeDb();
    vi.spyOn(db, 'create_function').mockImplementation(() => {
      throw new Error('no functions here');
    });
    const error = vi.spyOn(console, 'error').mockReturnValue(undefined);
    const watch = new ContentWatch();

    const mark = watch.mark(db);
    db.exec(`UPDATE t SET x = 1`);

    expect(mark).toBeNull();
    expect(watch.changedSince(db, mark)).toBe(true);
    expect(error).toHaveBeenCalledOnce();
  });

  it('takes a write as a change when the schema can no longer be read', () => {
    const db = makeDb();
    const watch = new ContentWatch();
    const mark = watch.mark(db);
    vi.spyOn(db, 'exec').mockImplementation(() => {
      throw new Error('closed');
    });

    expect(watch.changedSince(db, mark)).toBe(true);
  });
});
