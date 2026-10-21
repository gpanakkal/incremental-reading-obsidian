import { DEVICE_ID_KEY } from '#/lib/device-id';
import type { DataChangeEvent } from '#/lib/types';
import type { Primitive } from '#/lib/utility-types';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import type { App } from 'obsidian';
import { resolve } from 'path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  armRowStamps,
  disarmRowStamps,
  STAMP_COLUMNS,
  SYNCED_TABLES,
  withHardDeletesAllowed,
} from './row-stamps';
import { SQLJSRepository } from './SQLJSRepository';

// #region HELPERS

const SCHEMA = readFileSync(resolve(__dirname, '../../db/schema.sql'), 'utf-8');
const DEVICE = 'device-a';

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

/** A repository over a fresh database, its stamps drawn from `clock`. */
class StampingRepository extends SQLJSRepository {
  static make(
    clock: () => number,
    { app, deviceId }: { app?: object; deviceId?: string } = {
      deviceId: DEVICE,
    }
  ) {
    const repo = new StampingRepository({
      app: (app ?? { vault: { adapter: {} } }) as unknown as App,
      dbFilePath: 'ir-test.sqlite',
      schema: SCHEMA,
      deviceId,
      stampClock: clock,
    });
    repo.db = new SQL.Database();
    repo.db.exec(SCHEMA);
    repo.registerUpdateHook();
    return repo;
  }

  protected override async save() {}

  get database(): Database {
    return this.db!;
  }

  /** Rows changed by the last statement, as SQLite counts them. */
  rowsModified(): number {
    return this.database.getRowsModified();
  }
}

/** Every row of every synced table, keyed `table:id`. */
function snapshot(db: Database) {
  const rows = new Map<
    string,
    { content: string; updated_at: number; updated_by: string }
  >();
  for (const table of SYNCED_TABLES) {
    const [result] = db.exec(`SELECT * FROM ${table}`);
    for (const values of result?.values ?? []) {
      const row = Object.fromEntries(
        result.columns.map((column, i) => [column, values[i]])
      );
      const { updated_at, updated_by, ...content } = row;
      const key = `${table}:${String(row.id ?? row.article_id)}`;
      rows.set(key, {
        content: JSON.stringify(content),
        updated_at: updated_at as number,
        updated_by: updated_by as string,
      });
    }
  }
  return rows;
}

const ARTICLES = ['a0', 'a1', 'a2'];
const SNIPPETS = ['s0', 's1'];
const CARDS = ['c0', 'c1'];

/** A world with a few rows of every synced table, all unstamped. */
function seed(db: Database) {
  disarmRowStamps(db);
  for (const id of ARTICLES) {
    db.run(
      `INSERT INTO article (id, reference, due, interval, priority) VALUES (?, ?, 0, 1, 30)`,
      [id, `n/${id}.md`]
    );
    db.run(
      `INSERT INTO article_review (id, article_id, review_time) VALUES (?, ?, 0)`,
      [`r-${id}`, id]
    );
    db.run(
      `INSERT INTO rebind (article_id, old_reference, new_reference, rebound_at) VALUES (?, 'old', 'new', 0)`,
      [id]
    );
  }
  for (const id of SNIPPETS) {
    db.run(
      `INSERT INTO snippet (id, reference, due, interval, priority) VALUES (?, ?, 0, 1, 30)`,
      [id, `s/${id}.md`]
    );
    db.run(
      `INSERT INTO snippet_review (id, snippet_id, review_time) VALUES (?, ?, 0)`,
      [`r-${id}`, id]
    );
  }
  for (const id of CARDS) {
    db.run(
      `INSERT INTO srs_card (id, reference, created_at, due, stability, difficulty, elapsed_days, scheduled_days, state) VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0)`,
      [id, `c/${id}.md`]
    );
    db.run(
      `INSERT INTO srs_card_review (id, card_id, due, review, stability, difficulty, elapsed_days, last_elapsed_days, scheduled_days, rating, state) VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 1, 0)`,
      [`r-${id}`, id]
    );
  }
}

