import type { Database } from 'sql.js';

/**
 * Columns whose change alone is no change to a row's content. Empty: the row
 * stamps (0167, `updated_at`/`updated_by`) are content too. Their triggers
 * move a stamp only together with a value change, so leaving them out would
 * protect nothing, and a merge that brings in only a newer stamp (0169) must
 * still be saved, or a reload loses it.
 */
export const UNTRACKED_COLUMNS: ReadonlySet<string> = new Set<string>();

/** Prefix of the TEMP triggers that count content changes. */
const TRIGGER_PREFIX = 'ir_content_';
/** The SQL function those triggers call, bound to {@link ContentWatch}. */
const COUNTER_FUNCTION = 'ir_content_changed';

/** Where a write started, for {@link ContentWatch.changedSince}. */
export interface ContentMark {
  readonly changes: number;
  readonly schemaVersion: number;
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;

/** First column of every row of `sql`'s first result. */
function column(db: Database, sql: string): unknown[] {
  return db.exec(sql)[0]?.values.map((row) => row[0]) ?? [];
}

/**
 * Tells whether a write changed what the database holds, so the repository
 * can skip saving a file identical to the one on disk.
 *
 * SQLite can't say so by itself: `changes()` (sql.js `getRowsModified`)
 * counts every row an UPDATE matched, even one it rewrote with the values it
 * already had. So every table gets TEMP triggers that call back here on an
 * INSERT, a DELETE, or an UPDATE that changes a column outside
 * {@link UNTRACKED_COLUMNS} (`OLD.c IS NOT NEW.c`, byte for byte). A change
 * to the schema itself shows in `schema_version` instead.
 *
 * TEMP triggers live in the connection, not the file: they are never saved,
 * and they go when sql.js `export()` reopens the connection (along with the
 * function they call) or a reload swaps the database. {@link mark} puts them
 * back whenever they are missing or the schema has changed since. When that
 * fails, or `db` isn't a real sql.js database, every write counts as a change:
 * a save too many costs an upload, a save too few loses data.
 */
export class ContentWatch {
  /** Content changes counted so far, across connections. */
  #changes = 0;
  /** How many triggers the last install made. */
  #installed = 0;
  /** The schema version the triggers were made for. */
  #installedFor: number | null = null;

  /**
   * Note where a write starts, putting the triggers in place first.
   * @returns null when changes can't be told on `db`
   */
  mark(db: Database): ContentMark | null {
    try {
      const [version, present] = db
        .exec(
          `PRAGMA main.schema_version;
           SELECT count(*) FROM temp.sqlite_master
             WHERE type = 'trigger' AND name GLOB '${TRIGGER_PREFIX}*'`
        )
        .map((result) => result.values[0][0]);
      if (typeof version !== 'number') return null;
      if (present !== this.#installed || this.#installedFor !== version) {
        this.#install(db);
        this.#installedFor = version;
      }
      return { changes: this.#changes, schemaVersion: version };
    } catch (error) {
      console.error(
        'Incremental Reading - Could not watch the database for changes:',
        error
      );
      return null;
    }
  }

  /**
   * Whether anything changed on `db` since `mark`.
   * @returns true as well when that can't be told
   */
  changedSince(db: Database, mark: ContentMark | null): boolean {
    if (!mark) return true;
    if (this.#changes !== mark.changes) return true;
    try {
      return column(db, 'PRAGMA main.schema_version')[0] !== mark.schemaVersion;
    } catch {
      return true;
    }
  }

  #install(db: Database) {
    this.#installed = 0;
    this.#installedFor = null;
    for (const name of column(
      db,
      `SELECT name FROM temp.sqlite_master
         WHERE type = 'trigger' AND name GLOB '${TRIGGER_PREFIX}*'`
    )) {
      db.exec(`DROP TRIGGER temp.${quote(String(name))}`);
    }
    db.create_function(COUNTER_FUNCTION, () => {
      this.#changes++;
      return null;
    });

    const tables = column(
      db,
      `SELECT name FROM main.sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`
    ).map(String);
    let made = 0;
    tables.forEach((table, i) => {
      const trigger = (op: 'INSERT' | 'DELETE' | 'UPDATE', when = '') => {
        db.exec(
          `CREATE TEMP TRIGGER ${quote(`${TRIGGER_PREFIX}${i}_${op}`)}
             AFTER ${op} ON main.${quote(table)} ${when}
             BEGIN SELECT ${COUNTER_FUNCTION}(); END`
        );
        made++;
      };
      trigger('INSERT');
      trigger('DELETE');
      const tracked = column(
        db,
        `SELECT name FROM pragma_table_info(${literal(table)}, 'main')`
      )
        .map(String)
        .filter((name) => !UNTRACKED_COLUMNS.has(name));
      if (tracked.length === 0) return;
      // BINARY: under a column's own collation (NOCASE, say) a change of
      // case would compare equal and go unsaved
      const changed = tracked
        .map(
          (name) =>
            `OLD.${quote(name)} IS NOT NEW.${quote(name)} COLLATE BINARY`
        )
        .join(' OR ');
      trigger('UPDATE', `WHEN ${changed}`);
    });
    this.#installed = made;
  }
}
