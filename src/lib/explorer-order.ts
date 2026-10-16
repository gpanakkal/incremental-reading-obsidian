import { TFile, type TAbstractFile, type Workspace } from 'obsidian';
import type { FileExplorerViewSortOrder } from 'obsidian-typings';

/**
 * Orders the entries of one folder: negative when `a` comes first, positive
 * when `b` does, zero when the order has no preference.
 */
export type ExplorerComparator = (a: TAbstractFile, b: TAbstractFile) => number;

/**
 * Compares names the way the file explorer does: case and accents aside,
 * digits as numbers, so `part 2` comes before `Part 10`. These are the
 * collator options Obsidian 1.13.7 sorts the explorer with.
 */
const names = new Intl.Collator(undefined, {
  usage: 'sort',
  sensitivity: 'base',
  numeric: true,
});

type FileComparator = (a: TFile, b: TFile) => number;

const alphabetical: FileComparator = (a, b) =>
  names.compare(a.basename, b.basename);
const byModifiedTime: FileComparator = (a, b) => b.stat.mtime - a.stat.mtime;
const byCreatedTime: FileComparator = (a, b) => b.stat.ctime - a.stat.ctime;
const reversed =
  (compare: FileComparator): FileComparator =>
  (a, b) =>
    -compare(a, b);

/**
 * How the file explorer orders files under each of its sort orders, as
 * Obsidian 1.13.7 does it: names without their extension, newest first by
 * time, and each `…Reverse` the negation of the order it reverses.
 */
const FILE_ORDERS: Record<FileExplorerViewSortOrder, FileComparator> = {
  alphabetical,
  alphabeticalReverse: reversed(alphabetical),
  byModifiedTime,
  byModifiedTimeReverse: reversed(byModifiedTime),
  byCreatedTime,
  byCreatedTimeReverse: reversed(byCreatedTime),
};

/**
 * Orders the entries of a folder as the file explorer lists them under
 * `order`: folders first, by name whatever the order, then files by `order`.
 * Ties are left as the folder holds them, which a stable sort of
 * `folder.children` keeps, as the explorer's own sort does.
 *
 * This re-implements the explorer's comparator rather than asking the
 * explorer to sort (its undocumented `getSortedFolderItems`), which returns
 * only the entries it has rendered.
 */
export function explorerComparator(
  order: FileExplorerViewSortOrder
): ExplorerComparator {
  const compareFiles = FILE_ORDERS[order];
  // A folder holds files and folders only, so what isn't a file is a folder
  return (a, b) => {
    if (a instanceof TFile) {
      return b instanceof TFile ? compareFiles(a, b) : 1;
    }
    return b instanceof TFile ? -1 : names.compare(a.name, b.name);
  };
}

/**
 * The order the file explorer lists files in right now; A to Z when no
 * explorer is open or its order is one this doesn't know, as the explorer
 * itself falls back.
 */
export function readExplorerSortOrder(
  workspace: Pick<Workspace, 'getLeavesOfType'>
): FileExplorerViewSortOrder {
  // Undocumented (checked against Obsidian 1.13.7): the explorer keeps its
  // order in its view state, under `sortOrder`. Reading it from the state
  // rather than `view.sortOrder` also works while the explorer is still a
  // deferred view, which holds the state the explorer will be opened with
  // and answers it from `getState`.
  // `getState` is typed as always answering, which a deferred view doesn't
  const state = workspace
    .getLeavesOfType('file-explorer')[0]
    ?.view.getState() as Record<string, unknown> | undefined;
  const order = state?.sortOrder;
  return typeof order === 'string' && Object.hasOwn(FILE_ORDERS, order)
    ? (order as FileExplorerViewSortOrder)
    : 'alphabetical';
}
