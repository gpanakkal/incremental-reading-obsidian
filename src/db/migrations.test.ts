import {
  MAXIMUM_PRIORITY,
  MINIMUM_PRIORITY,
  MS_PER_DAY,
  TEXT_BASE_REVIEW_INTERVAL,
} from '#/lib/constants';
import type { ArticleRow } from '#/lib/types';
import type { SafeOmit } from '#/lib/utility-types';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Database, SqlJsStatic } from 'sql.js';
import initSqlJs from 'sql.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// migrations.ts imports `databaseSchema` via a custom esbuild plugin that
// handles `.sql` files as strings. Vitest doesn't use that plugin, so we
// mock the module before importing migrations.
const schemaPath = resolve(__dirname, 'schema.sql');
const schemaSQL = readFileSync(schemaPath, 'utf-8');

vi.mock('./schema.sql', () => ({ default: schemaSQL }));

// Import after the mock is registered
const { applyMigrations, getSchemaVersion, migrations, recreateTable } =
  await import('./migrations');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let SQL: SqlJsStatic;

beforeAll(async () => {
  const wasmPath = resolve(__dirname, 'sql-wasm.wasm');
  const wasmBinary = readFileSync(wasmPath);
  SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
});

/** Create a fresh in-memory database with the given schema SQL applied */
function makeDb(schema: string): Database {
  const db = new SQL.Database();
  db.exec(schema);
  return db;
}

/** Read all rows from a table as plain objects */
function selectAll(db: Database, table: string): Record<string, unknown>[] {
  const result = db.exec(`SELECT * FROM ${table}`);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map((row) =>
    Object.fromEntries(columns.map((col, i) => [col, row[i]]))
  );
}

function columnNames(db: Database, table: string): string[] {
  const result = db.exec(`PRAGMA table_info(${table})`);
  if (!result.length) return [];
  return result[0].values.map((row) => row[1] as string);
}

// ---------------------------------------------------------------------------
// Pre-migration schemas (the state before each migration was introduced)
// ---------------------------------------------------------------------------

/** Schema state before migration v1 (no start_offset / end_offset on snippet) */
const SCHEMA_V0 = `
  CREATE TABLE article (
    id TEXT NOT NULL,
    reference TEXT NOT NULL UNIQUE,
    due INTEGER,
    priority INTEGER NOT NULL,
    dismissed INTEGER DEFAULT 0,
    fixed_interval_days INTEGER NULL
  );
  CREATE TABLE snippet (
    id TEXT NOT NULL,
    reference TEXT NOT NULL UNIQUE,
    parent TEXT DEFAULT NULL,
    due INTEGER,
    priority INTEGER NOT NULL,
    dismissed INTEGER DEFAULT 0
  );
  CREATE TABLE article_review (
    id TEXT NOT NULL,
    article_id TEXT NOT NULL REFERENCES article(id),
    review_time INTEGER NOT NULL
  );
  CREATE TABLE snippet_review (
    id TEXT NOT NULL,
    snippet_id TEXT NOT NULL REFERENCES snippet(id),
    review_time INTEGER NOT NULL
  );
  PRAGMA user_version = 0;
`;

/** Schema state before migration v3 (has scroll_top, start/end_offset, but no interval) */
const SCHEMA_V2 = `
  CREATE TABLE article (
    id TEXT NOT NULL,
    reference TEXT NOT NULL UNIQUE,
    due INTEGER,
    priority INTEGER NOT NULL,
    dismissed INTEGER DEFAULT 0,
    fixed_interval_days INTEGER NULL,
    scroll_top INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE snippet (
    id TEXT NOT NULL,
    reference TEXT NOT NULL UNIQUE,
    parent TEXT DEFAULT NULL,
    due INTEGER,
    priority INTEGER NOT NULL,
    dismissed INTEGER DEFAULT 0,
    scroll_top INTEGER NOT NULL DEFAULT 0,
    start_offset INTEGER DEFAULT NULL,
    end_offset INTEGER DEFAULT NULL
  );
  CREATE TABLE article_review (
    id TEXT NOT NULL,
    article_id TEXT NOT NULL REFERENCES article(id),
    review_time INTEGER NOT NULL
  );
  CREATE TABLE snippet_review (
    id TEXT NOT NULL,
    snippet_id TEXT NOT NULL REFERENCES snippet(id),
    review_time INTEGER NOT NULL
  );
  PRAGMA user_version = 2;
`;

