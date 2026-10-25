import type { BulkOutcome } from '#/lib/bulk-import/types';
import type IncrementalReadingPlugin from '#/main';
import { promptForConfirmation } from '#/views/ConfirmModal';
import type { TFile } from 'obsidian';
import { CONTENT_TITLE_SLICE_LENGTH } from './constants';
import { ObsidianHelpers as Obsidian } from './ObsidianHelpers';
import { leaveCurrentItemIfPurged, queryClient } from './query-client';
import { leaveGoneItem } from './review-history';
import { store } from './store';
import { getContentSlice } from './utils';

/**
 * Once the user confirms, make the article `file` a plain file again (see
 * `ArticleManager.unimportMany`), and say how that went.
 * @returns whether it was un-imported
 */
export async function unimportArticle(
  plugin: IncrementalReadingPlugin,
  file: TFile
): Promise<boolean> {
  const confirmed = await promptForConfirmation(plugin.app, {
    title: 'Un-import article',
    paragraphs: [
      `Un-import "${file.basename}"? Its review history is deleted, and this can't be undone. Snippets and cards taken from it are preserved.`,
    ],
    confirmText: 'Un-import',
    destructive: true,
  });
  if (!confirmed) return false;

  const outcomes = await plugin.reviewManager.unimportArticles([file]);
  await refreshAfterUnimport(plugin, outcomes);

  const name = getContentSlice(file.basename, CONTENT_TITLE_SLICE_LENGTH, true);
  const [outcome] = outcomes;
  if (outcome.status === 'unimported') {
    Obsidian.notify(`Un-imported "${name}"`, {
      kind: 'success',
      category: 'import',
    });
    return true;
  }
  Obsidian.notify(`Couldn't un-import "${name}": ${outcome.reason}`, {
    kind: 'error',
  });
  return false;
}

/**
 * Bring what shows items up to date after an un-import that deleted any row
 * (see `ArticleManager.unimportMany`), as a hard delete reports no change:
 * refetch every cached queue page, and move review off an item whose row is
 * gone, onto whatever is due next.
 */
export async function refreshAfterUnimport(
  plugin: IncrementalReadingPlugin,
  outcomes: readonly BulkOutcome[]
): Promise<void> {
  // A failed one may have lost its row before its properties failed
  if (!outcomes.some(({ status }) => status !== 'skipped')) return;

  await leaveCurrentItemIfPurged(plugin.reviewManager);
  // `'all'`, as `applyQueueChange` does, for pages not on screen
  await queryClient.invalidateQueries({
    queryKey: ['queue'],
    refetchType: 'all',
  });
}

/**
 * Bring what shows items up to date after an undo of imports took back the
 * articles `undone` (see `ArticleManager.undoImports`), as a hard delete
 * reports no change: refetch every cached queue page, and move review off
 * one of them, onto whatever is due next.
 */
export async function refreshAfterImportUndo(
  undone: readonly string[]
): Promise<void> {
  if (undone.length === 0) return;
  const { currentItemId } = store.getState();
  if (currentItemId !== null && undone.includes(currentItemId)) {
    leaveGoneItem(store);
  }
  await queryClient.invalidateQueries({
    queryKey: ['queue'],
    refetchType: 'all',
  });
}
