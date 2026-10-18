import type { App } from 'obsidian';
import { isUnderAnyFolder } from './watched-folders';

/**
 * localStorage key holding this device's {@link WatchedFolderLedger}.
 * Device-local, as `DEVICE_ID_KEY` is: it says which files this device has
 * seen, which no other device can speak for, so it must never sync.
 */
export const WATCHED_FOLDER_LEDGER_KEY = 'incremental-reading-watched-folders';

/**
 * What this device has seen of its watched folders. Obsidian raises `create`
 * for every file as the vault loads and keeps no record of which are new, so
 * a file written into a watched folder while Obsidian was closed can only be
 * told apart by its absence from here.
 */
export interface WatchedFolderLedger {
  /** The watched folders whose contents {@link paths} records. */
  readonly folders: readonly string[];
  /** Every file seen under {@link folders}, by vault path. */
  readonly paths: readonly string[];
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** `raw` as a ledger, or null when it is none, or not wholly one. */
export function parseLedger(raw: unknown): WatchedFolderLedger | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { folders, paths } = raw as Record<string, unknown>;
  if (!isStringArray(folders) || !isStringArray(paths)) return null;
  return { folders, paths };
}

/**
 * The files of `paths` that arrived unseen: under one of `folders` that the
 * ledger records, and not in it. A folder it doesn't record has nothing known
 * of its contents, so none of them count; see {@link reconcileLedger}.
 */
export function ledgerArrivals(
  ledger: WatchedFolderLedger,
  folders: readonly string[],
  paths: readonly string[]
): string[] {
  const recorded = folders.filter((folder) => ledger.folders.includes(folder));
  const seen = new Set(ledger.paths);
  return paths.filter(
    (path) => isUnderAnyFolder(path, recorded) && !seen.has(path)
  );
}

/**
 * The ledger for watching `folders`, where `paths` are the files there now. A
 * folder `ledger` already records keeps what it saw there, so a file that
 * arrived unseen still counts as one. Any other folder is seeded, everything
 * in it taken as seen. Folders no longer watched drop out, with their files.
 * With no ledger, every folder is seeded: the ledger is `paths` as they are.
 */
export function reconcileLedger(
  ledger: WatchedFolderLedger | null,
  folders: readonly string[],
  paths: readonly string[]
): WatchedFolderLedger {
  const kept = folders.filter((folder) => ledger?.folders.includes(folder));
  const keptPaths =
    ledger?.paths.filter((path) => isUnderAnyFolder(path, kept)) ?? [];
  // Under a folder not kept, a newly watched one
  const addedPaths = paths.filter(
    (path) => isUnderAnyFolder(path, folders) && !isUnderAnyFolder(path, kept)
  );
  return { folders: [...folders], paths: [...keptPaths, ...addedPaths] };
}

/**
 * The ledger stored under {@link WATCHED_FOLDER_LEDGER_KEY}, or null when none
 * is, or what is there is no ledger.
 */
export function loadWatchedFolderLedger(
  app: Pick<App, 'loadLocalStorage'>
): WatchedFolderLedger | null {
  return parseLedger(app.loadLocalStorage(WATCHED_FOLDER_LEDGER_KEY));
}

/** Store `ledger` under {@link WATCHED_FOLDER_LEDGER_KEY}. */
export function saveWatchedFolderLedger(
  app: Pick<App, 'saveLocalStorage'>,
  ledger: WatchedFolderLedger
): void {
  app.saveLocalStorage(WATCHED_FOLDER_LEDGER_KEY, {
    folders: [...ledger.folders],
    paths: [...ledger.paths],
  });
}
