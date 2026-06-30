import {
  DATA_DIRECTORY,
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

import {
  applyMigrations,
  getSchemaVersion,
  recreateTable,
} from './migration-helpers';
// migrations.ts imports `databaseSchema` via a custom esbuild plugin that
// handles `.sql` files as strings. Vitest doesn't use that plugin, so we
// mock the module before importing migrations.
const schemaPath = resolve(__dirname, 'schema.sql');
const schemaSQL = readFileSync(schemaPath, 'utf-8');

vi.mock('./schema.sql', () => ({ default: schemaSQL }));

// Import after the mock is registered
const { migrations } = await import('./migrations');

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
  CREATE TABLE srs_card (
    id TEXT NOT NULL,
    reference TEXT NOT NULL UNIQUE,
    parent TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL,
    due INTEGER NOT NULL,
    dismissed INTEGER DEFAULT 0,
    last_review INTEGER,
    stability REAL NOT NULL,
    difficulty REAL NOT NULL,
    elapsed_days REAL NOT NULL,
    scheduled_days REAL NOT NULL,
    reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    state INTEGER NOT NULL,
    CHECK(state >= 0 AND state <= 3),
    CHECK(dismissed = FALSE OR dismissed = TRUE)
  );
  CREATE TABLE srs_card_review (
    id TEXT NOT NULL,
    card_id TEXT NOT NULL REFERENCES srs_card(id),
    due INTEGER NOT NULL,
    review INTEGER NOT NULL,
    stability REAL NOT NULL,
    difficulty REAL NOT NULL,
    elapsed_days REAL NOT NULL,
    last_elapsed_days REAL NOT NULL,
    scheduled_days REAL NOT NULL,
    rating INTEGER NOT NULL,
    state INTEGER NOT NULL,
    CHECK(state >= 0 AND state <= 3),
    CHECK(rating >= 0 AND rating <= 4)
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
  CREATE TABLE srs_card (
    id TEXT NOT NULL,
    reference TEXT NOT NULL UNIQUE,
    parent TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL,
    due INTEGER NOT NULL,
    dismissed INTEGER DEFAULT 0,
    last_review INTEGER,
    stability REAL NOT NULL,
    difficulty REAL NOT NULL,
    elapsed_days REAL NOT NULL,
    scheduled_days REAL NOT NULL,
    reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    state INTEGER NOT NULL,
    CHECK(state >= 0 AND state <= 3),
    CHECK(dismissed = FALSE OR dismissed = TRUE)
  );
  CREATE TABLE srs_card_review (
    id TEXT NOT NULL,
    card_id TEXT NOT NULL REFERENCES srs_card(id),
    due INTEGER NOT NULL,
    review INTEGER NOT NULL,
    stability REAL NOT NULL,
    difficulty REAL NOT NULL,
    elapsed_days REAL NOT NULL,
    last_elapsed_days REAL NOT NULL,
    scheduled_days REAL NOT NULL,
    rating INTEGER NOT NULL,
    state INTEGER NOT NULL,
    CHECK(state >= 0 AND state <= 3),
    CHECK(rating >= 0 AND rating <= 4)
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
    applyMigrations(db, migrations);
    const cols = columnNames(db, 'snippet');
    expect(cols).toContain('start_offset');
    expect(cols).toContain('end_offset');
  });

  it('increments user_version to at least 1', () => {
    applyMigrations(db, migrations);
    expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(1);
  });

  it('preserves existing snippet rows', () => {
    db.exec(
      `INSERT INTO snippet (id, reference, due, priority, dismissed)
       VALUES ('s1', 'note.md#snippet-1', 1000, 20, 0)`
    );
    applyMigrations(db, migrations);
    const rows = selectAll(db, 'snippet');
    expect(rows).toHaveLength(1);
    expect(rows[0].reference).toBe(`${DATA_DIRECTORY}/note.md#snippet-1`);
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
    applyMigrations(db, migrations);
    expect(columnNames(db, 'article')).toContain('scroll_top');
  });

  it('adds scroll_top to snippet', () => {
    applyMigrations(db, migrations);
    expect(columnNames(db, 'snippet')).toContain('scroll_top');
  });

  it('defaults scroll_top to 0 for existing rows', () => {
    db.exec(
      `INSERT INTO article (id, reference, due, priority, dismissed)
       VALUES ('a1', 'article.md', 1000, 30, 0)`
    );
    applyMigrations(db, migrations);
    const rows = selectAll(db, 'article');
    expect(rows[0].scroll_top).toBe(0);
  });
});

