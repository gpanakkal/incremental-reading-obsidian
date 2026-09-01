import type { Database, SqlValue } from 'sql.js';

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

/** Index definitions attached to a table, excluding auto-indexes (`sql IS NULL`) */
function tableIndexes(
  db: Database,
  table: string
): { name: string; sql: string }[] {
  const result = db.exec(
    `SELECT name, sql FROM sqlite_master
     WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`,
    [table]
  );
  if (!result.length) return [];
  return result[0].values.map((row) => ({
    name: row[0] as string,
    sql: row[1] as string,
  }));
}

/** Every index name in the database — the namespace a replay has to avoid */
function allIndexNames(db: Database): Set<string> {
  const result = db.exec(`SELECT name FROM sqlite_master WHERE type = 'index'`);
  if (!result.length) return new Set();
  return new Set(result[0].values.map((row) => row[0] as string));
}

/**
 * Throw unless every column of the newly created table has a stated source, and
 * every mapped column exists on it.
 *
 * Without this, a column missing from `columnMap` is indistinguishable from one
 * deliberately left to its DEFAULT: both silently produce default values for
 * every row. Requiring the deliberate case to be named makes the accidental one
 * fail loudly instead of quietly resetting live data.
 */
function assertColumnsAccountedFor(
  db: Database,
  tableName: string,
  columnMap: Record<string, string>,
  defaultedColumns: string[]
): void {
  const result = db.exec(`PRAGMA table_info(${tableName})`);
  const newColumns = result.length
    ? result[0].values.map((row) => row[1] as string)
    : [];
  const mapped = Object.keys(columnMap);
  const accountedFor = new Set([...mapped, ...defaultedColumns]);

  const unaccounted = newColumns.filter((col) => !accountedFor.has(col));
  if (unaccounted.length) {
    throw new Error(
      `recreateTable(${tableName}): no source for column(s) ${unaccounted.join(', ')}. ` +
        `Add them to columnMap, or list them in defaultedColumns to accept the column default.`
    );
  }

  const undeclared = mapped.filter((col) => !newColumns.includes(col));
  if (undeclared.length) {
    throw new Error(
      `recreateTable(${tableName}): columnMap names column(s) ${undeclared.join(', ')}, ` +
        `which the new schema does not declare.`
    );
  }
}

export interface RecreateTableOptions<
  NewSchema extends object,
  OldSchema extends object,
> {
  /**
   * Per-row transform called before each INSERT. Pre-compute any cross-table
   * lookups outside this function and close over them. Return the mutated row.
   */
  transformRow?: (row: OldSchema) => NewSchema;
  /**
   * Columns of the new table deliberately left to their DEFAULT instead of
   * being carried over — typically the columns this rebuild introduces. Any new
   * column that is in neither this list nor `columnMap` throws.
   */
  defaultedColumns?: string[];
}

/**
 * Rebuild a table using the SQLite table rebuild procedure.
 *
 * Use this when ALTER TABLE ADD COLUMN is insufficient — e.g. to add CHECK
 * constraints, change column types, add NOT NULL columns without defaults,
 * or restructure foreign keys.
 *
 * Indexes are carried across the rebuild automatically. They do not survive on
 * their own: an index follows its table through the RENAME onto the temporary
 * table and is destroyed along with it, so the definitions are captured up
 * front and replayed once the original name is free.
 *
 * @param tableName   The table to rebuild (must already exist)
 * @param newSchema   Full CREATE TABLE statement for the replacement table.
 *                    The table name must match `tableName`. Any CREATE INDEX
 *                    statements included here take precedence over the
 *                    captured definition of the same-named index.
 * @param columnMap   Maps each new column name to the corresponding old column
 *                    name (or any SQL expression valid in a SELECT against the
 *                    old table). Every column of the new table must appear here
 *                    or in `options.defaultedColumns`.
 * @param options     See {@link RecreateTableOptions}.
 */
export function recreateTable<
  NewSchema extends object,
  OldSchema extends object,
>(
  db: Database,
  tableName: string,
  newSchema: string,
  columnMap: Record<keyof NewSchema, string>,
  options: RecreateTableOptions<NewSchema, OldSchema> = {}
): void {
  const { transformRow, defaultedColumns = [] } = options;
  const tempName = `${tableName}_old`;

  db.exec('PRAGMA foreign_keys = OFF');
  // RENAME rewrites REFERENCES clauses in *other* tables to follow the new
  // name, which would leave every child table pointing at a temporary table
  // that is about to be dropped. Suppressing that needs both pragmas: with
  // foreign_keys ON, SQLite rewrites the clauses regardless of this setting.
  db.exec('PRAGMA legacy_alter_table = ON');
  try {
    // Captured before the rename, while the stored SQL still names `tableName`
    const savedIndexes = tableIndexes(db, tableName);

    db.exec(`ALTER TABLE ${tableName} RENAME TO ${tempName}`);

    // The originals rode the rename onto the temporary table but kept their
    // names, and index names share a namespace with tables. Freeing the names
    // now is what lets `newSchema` declare an index of its own.
    for (const { name } of savedIndexes) {
      db.exec(`DROP INDEX IF EXISTS ${name}`);
    }

    db.exec(newSchema);

    assertColumnsAccountedFor(db, tableName, columnMap, defaultedColumns);

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
            return transformed[src ?? col] ?? null;
          });
          db.run(insertSql, rowValues);
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

    // Whatever `newSchema` declared for itself stands; the rest are restored.
    const taken = allIndexNames(db);
    for (const { name, sql } of savedIndexes) {
      if (taken.has(name)) continue;
      try {
        db.exec(sql);
      } catch (error) {
        throw new Error(
          `recreateTable(${tableName}): could not restore index ${name}. ` +
            `If the rebuild drops a column the index covers, redeclare or omit it in newSchema.`,
          { cause: error }
        );
      }
    }
  } finally {
    db.exec('PRAGMA legacy_alter_table = OFF');
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

  // Outside the loop deliberately: `PRAGMA foreign_keys` is a no-op inside a
  // transaction, so a migration cannot suspend enforcement for itself. The
  // prior setting is restored rather than forced on, since whether to enforce
  // is the caller's policy — a database mid-chain has no unique parent keys to
  // enforce against.
  const foreignKeysWereOn = db.exec('PRAGMA foreign_keys')[0]?.values[0]?.[0];
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (const migration of pendingMigrations) {
      try {
        db.exec('BEGIN');
        migration.up(db);
        db.exec(`PRAGMA user_version = ${migration.version}`);
        db.exec('COMMIT');
      } catch (error: unknown) {
        db.exec('ROLLBACK');
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${migration.version} failed: ${reason}`, {
          cause: error,
        });
      }
    }
  } finally {
    db.exec(`PRAGMA foreign_keys = ${foreignKeysWereOn ? 'ON' : 'OFF'}`);
  }

  return true;
}
