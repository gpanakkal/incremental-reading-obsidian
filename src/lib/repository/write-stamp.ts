import type { App } from 'obsidian';
import type initSqlJs from 'sql.js';
import type { Database } from 'sql.js';

/**
 * The write stamp of a database file: for every device that ever saved it,
 * the generation of that device's latest save (`write_stamp` table). A
 * generation is wall-clock milliseconds that never go backwards on the device
 * that writes it (`max(previous + 1, now)`), so comparing two files' stamps
 * says whether one has seen every save the other has.
 */
export type WriteVector = Readonly<Record<string, number>>;

/** A device that last saved this long before another is stale (180 days). */
export const STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * What a database file arriving on disk is, measured against the stamp of
 * the database this device holds:
 *
 * - `echo`: the same stamp; this device's own save coming back.
 * - `fast-forward`: it has every save this device's copy has, and more.
 * - `stale-self`: its newest save is more than {@link STALE_AFTER_MS} after
 *   this device's newest; this device has been away too long to merge.
 * - `stale-other`: its newest save is more than that before this device's;
 *   a device that has been away too long sent it.
 * - `behind`: this device's copy has every save it has, and more; an older
 *   save of this device's own, as a save made since overtakes the report of
 *   an earlier one.
 * - `merge`: each has saves the other lacks.
 */
export type IncomingKind =
  | 'echo'
  | 'fast-forward'
  | 'stale-self'
  | 'stale-other'
  | 'behind'
  | 'merge';

/**
 * Whether `a` has seen every save `b` has: every device of `b` is in `a`
 * at a generation at least as high.
 */
function covers(a: WriteVector, b: WriteVector): boolean {
  return Object.entries(b).every(
    ([device, generation]) => device in a && a[device] >= generation
  );
}

/**
 * The newest generation of `vector`, no later than `now`: a generation from
 * the future comes from a clock that ran ahead, and would otherwise make
 * every other device look stale.
 */
function newest(vector: WriteVector, now: number): number {
  return Math.min(now, Math.max(-Infinity, ...Object.values(vector)));
}

/**
 * Classify a database file arriving on disk (see {@link IncomingKind}).
 * @param mine the stamp of the database this device holds
 * @param theirs the stamp of the file that arrived
 * @param now this device's clock
 */
export function classifyIncoming(
  mine: WriteVector,
  theirs: WriteVector,
  now: number
): IncomingKind {
  const theirsCovers = covers(theirs, mine);
  const mineCovers = covers(mine, theirs);
  if (theirsCovers && mineCovers) return 'echo';
  if (theirsCovers) return 'fast-forward';
  const ahead = newest(theirs, now) - newest(mine, now);
  if (ahead > STALE_AFTER_MS) return 'stale-self';
  if (-ahead > STALE_AFTER_MS) return 'stale-other';
  return mineCovers ? 'behind' : 'merge';
}

/** The stamp of `db`, or null if it has no `write_stamp` table. */
export function readWriteVector(db: Database): WriteVector | null {
  const [tables] = db.exec(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'write_stamp'"
  );
  if (!tables) return null;
  // Null prototype: a device id is any string, and a plain object would
  // swallow one spelled `__proto__`.
  const vector: Record<string, number> = Object.create(null) as Record<
    string,
    number
  >;
  const rows = db
    .exec('SELECT device, generation FROM write_stamp')
    .flatMap(({ values }) => values);
  for (const [device, generation] of rows) {
    // Not STRICT, so a file edited by hand could hold anything
    if (typeof device === 'string' && Number.isFinite(generation)) {
      vector[device] = generation as number;
    }
  }
  return vector;
}

/**
 * What the database file in `bytes` is stamped with, read from a throwaway
 * copy: `unstamped` for a database older than the `write_stamp` table (an
 * older plugin version wrote it), `unreadable` for anything that does not open
 * as a database (a write still under way, say) or is at a schema version past
 * `maxVersion` (a newer plugin version wrote it), whose stamp can't be relied
 * on.
 */
export function readFileWriteVector(
  sql: initSqlJs.SqlJsStatic,
  bytes: Uint8Array,
  maxVersion: number
): WriteVector | 'unstamped' | 'unreadable' {
  let db: Database | null = null;
  try {
    db = new sql.Database(bytes);
    if (db.exec('SELECT 1 FROM sqlite_master LIMIT 1').length === 0) {
      return 'unreadable';
    }
    const [version] = db.exec('PRAGMA user_version');
    if (Number(version.values[0][0]) > maxVersion) return 'unreadable';
    return readWriteVector(db) ?? 'unstamped';
  } catch {
    return 'unreadable';
  } finally {
    db?.close();
  }
}

/**
 * Mark `db` as saved by `device` once more, just before it is exported:
 * `generation = max(previous + 1, now)`, so it only goes up however the
 * clock moves.
 * @returns the stamp the export will carry
 */
export function bumpWriteStamp(
  db: Database,
  device: string,
  now: number
): WriteVector {
  db.run(
    `INSERT INTO write_stamp (device, generation) VALUES ($1, $2)
     ON CONFLICT (device) DO UPDATE
       SET generation = max(generation + 1, excluded.generation)`,
    [device, now]
  );
  return readWriteVector(db) ?? {};
}

/**
 * The localStorage key, per vault, of the stamp of the file this device last
 * wrote or took on: what the file on disk holds unless something else wrote
 * it while the plugin was not running. Kept in localStorage, never in the
 * vault, which Sync copies to every device; `loadLocalStorage` keys by the
 * vault's `appId` (an undocumented field of `App`), as `getDeviceId` does.
 */
export const KNOWN_WRITE_STAMP_KEY = 'incremental-reading-write-stamp';

type LocalStorageApp = Pick<App, 'loadLocalStorage' | 'saveLocalStorage'>;

/** Whether `value` is a stamp as {@link saveKnownWriteVector} stores one. */
function isWriteVector(value: unknown): value is WriteVector {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => Number.isFinite(v))
  );
}

/**
 * The stamp of the file this device last wrote or took on, or null if none
 * was stored (a first run) or storage can't be read.
 */
export function loadKnownWriteVector(app: LocalStorageApp): WriteVector | null {
  try {
    const stored: unknown = app.loadLocalStorage(KNOWN_WRITE_STAMP_KEY);
    return isWriteVector(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Store `vector` as the stamp of the file this device last wrote or took on. */
export function saveKnownWriteVector(
  app: LocalStorageApp,
  vector: WriteVector
): void {
  try {
    app.saveLocalStorage(KNOWN_WRITE_STAMP_KEY, vector);
  } catch {
    // Startup then classifies against an older stamp, or none
  }
}