/** Schema state after migration v5 (has deleted column on all item tables) */
const SCHEMA_V5 = `
  CREATE TABLE article (
    id TEXT NOT NULL,
    reference TEXT NOT NULL UNIQUE,
    due INTEGER,
    interval INTEGER NOT NULL,
    priority INTEGER NOT NULL,
    fixed_interval_days INTEGER NULL,
    dismissed INTEGER NOT NULL DEFAULT FALSE,
    deleted INTEGER NOT NULL DEFAULT FALSE,
    scroll_top INTEGER NOT NULL DEFAULT 0,
    CHECK(interval > 0),
    CHECK(priority >= 10 AND priority <= 50),
    CHECK(fixed_interval_days > 0),
    CHECK(dismissed = FALSE OR dismissed = TRUE),
    CHECK(deleted = FALSE OR deleted = TRUE),
    CHECK(due IS NOT NULL OR dismissed = TRUE)
  );
  CREATE TABLE snippet (
    id TEXT NOT NULL,
    reference TEXT NOT NULL UNIQUE,
    parent TEXT DEFAULT NULL,
    due INTEGER,
    interval INTEGER NOT NULL,
    priority INTEGER NOT NULL,
    dismissed INTEGER NOT NULL DEFAULT FALSE,
    deleted INTEGER NOT NULL DEFAULT FALSE,
    scroll_top INTEGER NOT NULL DEFAULT 0,
    start_offset INTEGER DEFAULT NULL,
    end_offset INTEGER DEFAULT NULL,
    CHECK(interval > 0),
    CHECK(priority >= 10 AND priority <= 50),
    CHECK(dismissed = FALSE OR dismissed = TRUE),
    CHECK(deleted = FALSE OR deleted = TRUE),
    CHECK(due IS NOT NULL OR dismissed = TRUE)
  );
  CREATE TABLE srs_card (
    id TEXT NOT NULL,
    reference TEXT NOT NULL UNIQUE,
    parent TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL,
    due INTEGER NOT NULL,
    dismissed INTEGER NOT NULL DEFAULT FALSE,
    deleted INTEGER NOT NULL DEFAULT FALSE,
    last_review INTEGER,
    stability REAL NOT NULL,
    difficulty REAL NOT NULL,
    elapsed_days REAL NOT NULL,
    scheduled_days REAL NOT NULL,
    reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    state INTEGER NOT NULL,
    CHECK(state >= 0 AND state <= 3),
    CHECK(dismissed = FALSE OR dismissed = TRUE),
    CHECK(deleted = FALSE OR deleted = TRUE)
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
  CREATE TABLE srs_card_review (
    id TEXT NOT NULL,
    card_id TEXT NOT NULL REFERENCES srs_card(id),
    due INTEGER NOT NULL,
    review INTEGER NOT NULL,
    stability REAL NOT NULL,
    difficulty REAL NOT NULL,
    elapsed_days REAL NOT NULL,
    last_elapsed_days REAL NOT NULL,
    scheduled_days REAL NOT NULL,
    rating INTEGER NOT NULL,
    state INTEGER NOT NULL,
    CHECK(state >= 0 AND state <= 3),
    CHECK(rating >= 0 AND rating <= 4)
  );
  PRAGMA user_version = 5;
`;

// ---------------------------------------------------------------------------
// Migration v3 tests
// ---------------------------------------------------------------------------

