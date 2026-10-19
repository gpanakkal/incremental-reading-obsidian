import type { TFile, TFolder } from 'obsidian';

/**
 * What a candidate source reports while it scans, in display order:
 * - `file`: an eligible file, a row at the bottom of the folder at `parent`.
 *   `relativePath` is its path from where the source starts (a direct file's
 *   is its name), which its row shows;
 * - `folder`: a folder the scan entered, shown empty with a spinner until its
 *   `folder-done`;
 * - `folder-done`: the folder at `path` holds no more rows. Its subfolders
 *   are reported before it, so a folder holding nothing yet is never
 *   briefly finished and empty while what is under it is still to come.
 *   For a folder never reported as a `folder`, the one the source starts
 *   from, it means the top level holds all its rows.
 *
 * A folder's subfolders are reported as the scan enters it, before its files,
 * so its rows read as the file explorer's do, folders first, and every row
 * still goes at the bottom of its folder: nothing already shown moves.
 */
export type ScanEvent =
  | { type: 'file'; file: TFile; parent: string; relativePath: string }
  | { type: 'folder'; path: string; parent: string | null }
  | { type: 'folder-done'; path: string };

/**
 * Which files a bulk import or un-import considers. `scan` yields them as they
 * pass the mode's eligibility checks, and stops early once `signal` aborts.
 */
export interface CandidateSource {
  /** What the files come from, for the modal's title and the summary notice. */
  title: string;
  /** The modal's title, when "Importing from {title}" would not read right. */
  heading?: string;
  /**
   * Whether `scan` can go into subfolders, which the modal offers as
   * "Include subfolders".
   */
  canIncludeSubfolders?: boolean;
  /**
   * The rows, top level first. With `subfolders` (only for a source that
   * `canIncludeSubfolders`), what is under the top level's folders too,
   * breadth-first, its files never checked before the top level's. A scan
   * run again, the toggle having changed, answers at once for every file an
   * earlier run of it checked.
   */
  scan(signal: AbortSignal, options?: ScanOptions): AsyncIterable<ScanEvent>;
}

/** How far a {@link CandidateSource} scans. */
export interface ScanOptions {
  /** Go into subfolders ("Include subfolders"). */
  subfolders?: boolean;
}

/** What a bulk modal does with the files it lists; fixed for its life. */
export type BulkMode = 'import' | 'unimport';

/** The scheduling and placement shared by every file of a bulk import. */
export interface BulkImportOptions {
  priority: number;
  fixedIntervalDays: number | null;
  makeCopy: boolean;
}

/** One file of a bulk import. */
export interface BulkImportEntry {
  file: TFile;
  /**
   * Tags to take off `file` once a copy of it is the article, so it doesn't
   * ask to be imported again: the trigger tags it was imported by. The copy
   * keeps them. Nothing is taken off a file imported where it is.
   */
  stripFromSource?: readonly string[];
}

/**
 * What an import did to make its file an article:
 * - `created`: a new row, for the file where it is or for a copy of it;
 * - `restored`: a deleted row brought back, with its schedule and history;
 * - `linked`: a row the file's `ir-id` names, live or deleted, moved to the
 *   file's path. A deleted one is `restored` instead.
 */
export type ImportEffect = 'created' | 'restored' | 'linked';

/** What an import of one file did, which an undo takes back. */
export interface ImportedArticle {
  articleId: string;
  effect: ImportEffect;
  /** The note or file the import made: a copy, or a web page's note. */
  madeFile?: TFile;
}

/**
 * What a bulk operation did with one file: `skipped` when there was nothing to
 * do (already an article, or being imported already), `failed` with why not
 * when it couldn't be done. One `imported` says what the import did.
 */
export interface BulkOutcome extends Partial<ImportedArticle> {
  file: TFile;
  status: 'imported' | 'unimported' | 'skipped' | 'failed';
  reason?: string;
}

/**
 * What the bulk dialog's filter bar makes candidate sources with, one maker
 * per filter: the folder chosen, for the folder filter; the tags typed (in
 * lower case, with no `#`), for the tag filter; the files a query matched,
 * for the search filter.
 */
export interface FilterSources {
  folder: (folder: TFolder) => CandidateSource;
  tag: (tags: readonly string[]) => CandidateSource;
  search: (files: readonly TFile[]) => CandidateSource;
}
