import { applyMigrations, type Migration } from '#/db/migration-helpers';
import type initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import { markPhase } from './phase-timing';
import {
  armRowStamps,
  disarmRowStamps,
  STAMP_COLUMNS,
  type StampSource,
  type SyncedTable,
} from './row-stamps';
import {
  readDivergences,
  replaySchedules,
  type ReplaySettings,
} from './scheduling-replay';

/** How a synced table's rows are merged with another device's copy. */
export interface MergeTable {
  name: SyncedTable;
  /** The primary key: the rows of both copies that are the same row. */
  key: string;
  /**
   * A review log: its rows are only ever added or tombstoned (undo), so the
   * merge takes their union. Merged by the same rule as every other table;
   * 0170 reads it to replay scheduling from a merged log.
   */
  log: boolean;
  /**
   * A column `UNIQUE` besides the key. Two rows may end up claiming one value
   * (one note imported on both devices, say); all but one give it up.
   */
  unique?: string;
}

/**
 * Every synced table, parents before children so that a row is never written
 * before the row its foreign key names.
 */
export const MERGE_TABLES: readonly MergeTable[] = [
  { name: 'article', key: 'id', log: false, unique: 'reference' },
  { name: 'snippet', key: 'id', log: false, unique: 'reference' },
  { name: 'srs_card', key: 'id', log: false, unique: 'reference' },
  { name: 'article_review', key: 'id', log: true },
  { name: 'snippet_review', key: 'id', log: true },
  { name: 'srs_card_review', key: 'id', log: true },
  { name: 'rebind', key: 'article_id', log: false },
];

/** What merging another device's copy into a database does, or would do. */
export interface MergeReport {
  /**
   * Rows of this device's that the merge changes and the other copy never
   * saw: a newer row from it replaced them, or they gave up a unique value
   * to one of its rows. What a backup must keep.
   */
  replaced: number;
  /** Rows the merge writes. */
  written: number;
}

/** The schema name another device's copy is attached under. */
export const INCOMING_SCHEMA = 'ir_incoming';
/**
 * The temp tables a table's merge is worked out in (see {@link planTable}),
 * a pair per table, so that every table is planned before any is written.
 */
const winOf = (table: string) => `ir_merge_win_${table}`;
const evictOf = (table: string) => `ir_merge_evict_${table}`;

/**
 * Where a row that gave up its unique value goes: the same spot
 * `evictedSpot` (moved-note-scan.ts) parks a tombstone in, a path no note can
 * have, which only that row can hold.
 */
const EVICTED_PREFIX = '/ir-evicted/';
/** A row's place while the rows being rewritten trade unique values. */
const PARKED_PREFIX = '/ir-merging/';

/**
 * Open another device's database file as a database of its own, at this
 * plugin's schema version: a file an older plugin version wrote is migrated,
 * so its rows read as unstamped rows of today's tables.
 * @throws if the file is damaged or a migration fails
 */
export function openIncoming(
  sql: initSqlJs.SqlJsStatic,
  bytes: Uint8Array,
  migrations: Migration[]
): Database {
  const incoming = new sql.Database(bytes);
  try {
    const [check] = incoming.exec('PRAGMA integrity_check');
    const status = check?.values[0]?.[0];
    if (status !== 'ok') {
      throw new Error(`integrity_check failed: ${String(status)}`);
    }
    applyMigrations(incoming, migrations);
    return incoming;
  } catch (error) {
    incoming.close();
    throw error;
  }
}

/**
 * What {@link mergeInto} would do with `incoming`, writing nothing: whether
 * this device must back itself up first.
 */
export function previewMerge(db: Database, incoming: Database): MergeReport {
  return withAttached(db, incoming, () =>
    inTransaction(
      db,
      () => false,
      () => planTables(db)
    )
  );
}

/** Work out the merge of every table (see {@link planTable}), writing none. */
function planTables(db: Database): MergeReport {
  return sum(MERGE_TABLES.map((table) => planTable(db, table)));
}

