import type { Database } from 'sql.js';

/**
 * Database migrations for schema changes
 * Each migration is applied in order and tracked via PRAGMA user_version
 */

export interface Migration {
  version: number;
  up: string; // SQL to apply
  description: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    description: 'Add start_offset and end_offset columns to snippet table',
    up: `
      ALTER TABLE snippet ADD COLUMN start_offset INTEGER DEFAULT NULL;
      ALTER TABLE snippet ADD COLUMN end_offset INTEGER DEFAULT NULL;
    `,
  },
  {
    version: 2,
    description: 'Add scroll position column to article and snippet tables',
    up: `
      ALTER TABLE article ADD COLUMN scroll_top INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE snippet ADD COLUMN scroll_top INTEGER NOT NULL DEFAULT 0;
    `,
  },
];

/**
 * Apply all necessary migrations to bring database to current schema version
 * @param db The SQLite database instance
 * @returns The new schema version
 */
export function applyMigrations(db: Database): number {
  // Get current schema version
  const result = db.exec('PRAGMA user_version');
  const currentVersion = (result[0]?.values[0]?.[0] as number) || 0;

  // console.log(`Current database schema version: ${currentVersion}`);

  // Apply migrations that haven't been applied yet
  const pendingMigrations = migrations.filter(
    (m) => m.version > currentVersion
  );

  if (pendingMigrations.length === 0) {
    // console.log('Database schema is up to date');
    return currentVersion;
  }

  console.log(`Applying ${pendingMigrations.length} migration(s)...`);

  for (const migration of pendingMigrations) {
    try {
      console.log(
        `Applying migration ${migration.version}: ${migration.description}`
      );
      db.exec(migration.up);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      console.log(`✓ Migration ${migration.version} applied successfully`);
    } catch (error) {
      console.error(`✗ Migration ${migration.version} failed:`, error);
      throw new Error(`Migration ${migration.version} failed: ${error}`);
    }
  }

  const newVersion = db.exec('PRAGMA user_version')[0]
    ?.values[0]?.[0] as number;
  console.log(`Database schema updated to version ${newVersion}`);

  return newVersion;
}
