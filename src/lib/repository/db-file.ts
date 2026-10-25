import { normalizePath, type DataAdapter } from 'obsidian';

/**
 * Writing the database file so that no cut-off write can leave it empty or
 * partial (0217).
 *
 * Obsidian's adapters write in place: desktop `writeBinary` is Node's
 * `writeFile` (truncate, then a JS-driven loop of chunk writes), and mobile
 * writes files of 5 MiB or more as an empty file followed by appended chunks.
 * "Reload app without saving" (`window.location.reload()`) or a kill between
 * the truncate and the last chunk leaves the file empty or cut short. So a
 * save goes to a hidden sibling first, is checked, and only then takes the
 * live path.
 *
 * Siblings are dotfiles: Obsidian indexes no path with a segment starting
 * with `.`, so the vault raises no event for them and Obsidian Sync never
 * carries them (the same reason `BACKUP_DIRECTORY` is hidden).
 */

/** The 16 bytes every SQLite database file starts with. */
const SQLITE_HEADER = 'SQLite format 3\0';

/** The size of a SQLite file header. */
const HEADER_BYTES = 100;

/**
 * Whether `data` looks like a whole SQLite database: the header, a valid page
 * size, and more than one page, in whole pages, as many as the header counts
 * where its count is valid (SQLite keeps it so since 3.7.0, sql.js
 * included). Every database this plugin writes has tables, so at least two
 * pages. Cheap enough to run before every write, it catches an empty or
 * cut-short buffer, not a corrupt one.
 */
export function isDatabaseBuffer(data: Uint8Array): boolean {
  if (data.byteLength < HEADER_BYTES) return false;
  for (let i = 0; i < SQLITE_HEADER.length; i++) {
    if (data[i] !== SQLITE_HEADER.charCodeAt(i)) return false;
  }
  const header = new DataView(data.buffer, data.byteOffset, HEADER_BYTES);
  // 1 stands for 65536
  const raw = header.getUint16(16);
  const pageSize = raw === 1 ? 65536 : raw;
  const powerOfTwo = (pageSize & (pageSize - 1)) === 0;
  if (
    !powerOfTwo ||
    pageSize < 512 ||
    data.byteLength <= pageSize ||
    data.byteLength % pageSize !== 0
  ) {
    return false;
  }
  // The page count at 28 holds while the change counter at 24 matches the
  // "version valid for" number at 92
  const counted = header.getUint32(24) === header.getUint32(92);
  return !counted || header.getUint32(28) * pageSize === data.byteLength;
}

/** The live database file and its hidden siblings. */
export interface DbFilePaths {
  live: string;
  /** Each save is written here first. */
  tmp: string;
  /** The last live file this device wrote, kept when the next save lands. */
  prev: string;
  /** Where a live file that would not load is copied before recovery. */
  corrupt: (date: Date) => string;
}

export function dbFilePaths(livePath: string): DbFilePaths {
  const live = normalizePath(livePath);
  const slash = live.lastIndexOf('/');
  const sibling = `${live.slice(0, slash + 1)}.${live.slice(slash + 1)}`;
  return {
    live,
    tmp: `${sibling}.tmp`,
    prev: `${sibling}.prev`,
    corrupt: (date) =>
      `${sibling}.corrupt-${date.toISOString().replace(/[:.]/g, '-')}`,
  };
}

/** Enough of a file's stat to tell whether it changed since. */
export interface FileFingerprint {
  size: number;
  mtime: number;
}

/** The fingerprint of the file at `path`, or null if there is none. */
export async function fingerprintOf(
  adapter: Pick<DataAdapter, 'stat'>,
  path: string
): Promise<FileFingerprint | null> {
  const stat = await adapter.stat(path);
  return stat ? { size: stat.size, mtime: stat.mtime } : null;
}

type Replace = (from: string, to: string) => Promise<void>;

/**
 * A rename that replaces its destination in one step, where the platform has
 * one. `DataAdapter.rename` refuses an existing destination ("Destination
 * file already exists!") on desktop and mobile alike, so this reaches past
 * it, on desktop only: `FileSystemAdapter.fsPromises` is undocumented (it is
 * Node's `fs.promises`, whose `rename` replaces atomically on every desktop
 * OS); `getFullPath` is documented. Mobile has no such rename: null there.
 */
export function atomicReplace(adapter: DataAdapter): Replace | null {
  if (!isDesktopAdapter(adapter)) return null;
  const desktop = adapter;
  return (from, to) =>
    desktop.fsPromises.rename(
      desktop.getFullPath(from),
      desktop.getFullPath(to)
    );
}

/** What {@link atomicReplace} needs of desktop's `FileSystemAdapter`. */
interface DesktopAdapter {
  fsPromises: { rename(from: string, to: string): Promise<void> };
  getFullPath(path: string): string;
}

function isDesktopAdapter(
  adapter: DataAdapter
): adapter is DataAdapter & DesktopAdapter {
  const desktop = adapter as Partial<DesktopAdapter>;
  return (
    typeof desktop.fsPromises?.rename === 'function' &&
    typeof desktop.getFullPath === 'function'
  );
}