/** A write to one row of the seeded world, by the app's own `mutate`. */
const writeArb = fc.oneof(
  fc.record({
    sql: fc.constant('UPDATE article SET priority = $1 WHERE id = $2'),
    params: fc.tuple(fc.constantFrom(10, 30, 50), fc.constantFrom(...ARTICLES)),
  }),
  fc.record({
    sql: fc.constant('UPDATE snippet SET due = $1 WHERE id = $2'),
    params: fc.tuple(fc.constantFrom(0, 1), fc.constantFrom(...SNIPPETS)),
  }),
  fc.record({
    sql: fc.constant('UPDATE srs_card SET stability = $1 WHERE id = $2'),
    params: fc.tuple(fc.constantFrom(0, 0.5), fc.constantFrom(...CARDS)),
  }),
  fc.record({
    sql: fc.constantFrom(
      'UPDATE article_review SET deleted = $1 WHERE article_id = $2',
      'UPDATE rebind SET deleted = $1 WHERE article_id = $2',
      'UPDATE article SET deleted = $1 WHERE id = $2'
    ),
    params: fc.tuple(fc.boolean(), fc.constantFrom(...ARTICLES)),
  }),
  fc.record({
    sql: fc.constantFrom(
      'UPDATE snippet_review SET deleted = $1 WHERE snippet_id = $2'
    ),
    params: fc.tuple(fc.boolean(), fc.constantFrom(...SNIPPETS)),
  }),
  fc.record({
    sql: fc.constantFrom(
      'UPDATE srs_card_review SET deleted = $1 WHERE card_id = $2'
    ),
    params: fc.tuple(fc.boolean(), fc.constantFrom(...CARDS)),
  }),
  // Every article at once, some of which may already hold the value
  fc.record({
    sql: fc.constant('UPDATE article SET dismissed = $1 WHERE $2 IS NOT NULL'),
    params: fc.tuple(fc.boolean(), fc.constant(1)),
  }),
  // A nullable column, to and from NULL
  fc.record({
    sql: fc.constant('UPDATE snippet SET parent = $1 WHERE id = $2'),
    params: fc.tuple(
      fc.constantFrom(null, ...ARTICLES),
      fc.constantFrom(...SNIPPETS)
    ),
  }),
  // Text, a change of case included
  fc
    .tuple(fc.constantFrom('', 'X', 'x'), fc.constantFrom(...CARDS))
    .map(([suffix, id]) => ({
      sql: 'UPDATE srs_card SET reference = $1 WHERE id = $2',
      params: [`c/${id}${suffix}.md`, id],
    })),
  // A row deleted for good, again and again
  fc.record({
    sql: fc.constant(
      `UPDATE article SET deleted = TRUE, reference = '/ir-deleted/' || id WHERE id = $1`
    ),
    params: fc.tuple(fc.constantFrom(...ARTICLES)),
  }),
  // An upsert onto a row that is there, as recording a rebind is
  fc.record({
    sql: fc.constant(
      `INSERT INTO rebind (article_id, old_reference, new_reference, rebound_at)
       VALUES ($1, 'old', $2, 0)
       ON CONFLICT (article_id) DO UPDATE SET
         new_reference = excluded.new_reference, deleted = FALSE`
    ),
    params: fc.tuple(
      fc.constantFrom(...ARTICLES),
      fc.constantFrom('new', 'other')
    ),
  }),
  fc.record({
    sql: fc.constant(
      `INSERT INTO article_review (id, article_id, review_time) VALUES ($1, 'a0', $2)`
    ),
    params: fc.tuple(fc.uuid(), fc.nat()),
  })
);

// #endregion

