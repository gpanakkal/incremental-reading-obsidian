import { notify } from '#/lib/notices';
import type { TFile } from 'obsidian';
import type { BulkImportEntry, BulkImportOptions, BulkOutcome } from './types';

/** What runs a bulk import: `ReviewManager`. */
export interface BulkImporter {
  importArticles(
    entries: readonly BulkImportEntry[],
    options: BulkImportOptions
  ): Promise<BulkOutcome[]>;
}

/** The notice listing each file that failed and why, one per line. */
export function describeFailures(failed: readonly BulkOutcome[]): string {
  const count = `${failed.length} file${failed.length === 1 ? '' : 's'}`;
  return [
    `Couldn't import ${count}:`,
    ...failed.map(({ file, reason }) => `${file.path}: ${reason}`),
  ].join('\n');
}

/**
 * Import `files`, chosen from what `title` names, one after another with the
 * same `options`, then say how it went: one notice counting what was
 * imported, a success the notice levels may hide, and when any failed a
 * second one listing them, which always shows.
 */
export async function importChosen(
  importer: BulkImporter,
  files: readonly TFile[],
  options: BulkImportOptions,
  title: string
): Promise<BulkOutcome[]> {
  const outcomes = await importer.importArticles(
    files.map((file) => ({ file })),
    options
  );
  const imported = outcomes.filter(({ status }) => status === 'imported');
  notify(`${imported.length} of ${outcomes.length} imported from ${title}`, {
    kind: 'success',
    category: 'import',
  });
  const failed = outcomes.filter(({ status }) => status === 'failed');
  if (failed.length > 0) notify(describeFailures(failed), { kind: 'error' });
  return outcomes;
}
