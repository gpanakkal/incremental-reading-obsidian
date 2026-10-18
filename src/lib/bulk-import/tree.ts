import type { TFile } from 'obsidian';
import type { ScanEvent } from './types';

/** A file row, and its path from where its source starts, which it shows. */
export interface TreeFile {
  kind: 'file';
  file: TFile;
  relativePath: string;
}

/**
 * A folder row: its name, whether its scan is still running (a spinner after
 * the name), and the rows under it, in the order they were found.
 */
export interface TreeFolder {
  kind: 'folder';
  path: string;
  name: string;
  scanning: boolean;
  entries: TreeEntry[];
}

export type TreeEntry = TreeFile | TreeFolder;

/**
 * The tree of rows a scan's `events` describe, top level first. Each row goes
 * at the bottom of the folder it was reported in, or at the top level when
 * that folder was never reported; a source reports a folder's subfolders
 * before its files, so folders come first, as in the file explorer. A folder whose scan finished with no file
 * anywhere under it, its subfolders' scans finished too, is left out; while
 * any of them still runs it stays, so a folder never goes and comes back.
 * Once the scan is `finished`, even by failing, no folder is still scanning.
 */
export function buildTree(
  events: Iterable<ScanEvent>,
  finished = false
): TreeEntry[] {
  const top: TreeEntry[] = [];
  const folders = new Map<string, TreeFolder>();
  const rowsOf = (parent: string | null) =>
    (parent === null ? undefined : folders.get(parent)?.entries) ?? top;
  for (const event of events) {
    if (event.type === 'file') {
      const { file, relativePath } = event;
      rowsOf(event.parent).push({ kind: 'file', file, relativePath });
    } else if (event.type === 'folder') {
      if (folders.has(event.path)) continue;
      // Looked up first, so a folder reported as its own parent can't hide
      // itself inside itself
      const rows = rowsOf(event.parent);
      const folder: TreeFolder = {
        kind: 'folder',
        path: event.path,
        name: event.path.slice(event.path.lastIndexOf('/') + 1),
        scanning: !finished,
        entries: [],
      };
      folders.set(event.path, folder);
      rows.push(folder);
    } else {
      const folder = folders.get(event.path);
      if (folder) folder.scanning = false;
    }
  }
  return withoutEmptyFolders(top);
}

function withoutEmptyFolders(entries: readonly TreeEntry[]): TreeEntry[] {
  return entries.flatMap((entry): TreeEntry[] => {
    if (entry.kind === 'file') return [entry];
    const kept = withoutEmptyFolders(entry.entries);
    return entry.scanning || kept.length > 0
      ? [{ ...entry, entries: kept }]
      : [];
  });
}

/**
 * Whether the top level of the tree a scan's `events` describe may still gain
 * rows: the scan has not `finished`, even by failing, nor reported done the
 * folder it starts from (a `folder-done` for a folder it never reported).
 */
export function topLevelScanning(
  events: Iterable<ScanEvent>,
  finished = false
): boolean {
  if (finished) return false;
  const reported = new Set<string>();
  for (const event of events) {
    if (event.type === 'folder') reported.add(event.path);
    else if (event.type === 'folder-done' && !reported.has(event.path)) {
      return false;
    }
  }
  return true;
}

/** The files of `entries`, top to bottom as the tree shows them. */
export function treeFiles(entries: readonly TreeEntry[]): TFile[] {
  return entries.flatMap((entry) =>
    entry.kind === 'file' ? [entry.file] : treeFiles(entry.entries)
  );
}
