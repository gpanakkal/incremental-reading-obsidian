import { DATA_DIRECTORY } from '#/lib/constants';
import { isImportable, sniffMimeType, supportsFrontmatter } from '#/lib/mime';
import { TFile, type MetadataCache, type TFolder, type Vault } from 'obsidian';
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

/** Compares names as people count: `Part 2` before `Part 10`. */
const naturalOrder = new Intl.Collator(undefined, { numeric: true });

/**
 * The files directly in `folder` that can be imported (see
 * {@link isImportCandidate}), in natural name order, each checked only once
 * the one before it has been, so its row shows as soon as it passes. A file
 * whose check fails is left out; the rest are still checked.
 */
export function folderSource(
  folder: TFolder,
  checks: CandidateChecks
): CandidateSource {
  return {
    // The vault root has no name of its own
    title: folder.name || '/',
    async *scan(signal: AbortSignal): AsyncGenerator<ScanEvent> {
      const files = folder.children
        .filter((child): child is TFile => child instanceof TFile)
        .sort((a, b) => naturalOrder.compare(a.name, b.name));
      for (const file of files) {
        if (signal.aborted) return;
        const passes = await isImportCandidate(file, checks).catch(
          (error: unknown) => {
            // One file that can't be read, gone since the scan began say,
            // hides only itself
            console.error(error);
            return false;
          }
        );
        if (signal.aborted) return;
        if (passes) {
          yield {
            type: 'file',
            file,
            parent: folder.path,
            relativePath: file.name,
          };
        }
      }
    },
  };
}
