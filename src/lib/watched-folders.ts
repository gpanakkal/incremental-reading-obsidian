import { DATA_DIRECTORY } from './constants';

/** Slashes and spaces around a folder's path, which name the same folder. */
const FOLDER_PADDING = /^[\s/]+|[\s/]+$/g;

/**
 * The vault path of the folder `typed` names: without the slashes and spaces
 * around it. Anything else in it, commas included, is part of the path. The
 * vault root (`/`) and a blank path read as `''`, which {@link isUnderFolder}
 * never matches.
 */
export function normalizeFolderPath(typed: string): string {
  return typed.replace(FOLDER_PADDING, '');
}

/**
 * `folders` as the watched folders are kept: each a vault path as
 * {@link normalizeFolderPath} reads it, in the order given, without repeats,
 * and without any that read as the vault root.
 */
export function cleanFolderList(folders: readonly string[]): string[] {
  const paths = folders.map(normalizeFolderPath).filter((path) => path !== '');
  return [...new Set(paths)];
}

/**
 * Whether the file or folder at vault path `path` is inside `folder`, at any
 * depth. A folder isn't inside itself, nor is `Inbox2` inside `Inbox`. The
 * vault root (`''`) holds nothing here: vault paths never start with a slash.
 */
export function isUnderFolder(path: string, folder: string): boolean {
  return path.startsWith(`${folder}/`);
}

/** Whether `path` is inside any of `folders` (see {@link isUnderFolder}). */
export function isUnderAnyFolder(
  path: string,
  folders: readonly string[]
): boolean {
  return folders.some((folder) => isUnderFolder(path, folder));
}

/**
 * Why `folder`, a vault path as {@link normalizeFolderPath} reads it, can't be
 * watched, if it can't. It has to be a folder that exists, other than the
 * vault root (every file would be imported) and the plugin's data folder,
 * where its own copies and snippets are made.
 */
export function folderToWatchProblem(
  folder: string,
  isFolder: (path: string) => boolean
): string | undefined {
  if (folder === '') {
    return "The vault root can't be watched. Name a folder in it instead.";
  }
  if (folder === DATA_DIRECTORY || isUnderFolder(folder, DATA_DIRECTORY)) {
    return `The plugin's data folder can't be watched: ${folder}`;
  }
  if (!isFolder(folder)) return `No such folder: ${folder}`;
  return undefined;
}

/**
 * Why `folders` can't be the watched folders, if they can't: none while
 * watching is on, where it would quietly import nothing.
 */
export function watchListProblem(
  folders: readonly string[],
  watching: boolean
): string | undefined {
  return watching && folders.length === 0
    ? 'Enter at least one folder, or turn off importing files added to folders.'
    : undefined;
}
