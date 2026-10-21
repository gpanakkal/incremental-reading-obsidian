import { BACKUP_DIRECTORY, MS_PER_DAY } from '#/lib/constants';
import { type DataAdapter, normalizePath } from 'obsidian';
import type { Database } from 'sql.js';
import {
  type StampSource,
  type SyncedTable,
  withHardDeletesAllowed,
} from './row-stamps';
import { readWriteVector, STALE_AFTER_MS } from './write-stamp';

/**
 * Retention: what keeps `.backups` and the database from growing forever.
 *
 * - Backups: of each kind (see {@link BackupKind}), the newest
 *   {@link BACKUP_KEEP_COUNT} and every one {@link BACKUP_KEEP_MS} old or
 *   younger are kept; of migration backups, the newest of each schema version
 *   is kept as well, however old.
 * - Rows: a tombstone (`deleted = 1`) more than {@link STALE_AFTER_MS} old is
 *   deleted, with the rows that belong to it (its reviews, its `rebind` row).
 *   No merge spans a longer gap: a device that far behind is stale, and its
 *   file is never merged (see `classifyIncoming`), so no copy of the row can
 *   come back from it. An unstamped tombstone (`updated_at = 0`, tombstoned
 *   before stamps began in v11) has no known age and is kept, with its rows:
 *   see {@link selectTombstonesToPrune}.
 * - `write_stamp`: a device whose latest save is more than
 *   {@link STALE_AFTER_MS} old is dropped; the classifier reads a missing
 *   device as generation 0.
 *
 * "More than" throughout: something exactly as old as a window is kept.
 */

/** How many backups of each kind survive, however old. */
export const BACKUP_KEEP_COUNT = 5;

/** How long every backup survives, however many there are (30 days). */
export const BACKUP_KEEP_MS = 30 * MS_PER_DAY;

/**
 * What a backup was taken for: `merge` and `stale` back up memory before
 * another device's copy replaces rows in it, and pool together; `migration`
 * backs up the file before a schema migration (its name has no marker).
 */
export type BackupKind = 'merge' | 'stale' | 'migration';

export interface BackupFile {
  /** As listed by the adapter: vault-relative, with its folder. */
  path: string;
  /** The schema version of the database backed up. */
  version: number;
  kind: BackupKind;
  /** When it was written, from its name (milliseconds since the epoch). */
  time: number;
}

/**
 * `ir-user-data_v<version>[_<merge|stale>]_<ISO time, : and . as ->.sqlite`,
 * as {@link backupFileName} writes it.
 */
const BACKUP_NAME =
  /^ir-user-data_v(\d+)(?:_(merge|stale))?_(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)\.sqlite$/;

/** The name of a backup of a database at `version`, taken at `date`. */
export function backupFileName(
  version: number,
  kind: BackupKind,
  date: Date
): string {
  const marker = kind === 'migration' ? '' : `_${kind}`;
  const timestamp = date.toISOString().replace(/[:.]/g, '-');
  return `ir-user-data_v${version}${marker}_${timestamp}.sqlite`;
}

/**
 * Read a backup's version, kind and time from its name, or null for a file
 * that is no backup this plugin wrote, or whose time is no real date: such a
 * file is never pruned.
 */
export function parseBackupName(path: string): BackupFile | null {
  const match = BACKUP_NAME.exec(path.slice(path.lastIndexOf('/') + 1));
  if (!match) return null;
  const [, version, marker, hour, minute, second, ms] = match;
  const time = Date.parse(`${hour}:${minute}:${second}.${ms}`);
  if (Number.isNaN(time)) return null;
  return {
    path,
    version: Number(version),
    kind: (marker as 'merge' | 'stale' | undefined) ?? 'migration',
    time,
  };
}

/**
 * Newest first; a tie goes by path, later first, so the order never rests on
 * the input's. Paths are listed once each, so never equal.
 */
function newestFirst(a: { time: number; path: string }, b: typeof a) {
  return b.time - a.time || (a.path < b.path ? 1 : -1);
}

/**
 * The backups among `paths` that retention deletes at `now` (see the module
 * doc), in the order given. Files that are no backup are never among them.
 */
