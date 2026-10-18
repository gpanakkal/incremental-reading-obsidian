import { DATA_DIRECTORY } from '#/lib/constants';
import type { ExplorerComparator } from '#/lib/explorer-order';
import { isImportable } from '#/lib/mime';
import { TFile, TFolder, type TAbstractFile } from 'obsidian';
import {
  folderSource,
  isImportCandidate,
  type CandidateChecks,
} from './candidates';
import type { CandidateSource } from './types';

/** Whether `path` is the data directory or anything inside it. */
const inDataDirectory = (path: string) =>
  path === DATA_DIRECTORY || path.startsWith(`${DATA_DIRECTORY}/`);

/**
 * Where the selection's top-level rows are: the vault, which, its root never
 * reported as a folder (a selected root reads as the folder source on it),
 * holds them, and whose end is the top level's.
 */
const TOP = '/';

const isVaultRoot = (entry: TAbstractFile | undefined): entry is TFolder =>
  entry instanceof TFolder && entry.path === '/';

/**
 * The items of a Files-view selection that a bulk import starts from, in the
 * order given: each once, none inside a selected folder (that folder covers
 * it, as core's "Move N items to…" has it), and nothing in the data directory,
 * where nothing can be imported. The vault root covers everything.
 */
export function selectionRoots(
  selection: readonly TAbstractFile[]
): TAbstractFile[] {
  const root = selection.find(isVaultRoot);
  if (root) return [root];
  // Only a folder holds anything, so every selected item can stand as one
  const prefixes = selection.map((entry) => `${entry.path}/`);
  const seen = new Set<string>();
  return selection.filter((entry) => {
    if (seen.has(entry.path) || inDataDirectory(entry.path)) return false;
    seen.add(entry.path);
    return !prefixes.some((prefix) => entry.path.startsWith(prefix));
  });
}

/**
 * Whether a selection's import could find anything: it holds a folder, or a
 * file of a type that imports as an article. Judged by type alone, as the
 * menu it decides on is built at once.
 */
export function selectionMayImport(roots: readonly TAbstractFile[]): boolean {
  return roots.some(
    (entry) =>
      entry instanceof TFolder ||
      (entry instanceof TFile && isImportable(entry))
  );
}

/** `N items`, or `1 item`. */
export const itemCount = (count: number) =>
  `${count} item${count === 1 ? '' : 's'}`;

/**
 * The files a Files-view multi-selection offers for import (see
 * {@link selectionRoots} for which of its items count): a forest whose roots,
 * folders first, are in the order `compare` puts them in (the file
 * explorer's, see `explorerComparator`). A selected file is a top-level row
 * when it can be imported (`isImportCandidate`). A selected folder is a
 * top-level folder, walked as {@link folderSource} walks one, its rows' paths
 * from it; with subfolders, every selected folder goes deeper at once.
 *
 * Breadth-first, as far as it can be: the selected folders announced, the
 * selected files checked, the top level then done; each selected folder's
 * own files in turn; then what is under each, one selected folder after the
 * other. As the folder source does, it checks a file once for its life.
 *
 * The vault root among the selection is the whole vault, which then reads as
 * the folder source on it does.
 */
export function selectionSource(
  selection: readonly TAbstractFile[],
  checks: CandidateChecks,
  compare: ExplorerComparator
): CandidateSource {
  const roots = selectionRoots(selection).sort(compare);
  const title = itemCount(roots.length);
  const heading = `Importing ${title}`;
  const [first] = roots;
  if (isVaultRoot(first)) {
    return { ...folderSource(first, checks, compare), title, heading };
  }

  const folders = roots
    .filter((entry): entry is TFolder => entry instanceof TFolder)
    .map((folder) => ({
      folder,
      source: folderSource(folder, checks, compare),
    }));
  const files = roots.filter((entry): entry is TFile => entry instanceof TFile);

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
    heading,
    canIncludeSubfolders: folders.length > 0,
    async *scan(signal, { subfolders = false } = {}) {
      for (const { folder } of folders) {
        if (signal.aborted) return;
        yield { type: 'folder', path: folder.path, parent: null };
      }
      for (const file of files) {
        if (signal.aborted) return;
        const passes = await verdict(file);
        if (signal.aborted) return;
        if (passes) {
          yield {
            type: 'file',
            file,
            parent: TOP,
            relativePath: file.name,
          };
        }
      }
      if (signal.aborted) return;
      yield { type: 'folder-done', path: TOP };

      // Each folder's own files, up to its end, before any folder's deeper
      // ones. The first end a folder's walk reports is its own: a subfolder
      // is done only once scanned, after the folder it is in.
      const walks = folders.map(({ source }) =>
        source.scan(signal, { subfolders })[Symbol.asyncIterator]()
      );
      for (const walk of walks) {
        for (;;) {
          const next = await walk.next();
          if (next.done === true) break;
          yield next.value;
          if (next.value.type === 'folder-done') break;
        }
      }
      for (const walk of walks) {
        for (;;) {
          const next = await walk.next();
          if (next.done === true) break;
          yield next.value;
        }
      }
    },
  };
}
