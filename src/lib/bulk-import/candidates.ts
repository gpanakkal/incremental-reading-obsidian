import { DATA_DIRECTORY } from '#/lib/constants';
import type { ExplorerComparator } from '#/lib/explorer-order';
import { isImportable, sniffMimeType, supportsFrontmatter } from '#/lib/mime';
import { TFile, TFolder, type MetadataCache, type Vault } from 'obsidian';
import type { CandidateSource, ScanEvent } from './types';

/** What deciding whether a file can be bulk imported needs to ask. */
export interface CandidateChecks {
  app: {
    vault: Pick<Vault, 'readBinary' | 'getResourcePath'>;
    metadataCache: Pick<MetadataCache, 'getFileCache'>;
  };
  /**
   * Whether a live item row is at `file`'s path, which is all that makes a
   * file with no frontmatter, a PDF say, an item (`ReviewManager.isItemFileAt`).
   */
  isItemAtPath: (file: TFile) => boolean;
}

/**
 * Whether `file` can be offered for a bulk import: a type that imports as an
 * article, outside the data directory, not an item already (a note by the
 * `ir-id` cached for it, anything else by a live row at its path), and whose
 * content is what its extension says. The cheap checks come first, so only a
 * file that passes them has its content read.
 */
export async function isImportCandidate(
  file: TFile,
  { app, isItemAtPath }: CandidateChecks
): Promise<boolean> {
  if (file.path.startsWith(`${DATA_DIRECTORY}/`)) return false;
  if (!isImportable(file)) return false;
  const isItem = supportsFrontmatter(file)
    ? typeof app.metadataCache.getFileCache(file)?.frontmatter?.['ir-id'] ===
      'string'
    : isItemAtPath(file);
  if (isItem) return false;
  return (await sniffMimeType(app, file)) !== null;
}

/** Whether `path` is the data directory or a folder inside it. */
const inDataDirectory = (path: string) =>
  path === DATA_DIRECTORY || path.startsWith(`${DATA_DIRECTORY}/`);

/**
 * The files directly in `folder` that can be imported (see
 * {@link isImportCandidate}), in the order `compare` puts them in (the file
 * explorer's, see `explorerComparator`), each checked only once the one
 * before it has been, so its row shows as soon as it passes. A file whose
 * check fails is left out; the rest are still checked. Files `compare` ties
 * stay in the order the folder holds them.
 *
 * With subfolders, the scan announces `folder`'s subfolders before its files,
 * then goes on breadth-first, top to bottom as the explorer lists the
 * folders: each folder in turn has its subfolders announced, its files
 * checked as above and is done, a level at a time. The data directory is
 * never entered, since nothing in it can be imported. Each row's path is
 * from `folder`.
 *
 * A file is checked once for the source's life: a later scan, the toggle
 * having changed, answers for it at once, so the rows it had come back
 * before the screen next paints.
 */
export function folderSource(
  folder: TFolder,
  checks: CandidateChecks,
  compare: ExplorerComparator
): CandidateSource {
  const relativePath = (file: TFile) =>
    folder.path === '/' ? file.path : file.path.slice(folder.path.length + 1);

  // A file that changes while the dialog is open keeps its first answer; the
  // import itself refuses one that has become an item since
  const verdicts = new Map<TFile, Promise<boolean>>();
  const verdict = (file: TFile) => {
    let known = verdicts.get(file);
    if (!known) {
      known = isImportCandidate(file, checks).catch((error: unknown) => {
        // One file that can't be read, gone since the scan began say,
        // hides only itself
        console.error(error);
        return false;
      });
      verdicts.set(file, known);
    }
    return known;
  };

  async function* filesIn(
    dir: TFolder,
    signal: AbortSignal
  ): AsyncGenerator<ScanEvent> {
    const files = dir.children
      .filter((child): child is TFile => child instanceof TFile)
      .sort(compare);
    for (const file of files) {
      if (signal.aborted) return;
      const passes = await verdict(file);
      if (signal.aborted) return;
      if (passes) {
        yield {
          type: 'file',
          file,
          parent: dir.path,
          relativePath: relativePath(file),
        };
      }
    }
  }

  const subfoldersOf = (dir: TFolder) =>
    dir.children
      .filter(
        (child): child is TFolder =>
          child instanceof TFolder && !inDataDirectory(child.path)
      )
      .sort(compare);

  /**
   * `dir`'s subfolders announced (with `subfolders`), its files, and its
   * end; the subfolders, to be scanned in turn.
   */
  async function* enter(
    dir: TFolder,
    signal: AbortSignal,
    subfolders: boolean
  ): AsyncGenerator<ScanEvent, TFolder[]> {
    const subs = subfolders ? subfoldersOf(dir) : [];
    for (const sub of subs) {
      if (signal.aborted) return [];
      yield { type: 'folder', path: sub.path, parent: dir.path };
    }
    yield* filesIn(dir, signal);
    if (signal.aborted) return [];
    yield { type: 'folder-done', path: dir.path };
    return subs;
  }

  return {
    // The vault root has no name of its own
    title: folder.name || '/',
    canIncludeSubfolders: true,
    async *scan(signal, { subfolders = false } = {}) {
      // The folders announced and not yet scanned, top to bottom
      const queue = yield* enter(folder, signal, subfolders);
      for (const dir of queue) {
        // Behind the rest of this level: breadth-first
        queue.push(...(yield* enter(dir, signal, true)));
      }
    },
  };
}
