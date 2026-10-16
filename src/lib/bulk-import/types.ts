import type { TFile } from 'obsidian';

/**
 * What a candidate source reports while it scans, in display order:
 * - `file`: an eligible file, a row at the bottom of the folder at `parent`.
 *   `relativePath` is its path from where the source starts (a direct file's
 *   is its name), which its row shows;
 * - `folder`: a folder the scan entered, shown empty with a spinner until its
 *   `folder-done`;
 * - `folder-done`: the folder at `path` holds no more rows.
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
  scan(signal: AbortSignal): AsyncIterable<ScanEvent>;
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
}

/**
 * What a bulk operation did with one file: `skipped` when there was nothing to
 * do (already an article, or being imported already), `failed` with why not
 * when it couldn't be done.
 */
export interface BulkOutcome {
  file: TFile;
  status: 'imported' | 'unimported' | 'skipped' | 'failed';
  reason?: string;
}
