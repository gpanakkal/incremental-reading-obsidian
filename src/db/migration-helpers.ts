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
export function addColumnIfNotExists(
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
export function getPendingMigrations(
  db: Database,
  migrations: Migration[]
): Migration[] {
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
export function applyMigrations(
  db: Database,
  migrations: Migration[]
): boolean {
  const pendingMigrations = getPendingMigrations(db, migrations);

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
      throw new Error(`Migration ${migration.version} failed: ${error}`);
    }
  }

  return true;
}
