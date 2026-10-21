import type { Database } from 'sql.js';

/**
 * The tables whose rows are synced between devices, and so carry a stamp
 * (`updated_at`, `updated_by`) saying which copy of a row is newer, and a
 * `deleted` flag in place of ever being deleted.
 */
export const SYNCED_TABLES = [
  'article',
  'article_review',
  'snippet',
  'snippet_review',
  'srs_card',
  'srs_card_review',
  'rebind',
] as const;

export type SyncedTable = (typeof SYNCED_TABLES)[number];

/** The columns that hold a row's stamp rather than its content. */
export const STAMP_COLUMNS = ['updated_at', 'updated_by'] as const;

/** Where stamps come from: this device, at this moment. */
export interface StampSource {
  /** This device's id, stored in `updated_by` (see `getDeviceId`). */
  deviceId: () => string;
  /** Wall-clock milliseconds; may go backwards, which stamps never do. */
  now: () => number;
}

/** The start of the error a refused `DELETE` of a synced row raises. */
export const HARD_DELETE_REFUSED = 'Synced rows are tombstoned, never deleted:';

const NOW_FUNCTION = 'ir_stamp_now';
const DEVICE_FUNCTION = 'ir_stamp_device';
const TRIGGER_KINDS = ['same', 'update', 'insert', 'delete'] as const;

function triggerName(table: string, kind: (typeof TRIGGER_KINDS)[number]) {
  return `ir_stamp_${table}_${kind}`;
}

/** The columns of `table`: none, for a table that isn't there. */
function columnsOf(db: Database, table: string): string[] {
  return db
    .exec(`PRAGMA table_info(${table})`)
    .flatMap(({ values }) => values.map((row) => String(row[1])));
}

/**
 * `NEW.x IS OLD.x AND ...` over `columns`, byte for byte: under a column's own
 * collation (NOCASE, say) a change of case would compare equal, and the write
 * would be skipped as one that changed nothing.
 */
function unchanged(columns: readonly string[]): string {
  return columns
    .map((c) => `NEW.${c} IS OLD.${c} COLLATE BINARY`)
    .join(' AND ');
}

/**
 * Stamp every row of a synced table that a write changes, on `db`'s
 * connection, so no caller can forget to: `updated_at = max(previous + 1,
 * now)`, which only goes up however the clock moves, and `updated_by` = this
 * device. Done by temporary triggers, which live on the connection and are
 * never saved into the file, so a database read by a plugin version without
 * them still writes. sql.js closes the connection on every `export`, taking
 * them with it, so they are armed again after each save, as the update hook is.
 *
 * - A row an `UPDATE` would leave exactly as it was is skipped
 *   (`RAISE(IGNORE)`): not stamped, not counted by `getRowsModified`, and not
 *   reported to the update hook, so a same-value write looks like no write.
 * - A changed row is stamped unless the statement set its stamp itself, as
 *   copying another device's row will.
 * - An inserted row is stamped unless it came with a stamp (`updated_at` > 0).
 * - A `DELETE` is refused (`RAISE(ABORT)`), cascades included: a synced row
 *   is tombstoned (`deleted = 1`), or the next merge brings it back from a
 *   device that still has it. Only retention's pruning and migrations delete,
 *   disarmed (see {@link withHardDeletesAllowed}).
 *
 * Tables that have no stamp columns yet (a database still to be migrated) are
 * left alone; arm again once they have them. Arming again replaces the
 * triggers, so columns added since are covered.
 */
export function armRowStamps(db: Database, source: StampSource): void {
  disarmRowStamps(db);
  const stamped = SYNCED_TABLES.map(
    (table) => [table, columnsOf(db, table)] as const
  ).filter(([, columns]) => STAMP_COLUMNS.every((c) => columns.includes(c)));
  if (stamped.length === 0) return;
  db.create_function(NOW_FUNCTION, () => source.now());
  db.create_function(DEVICE_FUNCTION, () => source.deviceId());
  for (const [table, columns] of stamped) {
    const stampUnchanged = unchanged(STAMP_COLUMNS);
    const stamp = (previous: string) =>
      `UPDATE ${table} SET ` +
      `updated_at = max(${previous}.updated_at + 1, ${NOW_FUNCTION}()), ` +
      `updated_by = ${DEVICE_FUNCTION}() WHERE rowid = NEW.rowid;`;
    db.exec(`
      CREATE TEMP TRIGGER ${triggerName(table, 'same')}
      BEFORE UPDATE ON main.${table}
      WHEN ${unchanged(columns)}
      BEGIN SELECT RAISE(IGNORE); END;

      CREATE TEMP TRIGGER ${triggerName(table, 'update')}
      AFTER UPDATE ON main.${table}
      WHEN ${stampUnchanged}
      BEGIN ${stamp('OLD')} END;

      CREATE TEMP TRIGGER ${triggerName(table, 'insert')}
      AFTER INSERT ON main.${table}
      WHEN NEW.updated_at = 0
      BEGIN ${stamp('NEW')} END;

      CREATE TEMP TRIGGER ${triggerName(table, 'delete')}
      BEFORE DELETE ON main.${table}
      BEGIN SELECT RAISE(ABORT, '${HARD_DELETE_REFUSED} ${table}'); END;
    `);
  }
}

/**
 * Take the stamp triggers off `db`'s connection, as migrations need: a table
 * rebuild renames tables the triggers name, and a migration's own writes are
 * no device's edits. Takes the guard against deleting synced rows off too.
 */
export function disarmRowStamps(db: Database): void {
  for (const table of SYNCED_TABLES) {
    for (const kind of TRIGGER_KINDS) {
      db.exec(`DROP TRIGGER IF EXISTS temp.${triggerName(table, kind)}`);
    }
  }
}

/**
 * Run `work` with the stamp triggers, and with them the guard against
 * deleting synced rows, off `db`'s connection, arming them again from
 * `source` afterwards, whether `work` returns or throws. For deletes that
 * must not reach other devices as edits: retention's pruning of rows every
 * device has long since tombstoned.
 */
export function withHardDeletesAllowed<T>(
  db: Database,
  source: StampSource,
  work: () => T
): T {
  disarmRowStamps(db);
  try {
    return work();
  } finally {
    armRowStamps(db, source);
  }
}