/**
 * Merge another device's copy of the database into `db`, row by row, in one
 * transaction:
 *
 * - a row only one copy has is kept or taken, tombstones included;
 * - a row both have becomes the newer of the two, whole: the later
 *   `updated_at`, then the greater `updated_by`, then (two copies of a row
 *   stamped alike, as migrations leave rows) the greater content, so that
 *   every device picks the same one;
 * - except that a live row wins over a tombstone only from a copy that holds
 *   the save the tombstone came in: a delete beats a write made without
 *   knowledge of it, newer or not, while a row restored after the delete
 *   arrived still wins;
 * - of the rows that claim one unique value, a live row keeps it over a
 *   tombstone, then the newer row; the rest are parked where no note can be;
 * - `write_stamp` becomes the newer generation of each device.
 *
 * Rows keep the stamps they came with: the stamp triggers are taken off for
 * the merge and armed again from `stamps` after it, as after a migration.
 * The result depends only on the two copies, so merging the same pair either
 * way round gives the same rows, and merging again changes nothing.
 *
 * Given `replay`, an item whose review log the two copies disagree on then
 * gets its scheduling columns from the merged log instead of the row that
 * won (see `replaySchedules`), in the same transaction: those rows are this
 * device's writes, stamped by the triggers armed again first.
 * @param replay the settings to replay review logs with; none, no replay
 * @throws if a statement fails, having rolled back and changed nothing
 */
export function mergeInto(
  db: Database,
  incoming: Database,
  stamps: StampSource,
  replay?: ReplaySettings
): MergeReport {
  return merge(db, incoming, stamps, replay, false)!;
}

/**
 * {@link mergeInto}, unless the merge would replace rows of this device's
 * that the other copy never saw (see `MergeReport.replaced`): then nothing,
 * so that the caller backs this device up first. Works the merge out once
 * where {@link previewMerge} and then {@link mergeInto} work it out twice.
 * @returns the merge's report, or null when it would replace a row and so
 * changed nothing
 * @throws if a statement fails, having rolled back and changed nothing
 */
export function mergeUnlessLossy(
  db: Database,
  incoming: Database,
  stamps: StampSource,
  replay?: ReplaySettings
): MergeReport | null {
  return merge(db, incoming, stamps, replay, true);
}

function merge(
  db: Database,
  incoming: Database,
  stamps: StampSource,
  replay: ReplaySettings | undefined,
  unlessLossy: boolean
): MergeReport | null {
  disarmRowStamps(db);
  try {
    return withAttached(db, incoming, () =>
      inTransaction(
        db,
        (report) => report !== null,
        () => {
          // Each table's plan reads only its own rows and the write stamps,
          // none of which an earlier table's writes touch, so planning them
          // all first is planning each just before it is written
          const report = planTables(db);
          markPhase('plan');
          if (unlessLossy && report.replaced > 0) return null;
          // Read before anything is written, as where a replay starts is each
          // copy's log and schedule (see `readDivergences`)
          const diverged = replay && readDivergences(db, INCOMING_SCHEMA);
          markPhase('divergences');
          for (const table of MERGE_TABLES) applyTable(db, table);
          mergeWriteStamps(db);
          markPhase('apply');
          if (diverged) {
            armRowStamps(db, stamps);
            report.written += replaySchedules(db, diverged, replay);
            markPhase('replay');
          }
          return report;
        }
      )
    );
  } finally {
    armRowStamps(db, stamps);
    markPhase('rearm');
  }
}

function sum(reports: MergeReport[]): MergeReport {
  return reports.reduce(
    (total, { replaced, written }) => ({
      replaced: total.replaced + replaced,
      written: total.written + written,
    }),
    { replaced: 0, written: 0 }
  );
}

/**
 * Run `work` in a transaction, committing only when `commit` says so of its
 * result.
 */
