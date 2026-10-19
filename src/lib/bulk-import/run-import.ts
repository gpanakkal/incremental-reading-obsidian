import { notify, type NoticeAction } from '#/lib/notices';
import type { TFile } from 'obsidian';
import type { BulkImportEntry, BulkImportOptions, BulkOutcome } from './types';

/** What runs a bulk import: `ReviewManager`. */
export interface BulkImporter {
  importArticles(
    entries: readonly BulkImportEntry[],
    options: BulkImportOptions
  ): Promise<BulkOutcome[]>;
}

/** What runs a bulk un-import: `ReviewManager`. */
export interface BulkUnimporter {
  unimportArticles(files: readonly TFile[]): Promise<BulkOutcome[]>;
}

/**
 * The notice listing each file that failed and why, one per line, saying
 * what failed: `import` unless told.
 */
export function describeFailures(
  failed: readonly BulkOutcome[],
  verb: 'import' | 'un-import' = 'import'
): string {
  const count = `${failed.length} file${failed.length === 1 ? '' : 's'}`;
  return [
    `Couldn't ${verb} ${count}:`,
    ...failed.map(({ file, reason }) => `${file.path}: ${reason}`),
  ].join('\n');
}

/**
 * Import `files`, chosen from what `title` names, one after another with the
 * same `options`, then say how it went: one notice counting what was
 * imported, a success the notice levels may hide, and when any failed a
 * second one listing them, which always shows.
 * @param onImported told what came of the import before anything is said,
 *   for an undo to take it back; answers the button for the first notice to
 *   carry, if any
 */
export async function importChosen(
  importer: BulkImporter,
  files: readonly TFile[],
  options: BulkImportOptions,
  title: string,
  onImported?: (outcomes: readonly BulkOutcome[]) => NoticeAction | undefined
): Promise<BulkOutcome[]> {
  const outcomes = await importer.importArticles(
    files.map((file) => ({ file })),
    options
  );
  const action = onImported?.(outcomes);
  const imported = outcomes.filter(({ status }) => status === 'imported');
  notify(`${imported.length} of ${outcomes.length} imported from ${title}`, {
    kind: 'success',
    category: 'import',
    action,
  });
  const failed = outcomes.filter(({ status }) => status === 'failed');
  if (failed.length > 0) notify(describeFailures(failed), { kind: 'error' });
  return outcomes;
}

/**
 * Un-import `files`, chosen from what `title` names (see
 * `ArticleManager.unimportMany`), then say how it went as {@link importChosen}
 * does: one notice counting what was un-imported, and when any failed a
 * second one listing them. Never asks first; the caller has. Not undoable.
 * @param onUnimported told what came of it before anything is said, for what
 *   shows the rows to catch up (see `refreshAfterUnimport`)
 */
export async function unimportChosen(
  unimporter: BulkUnimporter,
  files: readonly TFile[],
  title: string,
  onUnimported?: (outcomes: readonly BulkOutcome[]) => Promise<void>
): Promise<BulkOutcome[]> {
  const outcomes = await unimporter.unimportArticles(files);
  await onUnimported?.(outcomes);
  const done = outcomes.filter(({ status }) => status === 'unimported');
  notify(`${done.length} of ${outcomes.length} un-imported from ${title}`, {
    kind: 'success',
    category: 'import',
  });
  const failed = outcomes.filter(({ status }) => status === 'failed');
  if (failed.length > 0) {
    notify(describeFailures(failed, 'un-import'), { kind: 'error' });
  }
  return outcomes;
}