describe('migration v3 — backfill interval on article and snippet', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb(SCHEMA_V2);
  });

  it('adds interval column to article', () => {
    applyMigrations(db, migrations);
    expect(columnNames(db, 'article')).toContain('interval');
  });

  it('adds interval column to snippet', () => {
    applyMigrations(db, migrations);
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

    applyMigrations(db, migrations);

    const rows = selectAll(db, 'article');
    expect(rows[0].interval).toBe(due - reviewTime);
  });

  it('falls back to TEXT_BASE_REVIEW_INTERVAL when no review exists', () => {
    db.exec(
      `INSERT INTO article (id, reference, due, priority, dismissed)
       VALUES ('a1', 'article.md', 1000000, 30, 0)`
    );

    applyMigrations(db, migrations);

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

    applyMigrations(db, migrations);

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

    applyMigrations(db, migrations);

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

    applyMigrations(db, migrations);

    const rows = selectAll(db, 'snippet');
    expect(rows[0].interval).toBe(due - reviewTime);
  });

  it('preserves all other columns on article rows', () => {
    db.exec(
      `INSERT INTO article (id, reference, due, priority, dismissed, fixed_interval_days, scroll_top)
       VALUES ('a1', 'article.md', 999, 40, 0, 3, 42)`
    );
    applyMigrations(db, migrations);
    const rows = selectAll(db, 'article');
    expect(rows[0]).toEqual({
      id: 'a1',
      reference: `${DATA_DIRECTORY}/article.md`,
      due: 999,
      interval: MS_PER_DAY,
      priority: 40,
      dismissed: 0,
      deleted: 0,
      fixed_interval_days: 3,
      scroll_top: 42,
    });
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
    expect(() => applyMigrations(db, [badMigration])).toThrow(
      'Migration 99 failed'
    );
    // version must not have advanced
    expect(getSchemaVersion(db)).toBe(98);
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
      SafeOmit<ArticleRow, 'interval' | 'deleted'>,
      SafeOmit<ArticleRow, 'interval' | 'deleted'>
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
    recreateTable<SafeOmit<ArticleRow, 'deleted'>, SafeOmit<ArticleRow, 'interval' | 'deleted'>>(
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

// ---------------------------------------------------------------------------
// Migration v6 tests
// ---------------------------------------------------------------------------

describe('migration v6 — vault-relative references', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb(SCHEMA_V5);
    db.exec(`INSERT INTO article (id, reference, due, interval, priority)
      VALUES ('a1', 'articles/article.md', 1000, 86400000, 30)`);
    db.exec(`INSERT INTO snippet (id, reference, parent, due, interval, priority)
      VALUES ('s1', 'snippets/snip.md', 'articles/article.md', 1000, 86400000, 20)`);
    db.exec(`INSERT INTO snippet (id, reference, parent, due, interval, priority)
      VALUES ('s2', 'snippets/snip-frag.md#h1', NULL, 1000, 86400000, 20)`);
    db.exec(`INSERT INTO srs_card
      (id, reference, parent, created_at, due, stability, difficulty, elapsed_days, scheduled_days, state)
      VALUES ('c1', 'cards/card.md', 'articles/article.md', 0, 1000, 1.0, 1.0, 0.0, 1.0, 0)`);
  });

  it('prefixes article references with DATA_DIRECTORY/', () => {
    applyMigrations(db, migrations);
    const rows = selectAll(db, 'article');
    expect(rows[0].reference).toBe(`${DATA_DIRECTORY}/articles/article.md`);
  });

  it('prefixes snippet references with DATA_DIRECTORY/', () => {
    applyMigrations(db, migrations);
    const byId = Object.fromEntries(selectAll(db, 'snippet').map((r) => [r.id, r]));
    expect(byId['s1'].reference).toBe(`${DATA_DIRECTORY}/snippets/snip.md`);
  });

  it('preserves #fragment suffix when prefixing snippet references', () => {
    applyMigrations(db, migrations);
    const byId = Object.fromEntries(selectAll(db, 'snippet').map((r) => [r.id, r]));
    expect(byId['s2'].reference).toBe(`${DATA_DIRECTORY}/snippets/snip-frag.md#h1`);
  });

  it('prefixes srs_card references with DATA_DIRECTORY/', () => {
    applyMigrations(db, migrations);
    const rows = selectAll(db, 'srs_card');
    expect(rows[0].reference).toBe(`${DATA_DIRECTORY}/cards/card.md`);
  });

  it('prefixes non-null snippet.parent with DATA_DIRECTORY/', () => {
    applyMigrations(db, migrations);
    const byId = Object.fromEntries(selectAll(db, 'snippet').map((r) => [r.id, r]));
    expect(byId['s1'].parent).toBe(`${DATA_DIRECTORY}/articles/article.md`);
    expect(byId['s2'].parent).toBeNull();
  });

  it('prefixes non-null srs_card.parent with DATA_DIRECTORY/', () => {
    applyMigrations(db, migrations);
    const rows = selectAll(db, 'srs_card');
    expect(rows[0].parent).toBe(`${DATA_DIRECTORY}/articles/article.md`);
  });

  it('leaves row counts unchanged', () => {
    applyMigrations(db, migrations);
    expect(selectAll(db, 'article')).toHaveLength(1);
    expect(selectAll(db, 'snippet')).toHaveLength(2);
    expect(selectAll(db, 'srs_card')).toHaveLength(1);
  });

  it('advances schema version to 6', () => {
    applyMigrations(db, migrations);
    expect(getSchemaVersion(db)).toBe(6);
  });
});