export function selectBackupsToPrune(
  paths: readonly string[],
  now: number
): string[] {
  const backups = paths
    .map(parseBackupName)
    .filter((backup): backup is BackupFile => backup !== null)
    .sort(newestFirst);
  const kept = new Set<string>();
  const counts = new Map<'memory' | 'migration', number>();
  const versionsKept = new Set<number>();
  for (const { path, kind, version, time } of backups) {
    const pool = kind === 'migration' ? 'migration' : 'memory';
    const rank = counts.get(pool) ?? 0;
    counts.set(pool, rank + 1);
    const newestOfVersion = kind === 'migration' && !versionsKept.has(version);
    if (newestOfVersion) versionsKept.add(version);
    if (
      rank < BACKUP_KEEP_COUNT ||
      now - time <= BACKUP_KEEP_MS ||
      newestOfVersion
    ) {
      kept.add(path);
    }
  }
  const pruned = new Set(
    backups.filter(({ path }) => !kept.has(path)).map(({ path }) => path)
  );
  return paths.filter((path) => pruned.has(path));
}

/**
 * Delete the backups in `BACKUP_DIRECTORY` that retention lets go at `now`
 * (see {@link selectBackupsToPrune}). A file that fails to delete is logged
 * and left for next time; the others still go.
 * @returns the paths deleted
 */
export async function pruneBackups(
  adapter: Pick<DataAdapter, 'exists' | 'list' | 'remove'>,
  now: number
): Promise<string[]> {
  const folder = normalizePath(BACKUP_DIRECTORY);
  if (!(await adapter.exists(folder))) return [];
  const { files } = await adapter.list(folder);
  const pruned: string[] = [];
  for (const path of selectBackupsToPrune(files, now)) {
    try {
      await adapter.remove(path);
      pruned.push(path);
    } catch (error) {
      console.warn(
        'Incremental Reading - Could not delete an old backup:',
        path,
        error
      );
    }
  }
  return pruned;
}

/** Whether something written at `time` is past the sync horizon at `now`. */
export function pastSyncHorizon(time: number, now: number): boolean {
  return now - time > STALE_AFTER_MS;
}

/** A synced table, the column that keys it, and the item it belongs to. */
interface PrunedTable {
  table: SyncedTable;
  key: string;
  /** For a table of rows that belong to an item: that item's table, and the
   * column holding its id */
  parent?: { table: SyncedTable; column: string };
}

/**
 * Every synced table, rows that belong to an item before item rows, so no
 * delete leaves a row pointing at an item already gone. A snippet or card
 * made from an item does not belong to it (`parent` is a plain id, no foreign
 * key), and outlives it.
 */
export const PRUNED_TABLES: readonly PrunedTable[] = [
  {
    table: 'article_review',
    key: 'id',
    parent: { table: 'article', column: 'article_id' },
  },
  {
    table: 'rebind',
    key: 'article_id',
    parent: { table: 'article', column: 'article_id' },
  },
  {
    table: 'snippet_review',
    key: 'id',
    parent: { table: 'snippet', column: 'snippet_id' },
  },
  {
    table: 'srs_card_review',
    key: 'id',
    parent: { table: 'srs_card', column: 'card_id' },
  },
  { table: 'article', key: 'id' },
  { table: 'snippet', key: 'id' },
  { table: 'srs_card', key: 'id' },
];

/** The item table each table's rows belong to, for those that belong to one. */
const PARENT_TABLE = new Map(
  PRUNED_TABLES.flatMap(({ table, parent }) =>
    parent ? [[table, parent.table] as const] : []
  )
);

/** A row retention may delete: a tombstone, or a row of a tombstoned item. */
export interface PruneCandidate {
  table: SyncedTable;
  key: string;
  /** The id of the item the row belongs to, for a row of a table whose rows
   * belong to one (see {@link PRUNED_TABLES}); otherwise ignored */
  parent: string | null;
  deleted: boolean;
  /** The row's stamp; 0 for one never written since stamps began (v11) */
  updatedAt: number;
}

/**
 * The rows among `rows` that retention deletes at `now`: every stamped
 * tombstone past the sync horizon (see {@link pastSyncHorizon}), and every
 * row that belongs to an item deleted so, tombstone or not, so nothing
 * outlives the item it belongs to.
 *
 * An unstamped tombstone (`updated_at = 0`) is never pruned by age: it was
 * tombstoned before stamps began (v11), and its age is unknown, so pruning it
 * would delete every legacy tombstone on the first startup after the upgrade.
 * Its rows are not pruned through it either; one that is a stamped tombstone
 * past the horizon itself still goes on its own. Such a tombstone stays until
 * a real write stamps it, which for a tombstone normally never happens: a
 * bounded cost (the rows deleted before the upgrade). Keeping it changes no
 * merge: row merging already counts an unstamped tombstone as seen by every
 * device (0169).
 */
