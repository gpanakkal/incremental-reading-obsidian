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
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
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
      due_fuzz: null,
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
      SafeOmit<ArticleRow, 'interval' | 'deleted' | 'due_fuzz'>,
      SafeOmit<ArticleRow, 'interval' | 'deleted' | 'due_fuzz'>
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
    recreateTable<
      SafeOmit<ArticleRow, 'deleted' | 'due_fuzz'>,
      SafeOmit<ArticleRow, 'interval' | 'deleted' | 'due_fuzz'>
    >(
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
      VALUES ('s1', 'snippets/snip.md', 'a1', 1000, 86400000, 20)`);
    db.exec(`INSERT INTO snippet (id, reference, parent, due, interval, priority)
      VALUES ('s2', 'snippets/snip-frag.md#h1', NULL, 1000, 86400000, 20)`);
    db.exec(`INSERT INTO srs_card
      (id, reference, parent, created_at, due, stability, difficulty, elapsed_days, scheduled_days, state)
      VALUES ('c1', 'cards/card.md', 'a1', 0, 1000, 1.0, 1.0, 0.0, 1.0, 0)`);
  });

  it('prefixes article references with DATA_DIRECTORY/', () => {
    applyMigrations(db, migrations);
    const rows = selectAll(db, 'article');
    expect(rows[0].reference).toBe(`${DATA_DIRECTORY}/articles/article.md`);
  });

  it('prefixes snippet references with DATA_DIRECTORY/', () => {
    applyMigrations(db, migrations);
    const byId = Object.fromEntries(
      selectAll(db, 'snippet').map((r) => [r.id, r])
    );
    expect(byId['s1'].reference).toBe(`${DATA_DIRECTORY}/snippets/snip.md`);
  });

  it('preserves #fragment suffix when prefixing snippet references', () => {
    applyMigrations(db, migrations);
    const byId = Object.fromEntries(
      selectAll(db, 'snippet').map((r) => [r.id, r])
    );
    expect(byId['s2'].reference).toBe(
      `${DATA_DIRECTORY}/snippets/snip-frag.md#h1`
    );
  });

  it('prefixes srs_card references with DATA_DIRECTORY/', () => {
    applyMigrations(db, migrations);
    const rows = selectAll(db, 'srs_card');
    expect(rows[0].reference).toBe(`${DATA_DIRECTORY}/cards/card.md`);
  });

  it('leaves row counts unchanged', () => {
    applyMigrations(db, migrations);
    expect(selectAll(db, 'article')).toHaveLength(1);
    expect(selectAll(db, 'snippet')).toHaveLength(2);
    expect(selectAll(db, 'srs_card')).toHaveLength(1);
  });

  it('leaves non-reference columns unchanged after prefixing', () => {
    applyMigrations(db, migrations);
    const articles = selectAll(db, 'article');
    expect(articles[0].due).toBe(1000);
    expect(articles[0].interval).toBe(86400000);
    expect(articles[0].priority).toBe(30);
    const snippets = Object.fromEntries(
      selectAll(db, 'snippet').map((r) => [r.id, r])
    );
    expect(snippets['s1'].due).toBe(1000);
    expect(snippets['s1'].interval).toBe(86400000);
    expect(snippets['s1'].priority).toBe(20);
    const cards = selectAll(db, 'srs_card');
    expect(cards[0].due).toBe(1000);
    expect(cards[0].stability).toBe(1.0);
    expect(cards[0].difficulty).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Migration v8 tests
// ---------------------------------------------------------------------------

/**
 * A database at exactly schema v7, produced by replaying migrations 1-7 rather
 * than hardcoding a seventh literal schema. Rows are inserted by the caller
 * afterwards, so migration v6's reference rewrite never touches them.
 */
function makeDbAtV7(): Database {
  const db = makeDb(SCHEMA_V0);
  applyMigrations(
    db,
    migrations.filter((m) => m.version < 8)
  );
  return db;
}

/** Column values a v7 srs_card row can hold, respecting its CHECK constraints. */
const v7CardArb = fc.record({
  created_at: fc.integer({ min: 0, max: 4_102_444_800_000 }),
  due: fc.integer({ min: 0, max: 4_102_444_800_000 }),
  dismissed: fc.constantFrom(0, 1),
  deleted: fc.constantFrom(0, 1),
  last_review: fc.oneof(
    fc.integer({ min: 0, max: 4_102_444_800_000 }),
    fc.constant(null)
  ),
  stability: fc.double({ min: 0, max: 36500, noNaN: true }),
  difficulty: fc.double({ min: 0, max: 10, noNaN: true }),
  elapsed_days: fc.double({ min: 0, max: 36500, noNaN: true }),
  scheduled_days: fc.double({ min: 0, max: 36500, noNaN: true }),
  reps: fc.nat({ max: 10000 }),
  lapses: fc.nat({ max: 10000 }),
  state: fc.constantFrom(0, 1, 2, 3),
});

/** The columns `v7CardArb` generates. */
type V7CardColumns = {
  created_at: number;
  due: number;
  dismissed: number;
  deleted: number;
  last_review: number | null;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: number;
};

/** Those columns plus the identifying ones the arbitrary leaves fixed. */
type V7Card = { id: string; reference: string } & V7CardColumns;

function makeV7CardValues(id: string, card: V7CardColumns): V7Card {
  return { id, reference: `${DATA_DIRECTORY}/cards/${id}.md`, ...card };
}

function insertV7Card(db: Database, card: V7Card): void {
  db.exec(
    `INSERT INTO srs_card
      (id, reference, parent, created_at, due, dismissed, deleted, last_review,
       stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      card.id,
      card.reference,
      card.created_at,
      card.due,
      card.dismissed,
      card.deleted,
      card.last_review,
      card.stability,
      card.difficulty,
      card.elapsed_days,
      card.scheduled_days,
      card.reps,
      card.lapses,
      card.state,
    ] as never
  );
}

describe('migration v8 — add learning_steps to card tables', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDbAtV7();
  });

  it('adds learning_steps to srs_card', () => {
    applyMigrations(db, migrations);
    expect(columnNames(db, 'srs_card')).toContain('learning_steps');
  });

  it('adds learning_steps to srs_card_review', () => {
    applyMigrations(db, migrations);
    expect(columnNames(db, 'srs_card_review')).toContain('learning_steps');
  });

  it('leaves a v7 database at the version declared by the last migration', () => {
    applyMigrations(db, migrations);
    expect(getSchemaVersion(db)).toBe(
      migrations[migrations.length - 1].version
    );
  });

  it('reports no work to do when run a second time', () => {
    applyMigrations(db, migrations);
    expect(applyMigrations(db, migrations)).toBe(false);
  });

  it('backfills learning_steps to 0 on pre-existing cards in any scheduling state', () => {
    fc.assert(
      fc.property(v7CardArb, (card) => {
        const fresh = makeDbAtV7();
        insertV7Card(fresh, makeV7CardValues('c1', card));

        applyMigrations(fresh, migrations);

        const rows = selectAll(fresh, 'srs_card');
        expect(rows).toHaveLength(1);
        expect(rows[0].learning_steps).toBe(0);
        fresh.close();
      })
    );
  });

  it('preserves every pre-existing card column value', () => {
    fc.assert(
      fc.property(v7CardArb, (card) => {
        const fresh = makeDbAtV7();
        const inserted = makeV7CardValues('c1', card);
        insertV7Card(fresh, inserted);

        applyMigrations(fresh, migrations);

        const [row] = selectAll(fresh, 'srs_card');
        // Every column the row had at v7 must survive untouched; only the new
        // column may appear.
        for (const [column, value] of Object.entries(inserted)) {
          expect(row[column]).toBe(value);
        }
        fresh.close();
      })
    );
  });

  it('backfills learning_steps to 0 on pre-existing review logs', () => {
    insertV7Card(
      db,
      makeV7CardValues('c1', {
        created_at: 0,
        due: 1000,
        dismissed: 0,
        deleted: 0,
        last_review: null,
        stability: 1,
        difficulty: 1,
        elapsed_days: 0,
        scheduled_days: 1,
        reps: 0,
        lapses: 0,
        state: 0,
      })
    );
    db.exec(
      `INSERT INTO srs_card_review
        (id, card_id, due, review, stability, difficulty, elapsed_days,
         last_elapsed_days, scheduled_days, rating, state)
       VALUES ('r1', 'c1', 1000, 500, 1.0, 1.0, 0.0, 0.0, 1.0, 3, 1)`
    );

    applyMigrations(db, migrations);

    const [row] = selectAll(db, 'srs_card_review');
    expect(row.learning_steps).toBe(0);
    expect(row.rating).toBe(3);
    expect(row.state).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Schema version consistency
// ---------------------------------------------------------------------------

describe('schema version consistency', () => {
  /** The version a freshly-created database declares via schema.sql. */
  function declaredSchemaVersion(): number {
    const match = schemaSQL.match(/PRAGMA\s+user_version\s*=\s*(\d+)/i);
    if (!match) throw new Error('schema.sql declares no user_version');
    return Number(match[1]);
  }

  it('declares the same version in schema.sql as the last migration', () => {
    expect(declaredSchemaVersion()).toBe(
      migrations[migrations.length - 1].version
    );
  });

  it('brings a legacy database up to the version a fresh one declares', () => {
    const db = makeDb(SCHEMA_V0);
    applyMigrations(db, migrations);
    expect(getSchemaVersion(db)).toBe(declaredSchemaVersion());
  });

  it('numbers migrations consecutively from 1', () => {
    expect(migrations.map((m) => m.version)).toEqual(
      migrations.map((_, i) => i + 1)
    );
  });

  it('gives every migration a non-empty description', () => {
    for (const migration of migrations) {
      expect(migration.description.trim().length).toBeGreaterThan(0);
    }
  });
});
