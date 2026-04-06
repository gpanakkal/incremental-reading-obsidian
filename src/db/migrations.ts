import { TEXT_BASE_REVIEW_INTERVAL } from '#/lib/constants';
import type { TableNameToRowType } from '#/lib/types';
import type { SafeOmit } from '#/lib/utility-types';
import type { BindParams, Database, SqlValue } from 'sql.js';

/**
 * Database migrations for schema changes
 * Each migration is applied in order and tracked via PRAGMA user_version
 */

export interface Migration {
  version: number;
  up: (db: Database) => void;
  description: string;
  /** Declare expected row count changes per table (defaults to 0 for all tables) */
  expectedRowCountChanges?: Record<string, number>;
}

export class MigrationVerificationError extends Error {
  constructor(
    message: string,
    public readonly errors: string[],
    public readonly logPath: string
  ) {
    super(message);
    this.name = 'MigrationVerificationError';
  }
}

/**
 * Check if a column exists on a table
 */
function columnExists(db: Database, table: string, column: string): boolean {
  const result = db.exec(`PRAGMA table_info(${table})`);
  if (!result.length) return false;
  return result[0].values.some((row) => row[1] === column);
}

/**
 * Add a column to a table if it doesn't already exist
 */
function addColumnIfNotExists(
  db: Database,
  table: string,
  column: string,
  definition: string
) {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * Rebuild a table using the SQLite table rebuild procedure.
 *
 * Use this when ALTER TABLE ADD COLUMN is insufficient — e.g. to add CHECK
 * constraints, change column types, add NOT NULL columns without defaults,
 * or restructure foreign keys.
 *
 * @param tableName   The table to rebuild (must already exist)
 * @param newSchema   Full CREATE TABLE statement for the replacement table.
 *                    The table name must match `tableName`. Include any
 *                    CREATE INDEX statements as additional semicolon-separated
 *                    statements in this string.
 * @param columnMap   Maps each new column name to the corresponding old column
 *                    name (or any SQL expression valid in a SELECT against the
 *                    old table). Columns absent from the map receive their
 *                    DEFAULT value.
 * @param transformRow  Optional per-row transform called before each INSERT.
 *                      Pre-compute any cross-table lookups outside this
 *                      function and close over them. Return the mutated row.
 */
export function recreateTable<
  NewSchema extends object,
  OldSchema extends object,
>(
  db: Database,
  tableName: string,
  newSchema: string,
  columnMap: Record<keyof NewSchema, string>,
  transformRow?: (row: OldSchema) => NewSchema
): void {
  const tempName = `${tableName}_old`;

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`ALTER TABLE ${tableName} RENAME TO ${tempName}`);
    db.exec(newSchema);

    const newCols = Object.keys(columnMap);

    if (transformRow) {
      const result = db.exec(`SELECT * FROM ${tempName}`);
      if (result.length > 0) {
        const { columns, values } = result[0];
        const insertSql = `INSERT INTO ${tableName} (${newCols.join(', ')}) VALUES (${newCols.map(() => '?').join(', ')})`;
        for (const value of values) {
          const rowObj = columns.reduce(
            (acc, col, i) => Object.assign(acc, { [col]: value[i] }),
            {} as OldSchema
          );
          const transformed = transformRow(rowObj) as unknown as Record<
            string,
            SqlValue
          >;
          const rowValues = newCols.map((col) => {
            const src = columnMap[col as keyof typeof columnMap];
            return (transformed[src ?? col] ?? null) as SqlValue;
          });
          db.run(insertSql, rowValues as BindParams);
        }
      }
    } else {
      const selectExprs = Object.entries(columnMap as Record<string, string>)
        .map(([newCol, oldExpr]) => `${oldExpr} AS ${newCol}`)
        .join(', ');
      db.exec(
        `INSERT INTO ${tableName} (${newCols.join(', ')}) SELECT ${selectExprs} FROM ${tempName}`
      );
    }

    db.exec(`DROP TABLE ${tempName}`);
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export const migrations: Migration[] = [
  {
    version: 1,
    description: 'Add start_offset and end_offset columns to snippet table',
    up: (db) => {
      addColumnIfNotExists(
        db,
        'snippet',
        'start_offset',
        'INTEGER DEFAULT NULL'
      );
      addColumnIfNotExists(db, 'snippet', 'end_offset', 'INTEGER DEFAULT NULL');
    },
  },
  {
    version: 2,
    description: 'Add scroll position column to article and snippet tables',
    up: (db) => {
      addColumnIfNotExists(
        db,
        'article',
        'scroll_top',
        'INTEGER NOT NULL DEFAULT 0'
      );
      addColumnIfNotExists(
        db,
        'snippet',
        'scroll_top',
        'INTEGER NOT NULL DEFAULT 0'
      );
    },
  },
  {
    version: 3,
    description:
      'Store last calculated review interval on articles and snippets',
    up: (db) => {
      // add `interval` to articles
      (() => {
        const reviewResult = db.exec(
          `SELECT article_id, MAX(review_time) FROM article_review GROUP BY article_id`
        );
        const latestReviewByArticle: Record<string, number> = {};
        if (reviewResult.length > 0) {
          for (const [id, latest] of reviewResult[0].values) {
            latestReviewByArticle[id as string] = latest as number;
          }
        }
        recreateTable(
          db,
          'article',
          `CREATE TABLE article (
            id TEXT NOT NULL, -- UUID
            reference TEXT NOT NULL UNIQUE, -- pointer to the file's location in the vault
            due INTEGER, -- unix timestamp
            interval INTEGER NOT NULL, -- the interval that was used to calculate due
            priority INTEGER NOT NULL, -- used when manual interval is null
            fixed_interval_days INTEGER NULL,
            dismissed INTEGER DEFAULT 0,
            scroll_top INTEGER NOT NULL DEFAULT 0,
            CHECK(interval > 0),
            CHECK(priority >= 10 AND priority <= 50),
            CHECK(fixed_interval_days >= 1 AND fixed_interval_days <= 7),
            CHECK(dismissed = FALSE OR dismissed = TRUE),
            CHECK(due IS NOT NULL OR dismissed = TRUE)
          );`,
          {
            id: 'id',
            dismissed: 'dismissed',
            due: 'due',
            reference: 'reference',
            interval: 'interval',
            priority: 'priority',
            fixed_interval_days: 'fixed_interval_days',
            scroll_top: 'scroll_top',
          },
          (row: SafeOmit<TableNameToRowType['article'], 'interval'>) => {
            const lastReviewTime = latestReviewByArticle[row.id];
            const lastInterval =
              lastReviewTime && row.due
                ? row.due - lastReviewTime
                : TEXT_BASE_REVIEW_INTERVAL;
            return {
              ...row,
              interval: lastInterval,
            };
          }
        );
      })();

      // add `interval` to snippets
      (() => {
        const reviewResult = db.exec(
          `SELECT snippet_id, MAX(review_time) FROM snippet_review GROUP BY snippet_id`
        );
        const latestReviewBySnippet: Record<string, number> = {};
        if (reviewResult.length > 0) {
          for (const [id, latest] of reviewResult[0].values) {
            latestReviewBySnippet[id as string] = latest as number;
          }
        }
        recreateTable(
          db,
          'snippet',
          `CREATE TABLE snippet (
            id TEXT NOT NULL, -- UUID
            reference TEXT NOT NULL UNIQUE, -- pointer to the file's location in the vault
            parent TEXT DEFAULT NULL, -- null if it wasn't created from an article or snippet
            due INTEGER, -- unix timestamp
            interval INTEGER NOT NULL, -- the interval that was used to calculate due
            priority INTEGER NOT NULL,
            dismissed INTEGER DEFAULT 0,
            scroll_top INTEGER NOT NULL DEFAULT 0,
            start_offset INTEGER DEFAULT NULL, -- character offset from start of parent note's body
            end_offset INTEGER DEFAULT NULL, -- character offset from start of parent note's body
            CHECK(interval > 0),
            CHECK(priority >= 10 AND priority <= 50),
            CHECK(dismissed = FALSE OR dismissed = TRUE),
            CHECK(due IS NOT NULL OR dismissed = TRUE)
          );`,
          {
            id: 'id',
            dismissed: 'dismissed',
            due: 'due',
            reference: 'reference',
            interval: 'interval',
            priority: 'priority',
            scroll_top: 'scroll_top',
            parent: 'parent',
            start_offset: 'start_offset',
            end_offset: 'end_offset',
          },
          (row: SafeOmit<TableNameToRowType['snippet'], 'interval'>) => {
            const lastReviewTime = latestReviewBySnippet[row.id];
            const computed =
              lastReviewTime && row.due ? row.due - lastReviewTime : 0;
            const interval =
              computed > 0 ? computed : TEXT_BASE_REVIEW_INTERVAL;
            return { ...row, interval };
          }
        );
      })();
    },
  },
];

/**
 * Get the current schema version from the database
 */
export function getSchemaVersion(db: Database): number {
  const result = db.exec('PRAGMA user_version');
  return (result[0]?.values[0]?.[0] as number) || 0;
}

/**
 * Get migrations that haven't been applied yet
 */
export function getPendingMigrations(db: Database): Migration[] {
  const currentVersion = getSchemaVersion(db);
  return migrations.filter((m) => m.version > currentVersion);
}

/**
 * Apply pending migrations to bring database to current schema version.
 * Each migration runs inside a transaction — if it fails, the transaction
 * is rolled back and the error is re-thrown.
 * Backup and verification are handled by the caller.
 * @param db The SQLite database instance
 * @returns `true` if migrations were applied or `false` otherwise
 * @throws if migrations fail
 */
export function applyMigrations(db: Database): boolean {
  const pendingMigrations = getPendingMigrations(db);

  if (pendingMigrations.length === 0) {
    return false;
  }

  for (const migration of pendingMigrations) {
    try {
      db.exec('BEGIN');
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      console.error(`Migration ${migration.version} failed:`, error);
      throw new Error(`Migration ${migration.version} failed: ${error}`);
    }
  }

  return true;
}