describe('armRowStamps', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('property: stamps every row a write changes with a later time and this device, however the clock moves, and no other row', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            write: writeArb,
            // Wall clocks jump back as well as forward
            now: fc.integer({ min: -(2 ** 40), max: 2 ** 41 }),
          }),
          { minLength: 1, maxLength: 25 }
        ),
        (steps) => {
          let clock = 0;
          const repo = StampingRepository.make(() => clock);
          seed(repo.database);
          armRowStamps(repo.database, {
            deviceId: () => DEVICE,
            now: () => clock,
          });

          for (const { write, now } of steps) {
            clock = now;
            const before = snapshot(repo.database);
            repo.mutate(write.sql, write.params as Primitive[]);
            const changed = repo.rowsModified();
            const after = snapshot(repo.database);

            let contentChanges = 0;
            for (const [key, row] of after) {
              const was = before.get(key);
              if (was && was.content === row.content) {
                expect(row.updated_at).toBe(was.updated_at);
                expect(row.updated_by).toBe(was.updated_by);
                continue;
              }
              contentChanges++;
              expect(row.updated_at).toBeGreaterThan(was?.updated_at ?? 0);
              expect(row.updated_at).toBeGreaterThanOrEqual(now);
              expect(row.updated_by).toBe(DEVICE);
            }
            // A row written with the values it held is no row modified
            expect(changed).toBe(contentChanges);
          }
          repo.database.close();
        }
      ),
      { numRuns: 60 }
    );
  });

  it('property: a write of the values a row already holds changes no stamp, counts no row, and reports no change', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(10, 30, 50),
        fc.boolean(),
        fc.nat(),
        (priority, dismissed, now) => {
          const repo = StampingRepository.make(() => now);
          repo.mutate(
            'INSERT INTO article (id, reference, due, interval, priority, dismissed) VALUES ($1, $2, 0, 1, $3, $4)',
            ['a', 'n/a.md', priority, dismissed]
          );
          const before = snapshot(repo.database);
          const listener = vi.fn<(event: DataChangeEvent) => void>();
          repo.onDataChange(listener);

          repo.mutate(
            'UPDATE article SET priority = $1, dismissed = $2 WHERE id = $3',
            [priority, dismissed, 'a']
          );

          expect(repo.rowsModified()).toBe(0);
          expect(snapshot(repo.database)).toEqual(before);
          expect(listener).not.toHaveBeenCalled();
          repo.database.close();
        }
      ),
      { numRuns: 30 }
    );
  });

  it('takes a change of case to a column with its own collation for a change', () => {
    const db = new SQL.Database();
    db.exec(
      `CREATE TABLE article (id TEXT PRIMARY KEY, title TEXT COLLATE NOCASE,
         updated_at INTEGER NOT NULL DEFAULT 0, updated_by TEXT NOT NULL DEFAULT '');
       INSERT INTO article (id, title) VALUES ('a', 'title');`
    );
    armRowStamps(db, { deviceId: () => DEVICE, now: () => 100 });

    db.run(`UPDATE article SET title = 'Title'`);

    expect(db.getRowsModified()).toBe(1);
    expect(db.exec(`SELECT title, updated_at FROM article`)[0].values).toEqual([
      ['Title', 100],
    ]);
    db.close();
  });

  it('stamps an inserted row with the clock and this device, and reports it inserted alone', () => {
    const repo = StampingRepository.make(() => 1234);
    const listener = vi.fn<(event: DataChangeEvent) => void>();
    repo.onDataChange(listener);

    repo.mutate(
      `INSERT INTO article (id, reference, due, interval, priority) VALUES ('a', 'n/a.md', 0, 1, 30)`
    );

    expect(snapshot(repo.database).get('article:a')).toMatchObject({
      updated_at: 1234,
      updated_by: DEVICE,
    });
    // The stamp the trigger writes is no second change
    expect(listener.mock.calls).toEqual([
      [{ table: 'article', op: 'insert', ids: ['a'] }],
    ]);
  });

  it('keeps a stamp the write gives itself, as copying another device’s row will', () => {
    const repo = StampingRepository.make(() => 5000);
    repo.mutate(
      `INSERT INTO article (id, reference, due, interval, priority, updated_at, updated_by)
       VALUES ('a', 'n/a.md', 0, 1, 30, 7, 'device-b')`
    );
    expect(snapshot(repo.database).get('article:a')).toMatchObject({
      updated_at: 7,
      updated_by: 'device-b',
    });

    repo.mutate(
      `UPDATE article SET priority = 40, updated_at = 9, updated_by = 'device-c' WHERE id = 'a'`
    );
    expect(snapshot(repo.database).get('article:a')).toMatchObject({
      updated_at: 9,
      updated_by: 'device-c',
    });

    // Its own stamp, changed alone, is a change too
    repo.mutate(`UPDATE article SET updated_by = 'device-d' WHERE id = 'a'`);
    expect(repo.rowsModified()).toBe(1);
  });

  it('stamps a row left unstamped by the migration on its first write', () => {
    const repo = StampingRepository.make(() => 42);
    seed(repo.database);
    armRowStamps(repo.database, { deviceId: () => DEVICE, now: () => 42 });
    expect(snapshot(repo.database).get('article:a0')?.updated_at).toBe(0);

    repo.mutate(`UPDATE article SET priority = 40 WHERE id = 'a0'`);

    expect(snapshot(repo.database).get('article:a0')).toMatchObject({
      updated_at: 42,
      updated_by: DEVICE,
    });
  });

  it('draws the device from localStorage once, however many rows it stamps', () => {
    const stored = new Map<string, unknown>([[DEVICE_ID_KEY, 'stored-id']]);
    const app = {
      vault: { adapter: {} },
      loadLocalStorage: vi.fn((key: string) => stored.get(key) ?? null),
      saveLocalStorage: vi.fn(),
    };
    const repo = StampingRepository.make(() => 1, { app });

    for (const id of ARTICLES) {
      repo.mutate(
        `INSERT INTO article (id, reference, due, interval, priority) VALUES ($1, $2, 0, 1, 30)`,
        [id, `n/${id}.md`]
      );
    }

    expect(
      [...snapshot(repo.database).values()].map((row) => row.updated_by)
    ).toEqual(ARTICLES.map(() => 'stored-id'));
    expect(app.loadLocalStorage).toHaveBeenCalledOnce();
  });

  it('arms nothing on a database whose tables have no stamp columns yet', () => {
    const db = new SQL.Database();
    db.exec(
      `CREATE TABLE article (id TEXT PRIMARY KEY, priority INTEGER);
       INSERT INTO article VALUES ('a', 1);`
    );
    const createFunction = vi.spyOn(db, 'create_function');

    armRowStamps(db, { deviceId: () => DEVICE, now: () => 1 });

    expect(createFunction).not.toHaveBeenCalled();
    expect(db.exec(`SELECT name FROM sqlite_temp_master`)).toEqual([]);
    db.run(`UPDATE article SET priority = 1`);
    expect(db.getRowsModified()).toBe(1);
    db.close();
  });

  it('arms no table that has only half a stamp', () => {
    const db = new SQL.Database();
    db.exec(
      `CREATE TABLE article (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL DEFAULT 0);
       CREATE TABLE snippet (id TEXT PRIMARY KEY, updated_by TEXT NOT NULL DEFAULT '');`
    );

    armRowStamps(db, { deviceId: () => DEVICE, now: () => 1 });

    expect(db.exec(`SELECT name FROM sqlite_temp_master`)).toEqual([]);
    db.close();
  });

  it('arms the tables that have them, and covers a column added since when armed again', () => {
    const db = new SQL.Database();
    db.exec(
      `CREATE TABLE article (id TEXT PRIMARY KEY, priority INTEGER,
         updated_at INTEGER NOT NULL DEFAULT 0, updated_by TEXT NOT NULL DEFAULT '');
       CREATE TABLE snippet (id TEXT PRIMARY KEY, priority INTEGER);
       INSERT INTO article (id, priority) VALUES ('a', 1);`
    );
    const source = { deviceId: () => DEVICE, now: () => 100 };
    armRowStamps(db, source);
    expect(
      db
        .exec(`SELECT tbl_name FROM sqlite_temp_master`)[0]
        .values.map(([table]) => table)
    ).toEqual(['article', 'article', 'article', 'article']);

    db.exec(`ALTER TABLE article ADD COLUMN extra INTEGER`);
    armRowStamps(db, source);
    db.run(`UPDATE article SET extra = 5`);

    expect(db.exec(`SELECT updated_at FROM article`)[0].values).toEqual([
      [100],
    ]);
    db.close();
  });

  it('takes every trigger off again when disarmed', () => {
    const repo = StampingRepository.make(() => 1);

    disarmRowStamps(repo.database);

    expect(repo.database.exec(`SELECT name FROM sqlite_temp_master`)).toEqual(
      []
    );
    repo.mutate(
      `INSERT INTO article (id, reference, due, interval, priority) VALUES ('a', 'n/a.md', 0, 1, 30)`
    );
    expect(snapshot(repo.database).get('article:a')?.updated_at).toBe(0);
  });

  it.each(SYNCED_TABLES)(
    'refuses to delete a row of %s, keeping every row',
    (table) => {
      const repo = StampingRepository.make(() => 1);
      seed(repo.database);
      armRowStamps(repo.database, { deviceId: () => DEVICE, now: () => 1 });
      repo.database.exec('PRAGMA foreign_keys = ON');
      const before = snapshot(repo.database);

      expect(() => repo.mutate(`DELETE FROM ${table}`)).toThrow();

      expect(snapshot(repo.database)).toEqual(before);
    }
  );

  it('refuses a delete by cascade, too', () => {
    const repo = StampingRepository.make(() => 1);
    seed(repo.database);
    armRowStamps(repo.database, { deviceId: () => DEVICE, now: () => 1 });
    repo.database.exec('PRAGMA foreign_keys = ON');
    // Only the review log's guard stands between the item and the cascade
    repo.database.exec('DROP TRIGGER temp.ir_stamp_article_delete');

    expect(() =>
      repo.database.run(`DELETE FROM article WHERE id = 'a0'`)
    ).toThrow();
    expect(snapshot(repo.database).has('article:a0')).toBe(true);
  });

  it('deletes inside withHardDeletesAllowed, and refuses again after it', () => {
    const repo = StampingRepository.make(() => 7);
    const db = repo.database;
    seed(db);
    const source = { deviceId: () => DEVICE, now: () => 7 };
    armRowStamps(db, source);

    const result = withHardDeletesAllowed(db, source, () => {
      db.run(`DELETE FROM article_review WHERE id = 'r-a0'`);
      return 'done';
    });

    expect(result).toBe('done');
    expect(snapshot(db).has('article_review:r-a0')).toBe(false);
    expect(() => db.run(`DELETE FROM article_review`)).toThrow();
    db.run(`UPDATE article SET priority = 40 WHERE id = 'a1'`);
    expect(snapshot(db).get('article:a1')).toMatchObject({
      updated_at: 7,
      updated_by: DEVICE,
    });
  });

  it('refuses again after withHardDeletesAllowed, even when its work throws', () => {
    const repo = StampingRepository.make(() => 1);
    const db = repo.database;
    seed(db);
    const source = { deviceId: () => DEVICE, now: () => 1 };

    expect(() =>
      withHardDeletesAllowed(db, source, () => {
        throw new Error('boom');
      })
    ).toThrow('boom');

    expect(() => db.run(`DELETE FROM snippet`)).toThrow();
  });

  it('names the stamp columns the schema gives every synced table', () => {
    const repo = StampingRepository.make(() => 1);
    for (const table of SYNCED_TABLES) {
      const columns = repo.database
        .exec(`PRAGMA table_info(${table})`)[0]
        .values.map((row) => row[1]);
      expect(columns).toEqual(expect.arrayContaining([...STAMP_COLUMNS]));
      expect(columns).toContain('deleted');
    }
  });
});
