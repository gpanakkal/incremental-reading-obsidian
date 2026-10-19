import type { ExplorerComparator } from '#/lib/explorer-order';
import type { TFile, TFolder } from 'obsidian';
import {
  inDataDirectory,
  isImportCandidate,
  type CandidateChecks,
} from './candidates';
import type { CandidateSource, ScanEvent } from './types';

/**
 * The vault root's path: where the top-level rows are. It is never reported
 * as a folder, so its end is the top level's.
 */
const ROOT = '/';

const pathOf = (folder: TFolder | null) => folder?.path ?? ROOT;

/**
 * `files` laid out as the tree they make in the vault, as a scan would
 * report every one of them: rooted at the vault, each folder that holds one
 * of them, however deep, reported once and nothing else, each level in the
 * order `compare` puts it in (the file explorer's, see `explorerComparator`),
 * files `compare` ties in the order given. A file given twice is listed once,
 * and nothing in the data directory is listed, since nothing in it can be
 * imported.
 *
 * Breadth-first, as the folder source scans: the top-level folders, then the
 * vault root's files, then the end of the top level; then each folder in
 * turn, top to bottom a level at a time, has its subfolders announced, its
 * files and its end. Each row's path is the file's own, from the vault root.
 */
export function arrangeList(
  files: readonly TFile[],
  compare: ExplorerComparator
): ScanEvent[] {
  // What each folder holds, by path
  const held = new Map<
    string,
    { folders: Map<string, TFolder>; files: Set<TFile> }
  >();
  const at = (path: string) => {
    let entries = held.get(path);
    if (!entries) {
      entries = { folders: new Map(), files: new Set() };
      held.set(path, entries);
    }
    return entries;
  };
  at(ROOT);
  for (const file of files) {
    if (inDataDirectory(file.path)) continue;
    at(pathOf(file.parent)).files.add(file);
    for (let dir = file.parent; dir && dir.path !== ROOT; dir = dir.parent) {
      at(pathOf(dir.parent)).folders.set(dir.path, dir);
    }
  }

  const events: ScanEvent[] = [];
  /** `path`'s subfolders announced, its files and its end; the subfolders. */
  const enter = (path: string): TFolder[] => {
    const entries = at(path);
    const subs = [...entries.folders.values()].sort(compare);
    for (const sub of subs) {
      events.push({
        type: 'folder',
        path: sub.path,
        parent: path === ROOT ? null : path,
      });
    }
    for (const file of [...entries.files].sort(compare)) {
      events.push({
        type: 'file',
        file,
        parent: path,
        relativePath: file.path,
      });
    }
    events.push({ type: 'folder-done', path });
    return subs;
  };
  const queue = enter(ROOT);
  for (const dir of queue) queue.push(...enter(dir.path));
  return events;
}

/**
 * The files of a list known up front, a tag's or a search's matches, laid
 * out as {@link arrangeList} lays them out, with only those that can be
 * imported (`isImportCandidate`) listed: each file checked once the one
 * before it has been, so its row shows as soon as it passes. A folder shows
 * whether or not anything in it passes; the dialog leaves out one that ends
 * up empty. As the folder source does, it checks a file once for its life.
 *
 * `title` names the list in the summary notice (`n of y imported from
 * {title}`). It has no "Include subfolders": the list is all there is.
 */
export function listSource(
  files: readonly TFile[],
  checks: CandidateChecks,
  compare: ExplorerComparator,
  title: string
): CandidateSource {
  const events = arrangeList(files, compare);

  // As in the folder source: a file keeps its first answer for the dialog's life
  const verdicts = new Map<TFile, Promise<boolean>>();
  const verdict = (file: TFile) => {
    let known = verdicts.get(file);
    if (!known) {
      known = isImportCandidate(file, checks).catch((error: unknown) => {
        // A file that can't be read hides only itself
        console.error(error);
        return false;
      });
      verdicts.set(file, known);
    }
    return known;
  };

  return {
    title,
    heading: 'Bulk import',
    async *scan(signal) {
      for (const event of events) {
        if (signal.aborted) return;
        if (event.type === 'file') {
          const passes = await verdict(event.file);
          if (signal.aborted) return;
          if (!passes) continue;
        }
        yield event;
      }
    },
  };
}
