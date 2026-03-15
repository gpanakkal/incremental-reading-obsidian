import type { Database } from 'sql.js';

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
 * This is a pure SQL operation — backup and verification are handled by the caller.
 * @param db The SQLite database instance
 * @returns The new schema version
 */
export function applyMigrations(db: Database): number {
  const currentVersion = getSchemaVersion(db);
  const pendingMigrations = getPendingMigrations(db);

  if (pendingMigrations.length === 0) {
    return currentVersion;
  }

  console.info(`Applying ${pendingMigrations.length} migration(s)...`);

  for (const migration of pendingMigrations) {
    try {
      console.info(
        `Applying migration ${migration.version}: ${migration.description}`
      );
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      console.info(`Migration ${migration.version} applied successfully`);
    } catch (error) {
      console.error(`Migration ${migration.version} failed:`, error);
      throw new Error(`Migration ${migration.version} failed: ${error}`);
    }
  }

  const newVersion = getSchemaVersion(db);
  console.info(`Database schema updated to version ${newVersion}`);

  return newVersion;
}
