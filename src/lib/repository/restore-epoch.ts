import type { App } from 'obsidian';
import type { Database } from 'sql.js';

/**
 * The restore epoch of a database file (`restore_epoch` table, one row): 0
 * for a file never restored from a backup, otherwise the epoch the latest
 * restore gave it, `max(previous + 1, now)` like a write stamp generation, so
 * restores made on two devices order by when they were made.
 *
 * A restore replaces the database with a backup on purpose, newer rows and
 * all, so a device receiving a file at a higher epoch takes it on whole
 * rather than merging its own newer rows back into it, and one receiving a
 * file at a lower epoch (made before a restore it holds) saves over it.
 * Equal epochs leave the answer to the write stamps (`classifyIncoming`).
 */
export type RestoreEpochAnswer = 'take-on' | 'save-over' | 'classify';

/** The restore epoch of a database that was never restored. */
export const NEVER_RESTORED = 0;

/**
 * The restore epoch of `db`: {@link NEVER_RESTORED} if it has no
 * `restore_epoch` table (a schema from before it), no row, or a row whose
 * epoch is no number (not STRICT, so a file edited by hand could hold
 * anything), and if the table can't be read at all (edited by hand too):
 * a file is never refused, nor its write stamp ignored, for its epoch alone.
 */
export function readRestoreEpoch(db: Database): number {
  try {
    const [rows] = db.exec('SELECT epoch FROM restore_epoch LIMIT 1');
    const epoch = rows?.values[0][0];
    return typeof epoch === 'number' && Number.isFinite(epoch)
      ? epoch
      : NEVER_RESTORED;
  } catch {
    return NEVER_RESTORED;
  }
}

/**
 * Mark `db` as restored by `device`: its epoch becomes
 * `max(previous + 1, now)`, past `previous` however the clock moves.
 * @param previous the epoch of the database the restore replaces; the
 *   backup's own is no part of it
 * @returns the epoch written
 */
export function bumpRestoreEpoch(
  db: Database,
  previous: number,
  device: string,
  now: number
): number {
  const epoch = Math.max(previous + 1, now);
  db.run(
    `INSERT INTO restore_epoch (id, epoch, device, restored_at)
     VALUES (1, $1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET
       epoch = excluded.epoch,
       device = excluded.device,
       restored_at = excluded.restored_at`,
    [epoch, device, now]
  );
  return epoch;
}

/**
 * What to do with a file arriving at restore epoch `theirs`, for a device
 * holding a database at `mine` (see {@link RestoreEpochAnswer}). Two
 * restores made in the same millisecond on two devices tie, and are then
 * classified by their write stamps like any two copies, which may merge
 * them: rare enough to accept.
 */
export function answerByRestoreEpoch(
  mine: number,
  theirs: number
): RestoreEpochAnswer {
  if (theirs > mine) return 'take-on';
  if (theirs < mine) return 'save-over';
  return 'classify';
}

/**
 * The localStorage key, per vault, of the restore epoch of the file this
 * device last wrote or took on, beside the known write stamp
 * (`KNOWN_WRITE_STAMP_KEY`), and kept out of the vault for the same reason.
 */
export const KNOWN_RESTORE_EPOCH_KEY = 'incremental-reading-restore-epoch';

type LocalStorageApp = Pick<App, 'loadLocalStorage' | 'saveLocalStorage'>;

/**
 * The restore epoch of the file this device last wrote or took on, or null
 * if none was stored (a first run, or a version from before restore epochs)
 * or storage can't be read.
 */
export function loadKnownRestoreEpoch(app: LocalStorageApp): number | null {
  try {
    const stored: unknown = app.loadLocalStorage(KNOWN_RESTORE_EPOCH_KEY);
    return typeof stored === 'number' && Number.isFinite(stored)
      ? stored
      : null;
  } catch {
    return null;
  }
}

/** Store `epoch` as that of the file this device last wrote or took on. */
export function saveKnownRestoreEpoch(
  app: LocalStorageApp,
  epoch: number
): void {
  try {
    app.saveLocalStorage(KNOWN_RESTORE_EPOCH_KEY, epoch);
  } catch {
    // Startup then compares against an older epoch, or none
  }
}