// ---------------------------------------------------------------------------
// Migration v1 tests
// ---------------------------------------------------------------------------

describe('migration v1 — add start_offset and end_offset to snippet', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb(SCHEMA_V0);
  });

  it('adds start_offset and end_offset columns', () => {
    applyMigrations(db);
    const cols = columnNames(db, 'snippet');
    expect(cols).toContain('start_offset');
    expect(cols).toContain('end_offset');
  });

  it('increments user_version to at least 1', () => {
    applyMigrations(db);
    expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(1);
  });

  it('preserves existing snippet rows', () => {
    db.exec(
      `INSERT INTO snippet (id, reference, due, priority, dismissed)
       VALUES ('s1', 'note.md#snippet-1', 1000, 20, 0)`
    );
    applyMigrations(db);
    const rows = selectAll(db, 'snippet');
    expect(rows).toHaveLength(1);
    expect(rows[0].reference).toBe('note.md#snippet-1');
    expect(rows[0].start_offset).toBeNull();
    expect(rows[0].end_offset).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Migration v2 tests
// ---------------------------------------------------------------------------

describe('migration v2 — add scroll_top to article and snippet', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb(SCHEMA_V0);
    // Apply only v1 to start from v1 state
    migrations[0].up(db);
    db.exec('PRAGMA user_version = 1');
  });

  it('adds scroll_top to article', () => {
    applyMigrations(db);
    expect(columnNames(db, 'article')).toContain('scroll_top');
  });

  it('adds scroll_top to snippet', () => {
    applyMigrations(db);
    expect(columnNames(db, 'snippet')).toContain('scroll_top');
  });

  it('defaults scroll_top to 0 for existing rows', () => {
    db.exec(
      `INSERT INTO article (id, reference, due, priority, dismissed)
       VALUES ('a1', 'article.md', 1000, 30, 0)`
    );
    applyMigrations(db);
    const rows = selectAll(db, 'article');
    expect(rows[0].scroll_top).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Migration v3 tests
// ---------------------------------------------------------------------------

describe('migration v3 — backfill interval on article and snippet', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb(SCHEMA_V2);
  });

  it('adds interval column to article', () => {
    applyMigrations(db);
    expect(columnNames(db, 'article')).toContain('interval');
  });

  it('adds interval column to snippet', () => {
    applyMigrations(db);
    expect(columnNames(db, 'snippet')).toContain('interval');
  });

  it('sets interval to due - latest_review_time when a review exists', () => {
    const due = 1_000_000;
    const reviewTime = 900_000;
    db.exec(
      `INSERT INTO article (id, reference, due, priority, dismissed)
       VALUES ('a1', 'article.md', ${due}, 30, 0)`
    );
    db.exec(
      `INSERT INTO article_review (id, article_id, review_time)
       VALUES ('r1', 'a1', ${reviewTime})`
    );

    applyMigrations(db);

    const rows = selectAll(db, 'article');
    expect(rows[0].interval).toBe(due - reviewTime);
  });

  it('falls back to TEXT_BASE_REVIEW_INTERVAL when no review exists', () => {
    db.exec(
      `INSERT INTO article (id, reference, due, priority, dismissed)
       VALUES ('a1', 'article.md', 1000000, 30, 0)`
    );

    applyMigrations(db);

    const rows = selectAll(db, 'article');
    expect(rows[0].interval).toBe(TEXT_BASE_REVIEW_INTERVAL);
  });

  it('uses the most recent review when multiple exist', () => {
    const due = 2_000_000;
    db.exec(
      `INSERT INTO article (id, reference, due, priority, dismissed)
       VALUES ('a1', 'article.md', ${due}, 30, 0)`
    );
    db.exec(
      `INSERT INTO article_review (id, article_id, review_time) VALUES
       ('r1', 'a1', 1000000),
       ('r2', 'a1', 1500000)`
    );

    applyMigrations(db);

    const rows = selectAll(db, 'article');
    expect(rows[0].interval).toBe(due - 1_500_000);
  });

  it('backfills interval independently per article', () => {
    db.exec(
      `INSERT INTO article (id, reference, due, priority, dismissed) VALUES
       ('a1', 'a.md', 1000000, 30, 0),
       ('a2', 'b.md', 2000000, 20, 0)`
    );
    db.exec(
      `INSERT INTO article_review (id, article_id, review_time) VALUES
       ('r1', 'a1', 800000)`
    );
    // a2 has no review → TEXT_BASE_REVIEW_INTERVAL

    applyMigrations(db);

    const rows = selectAll(db, 'article');
    const byId = Object.fromEntries(rows.map((r) => [r.id, r])) as Record<
      string,
      ArticleRow
    >;
    expect(byId['a1'].interval).toBe(1000000 - 800000);
    expect(byId['a2'].interval).toBe(TEXT_BASE_REVIEW_INTERVAL);
  });

  it('backfills interval on snippets the same way', () => {
    const due = 1_500_000;
    const reviewTime = 1_200_000;
    db.exec(
      `INSERT INTO snippet (id, reference, due, priority, dismissed)
       VALUES ('sn1', 'note.md#s1', ${due}, 25, 0)`
    );
    db.exec(
      `INSERT INTO snippet_review (id, snippet_id, review_time)
       VALUES ('sr1', 'sn1', ${reviewTime})`
    );

    applyMigrations(db);

    const rows = selectAll(db, 'snippet');
    expect(rows[0].interval).toBe(due - reviewTime);
  });

  it('preserves all other columns on article rows', () => {
    db.exec(
      `INSERT INTO article (id, reference, due, priority, dismissed, fixed_interval_days, scroll_top)
       VALUES ('a1', 'article.md', 999, 40, 0, 3, 42)`
    );
    applyMigrations(db);
    const rows = selectAll(db, 'article');
    expect(rows[0]).toEqual({
      id: 'a1',
      reference: 'article.md',
      due: 999,
      interval: MS_PER_DAY,
      priority: 40,
      dismissed: 0,
      fixed_interval_days: 3,
      scroll_top: 42,
    });
  });

  it('updates user_version to 3', () => {
    applyMigrations(db);
    expect(getSchemaVersion(db)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Transaction safety
// ---------------------------------------------------------------------------

describe('applyMigrations — transaction safety', () => {
  it('rolls back user_version if a migration throws', () => {
    const db = makeDb(SCHEMA_V0);
    // Inject a migration that will fail after doing some work
    const badMigration = {
      version: 99,
      description: 'intentionally broken migration',
      up: (db: Database) => {
        db.exec(`ALTER TABLE article ADD COLUMN canary INTEGER`);
        throw new Error('simulated failure');
      },
    };
    // Directly invoke applyMigrations with the broken migration via DB state trick:
    // set user_version to 98 so only the bad migration is pending, then patch migrations
    db.exec('PRAGMA user_version = 98');
    const originalMigrations = migrations.splice(0);
    migrations.push(badMigration);
    try {
      expect(() => applyMigrations(db)).toThrow('Migration 99 failed');
      // version must not have advanced
      expect(getSchemaVersion(db)).toBe(98);
    } finally {
      migrations.splice(0);
      migrations.push(...originalMigrations);
    }
  });
});

// ---------------------------------------------------------------------------
// recreateTable — unit tests
// ---------------------------------------------------------------------------

describe('recreateTable', () => {
  const tableSchema = `
    CREATE TABLE article (
      id TEXT NOT NULL,
      reference TEXT NOT NULL UNIQUE,
      due INTEGER,
      priority INTEGER NOT NULL,
      dismissed INTEGER DEFAULT 0,
      fixed_interval_days INTEGER NULL,
      scroll_top INTEGER NOT NULL DEFAULT 0
    );`;

  it('bulk-copies rows without transformRow', () => {
    const db = makeDb(tableSchema);
    const articles = fc.sample(
      fc.array(
        fc.record({
          id: fc.uuid(),
          reference: fc.string(),
          due: fc.nat(),
          priority: fc.integer({
            min: MINIMUM_PRIORITY,
            max: MAXIMUM_PRIORITY,
          }),
        }),
        { minLength: 1_000, maxLength: 1_000 }
      ),
      1
    )[0];

    for (const { id, reference, due, priority } of articles) {
      db.run(
        `INSERT OR IGNORE INTO article (id, reference, due, priority) VALUES (?, ?, ?, ?)`,
        [id, reference, due, priority]
      );
    }

    const rowsBefore = selectAll(db, 'article');

    recreateTable<
      SafeOmit<ArticleRow, 'interval'>,
      SafeOmit<ArticleRow, 'interval'>
    >(db, 'article', tableSchema, {
      id: 'id',
      reference: 'reference',
      due: 'due',
      priority: 'priority',
      dismissed: 'dismissed',
      fixed_interval_days: 'fixed_interval_days',
      scroll_top: 'scroll_top',
    });

    const rows = selectAll(db, 'article');
    expect(rows).toHaveLength(rowsBefore.length);
    expect(rows).toEqual(rowsBefore);
    // temp table must be cleaned up
    expect(() => db.exec('SELECT * FROM article_old')).toThrow();
  });

  it('applies transformRow to each row', () => {
    const db = makeDb(tableSchema);
    db.exec(
      `INSERT INTO article (id, reference, due, priority) VALUES
       ('a', 'a.md', 500, 10),
       ('b', 'b.md', 800, 20)`
    );

    // add the `interval` column
    recreateTable<ArticleRow, SafeOmit<ArticleRow, 'interval'>>(
      db,
      'article',
      `CREATE TABLE article (
        id TEXT NOT NULL,
        reference TEXT NOT NULL UNIQUE,
        due INTEGER,
        interval INTEGER,
        priority INTEGER NOT NULL,
        dismissed INTEGER DEFAULT 0,
        fixed_interval_days INTEGER NULL,
        scroll_top INTEGER NOT NULL DEFAULT 0
      );`,
      {
        id: 'id',
        reference: 'reference',
        due: 'due',
        interval: 'interval',
        priority: 'priority',
        dismissed: 'dismissed',
        fixed_interval_days: 'fixed_interval_days',
        scroll_top: 'scroll_top',
      },
      (row) => ({ ...row, interval: (row.due as number) * 2 }) as never
    );

    const rows = selectAll(db, 'article');
    const byId = Object.fromEntries(rows.map((r) => [r.id, r])) as Record<
      string,
      ArticleRow
    >;

    expect(byId['a']).toEqual({
      id: 'a',
      reference: 'a.md',
      due: 500,
      priority: 10,
      interval: 1000,
      dismissed: 0,
      fixed_interval_days: null,
      scroll_top: 0,
    });

    expect(byId['b']).toEqual({
      id: 'b',
      reference: 'b.md',
      due: 800,
      priority: 20,
      interval: 1600,
      dismissed: 0,
      fixed_interval_days: null,
      scroll_top: 0,
    });
  });

  it('restores PRAGMA foreign_keys = ON after the rebuild', () => {
    const db = makeDb(tableSchema);
    recreateTable(db, 'article', tableSchema, {
      id: 'id',
      reference: 'reference',
      due: 'due',
      priority: 'priority',
      dismissed: 'dismissed',
      fixed_interval_days: 'fixed_interval_days',
      scroll_top: 'scroll_top',
    });
    const fkResult = db.exec('PRAGMA foreign_keys');
    expect(fkResult[0].values[0][0]).toBe(1);
  });
});