function inTransaction<T>(
  db: Database,
  commit: (result: T) => boolean,
  work: () => T
): T {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec(commit(result) ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Run `work` with `incoming` attached to `db` as {@link INCOMING_SCHEMA}, so
 * the merge is set-based SQL across the two.
 *
 * sql.js keeps every database as a file in its in-memory Emscripten FS,
 * named by the `filename` property (undocumented; sql.js 1.13 `api.js`).
 * sql.js does not export the FS, so attaching that file by name is the way
 * to read one database from another's SQL. Should a later sql.js drop the
 * property, the copy's rows are copied into an attached in-memory database
 * instead, row by row.
 */
function withAttached<T>(db: Database, incoming: Database, work: () => T): T {
  attach(db, incoming);
  try {
    return work();
  } finally {
    db.exec(`DETACH DATABASE ${INCOMING_SCHEMA}`);
  }
}

function attach(db: Database, incoming: Database) {
  const { filename } = incoming as unknown as { filename?: unknown };
  if (typeof filename === 'string') {
    db.run(`ATTACH DATABASE $file AS ${INCOMING_SCHEMA}`, { $file: filename });
    const [tables] = db.exec(
      `SELECT 1 FROM ${INCOMING_SCHEMA}.sqlite_master LIMIT 1`
    );
    if (tables) return;
    // Not the file sql.js keeps the copy in after all
    db.exec(`DETACH DATABASE ${INCOMING_SCHEMA}`);
  }
  copyIntoAttached(db, incoming);
}

/**
 * Attach an in-memory database to `db` and copy into it the rows of every
 * table the merge reads from `incoming`.
 */
export function copyIntoAttached(db: Database, incoming: Database) {
  db.exec(`ATTACH DATABASE ':memory:' AS ${INCOMING_SCHEMA}`);
  try {
    for (const table of [...MERGE_TABLES.map((t) => t.name), 'write_stamp']) {
      const columns = columnsOf(db, table);
      db.exec(
        `CREATE TABLE ${INCOMING_SCHEMA}.${table} AS
         SELECT * FROM main.${table} WHERE 0`
      );
      const read = incoming.prepare(
        `SELECT ${columns.join(', ')} FROM ${table}`
      );
      const write = db.prepare(
        `INSERT INTO ${INCOMING_SCHEMA}.${table} (${columns.join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})`
      );
      try {
        while (read.step()) write.run(read.get());
      } finally {
        read.free();
        write.free();
      }
    }
  } catch (error) {
    db.exec(`DETACH DATABASE ${INCOMING_SCHEMA}`);
    throw error;
  }
}

/** The columns of `table` in `db`'s main schema. */
function columnsOf(db: Database, table: string): string[] {
  return db
    .exec(`PRAGMA main.table_info(${table})`)
    .flatMap(({ values }) => values.map((row) => String(row[1])));
}

/** Where the row keyed `key` parks when it gives up its unique value. */
const evicted = (key: string) => `'${EVICTED_PREFIX}' || ${key}`;

/**
 * The columns of a row to order it by: its stamp, then (for a table with a
 * unique value) whether the row was parked, then each content column as
 * whether it holds a value and the value, so that no comparison meets a null
 * (which would order neither copy first).
 *
 * Parking keeps a row's stamp, so the parked copy and the copy it was parked
 * from tie on it; the parked copy wins the tie, or the next merge would
 * claim the value again. Any later write to the row still wins, as its stamp is later.
 */
function orderOf(
  alias: string,
  content: readonly string[],
  table: MergeTable
): string {
  const { key, unique } = table;
  return [
    `${alias}.updated_at`,
    `${alias}.updated_by`,
    ...(unique
      ? [`${alias}.${unique} IS (${evicted(`${alias}.${key}`)})`]
      : []),
    ...content.flatMap((c) => [
      `${alias}.${c} IS NOT NULL`,
      `ifnull(${alias}.${c}, 0)`,
    ]),
  ].join(', ');
}

/**
 * Whether the copy in `schema` holds the save that row `alias` came in: a
 * generation of the device that stamped it at least as high as its stamp.
 * An unstamped row counts as seen everywhere, so that a tombstone from
 * before row stamps never beats every later write.
 *
 * A per-file proxy for "the writer of the other row had seen this one":
 * exact for two devices, but with three a write that never saw a tombstone
 * can first win, by stamp, over one that did, in a copy that holds the
 * tombstone's save, and then win over the tombstone too. The exact rule needs
 * each row to carry the stamp of the version it was written over.
 */
const seenIn = (schema: string, alias: string) =>
  `(${alias}.updated_at = 0 OR coalesce((
    SELECT s.generation FROM ${schema}.write_stamp s
    WHERE s.device = ${alias}.updated_by
  ), -1) >= ${alias}.updated_at)`;

/**
 * Park a row, keeping its stamp: a stamp of its own (one past it, say) would
 * pass for a write of the device that stamped it, and could tie with that
 * device's real next write and beat it. {@link orderOf} has the parked copy
 * win over the copy it was parked from instead.
 */
const parkedSet = (key: string, unique: string) =>
  `${unique} = ${evicted(key)}`;

/**
 * Work out the merge of one table into temp tables, for {@link applyTable}:
 * `WIN` holds the other copy's rows that win, as they will be written (with
 * whether a row of this device's existed, and whether the other copy never
 * saw it), and `EVICT` the keys of this device's rows that give up their
 * unique value and are not otherwise rewritten.
 */
function planTable(db: Database, table: MergeTable): MergeReport {
  const { name, key, unique } = table;
  const [WIN, EVICT] = [winOf(name), evictOf(name)];
  const columns = columnsOf(db, name);
  const content = columns.filter(
    (c) => c !== key && !(STAMP_COLUMNS as readonly string[]).includes(c)
  );
  const newer = `(${orderOf('i', content, table)}) > (${orderOf('m', content, table)})`;
  // Most rows are alike in both copies, and none of those wins (each case
  // below then asks `newer`, which is false between equals): ruled out by
  // a plain comparison first, which costs a fraction of `newer`'s (the
  // keys, which the join matches, compare alike too)
  const same = columns.map((c) => `i.${c} IS m.${c}`).join(' AND ');
  db.exec(`
    DROP TABLE IF EXISTS temp.${WIN};
    DROP TABLE IF EXISTS temp.${EVICT};

    CREATE TEMP TABLE ${WIN} AS
    SELECT ${columns.map((c) => `i.${c}`).join(', ')},
      m.${key} IS NOT NULL AS ir_existed,
      -- The other copy never saw this device's row when it holds no save of
      -- the device that stamped it from then on. An unstamped row is what
      -- every device started from, unless the other copy holds it
      -- unstamped too (and different, or it would not win).
      CASE
        WHEN m.updated_at = 0 THEN i.updated_at = 0
        ELSE NOT ${seenIn(INCOMING_SCHEMA, 'm')}
      END AS ir_unseen
    FROM ${INCOMING_SCHEMA}.${name} i
    LEFT JOIN main.${name} m ON m.${key} = i.${key}
    WHERE m.${key} IS NULL OR NOT (${same}) AND CASE
      -- A delete beats a write made without knowledge of it, whichever is
      -- newer: a live row wins over a tombstone only from a copy that holds
      -- the save the tombstone came in (see seenIn), and a tombstone wins
      -- over a newer live row from a copy that does not
      WHEN i.deleted = 0 AND m.deleted = 1
        THEN ${newer} AND ${seenIn(INCOMING_SCHEMA, 'm')}
      WHEN i.deleted = 1 AND m.deleted = 0
        THEN ${newer} OR NOT ${seenIn('main', 'i')}
      ELSE ${newer}
    END;

    CREATE INDEX temp.${WIN}_key ON ${WIN} (${key});

    CREATE TEMP TABLE ${EVICT} (evicted PRIMARY KEY);
  `);
  if (unique) {
    const parked = parkedSet(key, unique);
    // Only a value one of the winning rows brings can be claimed twice: the
    // rows of each copy hold theirs once each
    db.exec(`
      INSERT INTO temp.${EVICT} (evicted)
      WITH claim AS (
        SELECT ${key} AS row_key, ${unique} AS value, deleted, updated_at, updated_by
        FROM temp.${WIN}
        UNION ALL
        SELECT ${key}, ${unique}, deleted, updated_at, updated_by
        FROM main.${name}
        WHERE ${unique} IN (SELECT ${unique} FROM temp.${WIN})
          AND ${key} NOT IN (SELECT ${key} FROM temp.${WIN})
      )
      SELECT row_key FROM (
        SELECT row_key, row_number() OVER (
          PARTITION BY value
          ORDER BY deleted, updated_at DESC, updated_by DESC, row_key DESC
        ) AS place
        FROM claim
      )
      WHERE place > 1;

      UPDATE temp.${WIN} SET ${parked}
      WHERE ${key} IN (SELECT evicted FROM temp.${EVICT});
      -- A temp table of this merge's own, never a synced one
      DELETE FROM temp.ir_merge_evict_${name}
      WHERE evicted IN (SELECT ${key} FROM temp.${WIN});
    `);
  }
  // This device loses a row the other copy never saw that changes, and any
  // row that gives up its unique value now
  const parkedNow = unique
    ? `(w.${unique} = ${evicted(`w.${key}`)} AND m.${unique} IS NOT w.${unique})`
    : 'FALSE';
  const sameContent = content.map((c) => `w.${c} IS m.${c}`).join(' AND ');
  const [counts] = db.exec(`
    SELECT
      (SELECT count(*) FROM temp.${WIN} w JOIN main.${name} m USING (${key})
       WHERE ${parkedNow} OR (w.ir_unseen AND NOT (${sameContent})))
      + (SELECT count(*) FROM temp.${EVICT}),
      (SELECT count(*) FROM temp.${WIN}) + (SELECT count(*) FROM temp.${EVICT})
  `);
  const [replaced, written] = counts.values[0] as number[];
  return { replaced, written };
}

/**
 * Write the merge {@link planTable} worked out for `table`. A row is rewritten
 * by `UPDATE`, never `INSERT OR REPLACE`, whose delete would restart it.
 */
function applyTable(db: Database, table: MergeTable) {
  const { name, key, unique } = table;
  const [WIN, EVICT] = [winOf(name), evictOf(name)];
  const columns = columnsOf(db, name);
  const rewritten = columns.filter((c) => c !== key);
  if (unique) {
    db.exec(`
      UPDATE main.${name} SET ${parkedSet(key, unique)}
      WHERE ${key} IN (SELECT evicted FROM temp.${EVICT});

      -- Rows trading values would otherwise collide on the way
      UPDATE main.${name} SET ${unique} = '${PARKED_PREFIX}' || ${key}
      WHERE ${key} IN (SELECT ${key} FROM temp.${WIN});
    `);
  }
  db.exec(`
    UPDATE main.${name}
    SET (${rewritten.join(', ')}) = (
      SELECT ${rewritten.map((c) => `w.${c}`).join(', ')}
      FROM temp.${WIN} w WHERE w.${key} = main.${name}.${key}
    )
    WHERE ${key} IN (SELECT ${key} FROM temp.${WIN} WHERE ir_existed);

    INSERT INTO main.${name} (${columns.join(', ')})
    SELECT ${columns.join(', ')} FROM temp.${WIN} WHERE NOT ir_existed;

    DROP TABLE temp.${WIN};
    DROP TABLE temp.${EVICT};
  `);
}

/** Take the newer generation of each device from the other copy. */
function mergeWriteStamps(db: Database) {
  db.exec(`
    INSERT INTO main.write_stamp (device, generation)
    SELECT device, generation FROM ${INCOMING_SCHEMA}.write_stamp
    WHERE typeof(device) = 'text' AND typeof(generation) IN ('integer', 'real')
    ON CONFLICT (device) DO UPDATE
      SET generation = max(generation, excluded.generation)
  `);
}