/**
 * Tell Obsidian's index the file at `path` changed behind its back, so it
 * raises `modify` at once, as its own `writeBinary` would have, rather than
 * whenever its file watcher notices. `DataAdapter.update` is undocumented
 * (desktop: `reconcileInternalFile`); without it the watcher still reports
 * the change. Null when there is nothing to wait for.
 */
function reportChange(
  adapter: DataAdapter,
  path: string
): Promise<void> | null {
  const target = adapter as { update?(path: string): Promise<void> };
  if (typeof target.update !== 'function') return null;
  return target.update(path).catch((error: unknown) => {
    console.warn('Incremental Reading - Could not report a write:', error);
  });
}

/**
 * Copy the live file to `prev`, if it is still the file `knownGood` was
 * taken of: one this device wrote or loaded, which nothing has changed since.
 * Anything else — another device's copy Sync delivered, or one cut short —
 * is no file to fall back on, so `prev` keeps what it held. Best effort: a
 * failure is logged and the save goes on.
 */
async function keepPrevious(
  adapter: DataAdapter,
  paths: DbFilePaths,
  knownGood: FileFingerprint | null
) {
  if (!knownGood) return;
  try {
    const live = await fingerprintOf(adapter, paths.live);
    if (live?.size !== knownGood.size || live.mtime !== knownGood.mtime) {
      return;
    }
    // Desktop `copy` refuses an existing destination
    if (await adapter.stat(paths.prev)) await adapter.remove(paths.prev);
    await adapter.copy(paths.live, paths.prev);
  } catch (error) {
    console.warn(
      'Incremental Reading - Could not keep the previous database file:',
      error
    );
  }
}

export interface WriteOptions {
  /**
   * Asked before each step that writes: false drops the write from there on,
   * leaving the live file as it is. For a repository disposed, or whose
   * database a reload replaced, while the write waited.
   */
  stillCurrent: () => boolean;
  /** The live file as this device last wrote or loaded it (see `keepPrevious`). */
  knownGood: () => FileFingerprint | null;
}

/** Whether the write took the live path, and the file's fingerprint if so. */
export type WriteResult =
  | { landed: false }
  | { landed: true; fingerprint: FileFingerprint | null };

/**
 * Write `data` to the live database file without ever leaving that file
 * empty or partial where the platform allows (see {@link atomicReplace}):
 *
 * 1. refuse anything but a whole database ({@link isDatabaseBuffer});
 * 2. write `tmp`, and check its size on disk;
 * 3. copy the live file to `prev` when it is one this device knows is good;
 * 4. desktop: rename `tmp` over the live file, which replaces it in one step.
 *    Elsewhere, or if that rename fails: write the live file in place and
 *    delete `tmp`. A write cut short there leaves a whole `tmp` behind,
 *    which loading recovers from.
 *
 * Callers run one at a time: two writes sharing `tmp` would mix.
 * @throws if `data` is no whole database, or a write fails or comes up short
 */
export async function writeDatabaseFile(
  adapter: DataAdapter,
  paths: DbFilePaths,
  data: ArrayBuffer,
  options: WriteOptions
): Promise<WriteResult> {
  const { stillCurrent } = options;
  if (!isDatabaseBuffer(new Uint8Array(data))) {
    throw new Error(
      `Refused to write ${data.byteLength} bytes to ${paths.live}: ` +
        `not a whole SQLite database`
    );
  }
  if (!stillCurrent()) return { landed: false };
  await adapter.writeBinary(paths.tmp, data);
  const written = await adapter.stat(paths.tmp);
  if (written?.size !== data.byteLength) {
    throw new Error(
      `Writing ${paths.tmp} came up short: ${written?.size ?? 0} of ` +
        `${data.byteLength} bytes on disk`
    );
  }
  if (!stillCurrent()) return { landed: false };
  await keepPrevious(adapter, paths, options.knownGood());
  if (!stillCurrent()) return { landed: false };
  const replace = atomicReplace(adapter);
  let replaced = false;
  if (replace) {
    try {
      await replace(paths.tmp, paths.live);
      replaced = true;
    } catch (error) {
      // Windows refuses while another process holds the file open
      console.warn(
        'Incremental Reading - Could not rename the database file into ' +
          'place; writing it in place instead:',
        error
      );
      if (!stillCurrent()) return { landed: false };
    }
  }
  if (replaced) {
    const reporting = reportChange(adapter, paths.live);
    if (reporting) await reporting;
    // A rename keeps the file's size and mtime
    return {
      landed: true,
      fingerprint: { size: written.size, mtime: written.mtime },
    };
  }
  await adapter.writeBinary(paths.live, data);
  let fingerprint: FileFingerprint | null = null;
  try {
    fingerprint = await fingerprintOf(adapter, paths.live);
    await adapter.remove(paths.tmp);
  } catch (error) {
    console.warn(
      'Incremental Reading - Could not tidy up after a save:',
      error
    );
  }
  return { landed: true, fingerprint };
}