export function selectTombstonesToPrune(
  rows: readonly PruneCandidate[],
  now: number
): PruneCandidate[] {
  const expired = (row: PruneCandidate) =>
    row.deleted && row.updatedAt > 0 && pastSyncHorizon(row.updatedAt, now);
  // Keyed loosely: a row of no item's table looks up `undefined`, and one
  // that names no item `null`, neither of which is ever there
  const prunedItems = new Map<SyncedTable | undefined, Set<string | null>>();
  for (const { table, key } of rows.filter(expired)) {
    prunedItems.set(table, (prunedItems.get(table) ?? new Set()).add(key));
  }
  return rows.filter(
    (row) =>
      expired(row) ||
      (prunedItems.get(PARENT_TABLE.get(row.table))?.has(row.parent) ?? false)
  );
}

/** Read every row {@link selectTombstonesToPrune} could pick from `db`. */
export function readPruneCandidates(db: Database): PruneCandidate[] {
  return PRUNED_TABLES.flatMap(({ table, key, parent }) => {
    const sql = parent
      ? `SELECT ${key}, ${parent.column}, deleted, updated_at FROM main.${table}
         WHERE deleted = 1 OR ${parent.column} IN
           (SELECT id FROM main.${parent.table} WHERE deleted = 1)`
      : `SELECT ${key}, NULL, deleted, updated_at FROM main.${table}
         WHERE deleted = 1`;
    return db.exec(sql).flatMap(({ values }) =>
      values.map(([rowKey, rowParent, deleted, updatedAt]) => ({
        table,
        key: String(rowKey),
        parent: rowParent === null ? null : String(rowParent),
        deleted: deleted === 1,
        updatedAt: Number(updatedAt),
      }))
    );
  });
}

export interface PruneReport {
  /** Synced rows deleted */
  rows: number;
  /** `write_stamp` devices dropped */
  devices: number;
}

const PRUNE_TABLE = 'ir_prune';

/**
 * Delete from `db` what retention lets go of at `now`: old tombstones with
 * the rows that belong to them, and devices that have not saved in as long.
 * One transaction; the stamp triggers and the delete guard are off for it
 * and armed again from `stamps` after (see `withHardDeletesAllowed`). Not
 * saved: the caller saves when anything was deleted.
 *
 * Nothing at all while the copy is itself past the sync horizon (its newest
 * save, of any device, is that old, or it has no stamp yet): it is the stale
 * copy of a device that has been away, and the save after a prune would
 * stamp it as current, so a peer's file that should replace it (0168's
 * stale-self) would be merged with it instead, and the rows that peer pruned
 * would come back from it. A peer's file or a write of its own brings it up
 * to date first.
 * @throws if a statement fails, having rolled back and deleted nothing
 */
export function pruneDatabase(
  db: Database,
  now: number,
  stamps: StampSource
): PruneReport {
  const vector = Object.entries(readWriteVector(db) ?? {});
  const current = vector.some(([, gen]) => !pastSyncHorizon(gen, now));
  if (!current) return { rows: 0, devices: 0 };
  const rows = selectTombstonesToPrune(readPruneCandidates(db), now);
  const devices = vector
    .filter(([, generation]) => pastSyncHorizon(generation, now))
    .map(([device]) => device);
  if (rows.length === 0 && devices.length === 0) return { rows: 0, devices: 0 };
  withHardDeletesAllowed(db, stamps, () => {
    db.exec('BEGIN');
    try {
      db.exec(`
        DROP TABLE IF EXISTS temp.${PRUNE_TABLE};
        CREATE TEMP TABLE ${PRUNE_TABLE} (tbl TEXT NOT NULL, key TEXT NOT NULL);
      `);
      for (const { table, key } of rows) {
        db.run(`INSERT INTO temp.${PRUNE_TABLE} (tbl, key) VALUES (?, ?)`, [
          table,
          key,
        ]);
      }
      for (const { table, key } of PRUNED_TABLES) {
        db.exec(
          `DELETE FROM main.${table} WHERE ${key} IN
             (SELECT key FROM temp.${PRUNE_TABLE} WHERE tbl = '${table}')`
        );
      }
      for (const device of devices) {
        db.run('DELETE FROM main.write_stamp WHERE device = ?', [device]);
      }
      db.exec(`DROP TABLE temp.${PRUNE_TABLE}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
  return { rows: rows.length, devices: devices.length };
}
