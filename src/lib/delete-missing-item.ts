import type { QueueRow } from '#/components/types';
import type IncrementalReadingPlugin from '#/main';
import { promptForConfirmation } from '#/views/ConfirmModal';
import { ObsidianHelpers as Obsidian } from './ObsidianHelpers';
import { queryClient } from './query-client';
import { tableOf } from './relink';
import { resetCurrentItem, store } from './store';

/**
 * Once the user confirms, delete the item `row`, whose note is missing, for
 * good: its row and review history (see `ReviewManager.deleteRow`). There is
 * no note to trash.
 *
 * The delete reports no data change, so the queue is refreshed here, and
 * review, if it is on the item, moves on to whatever is due next.
 * @returns whether the item was deleted
 */
export async function deleteMissingItem(
  plugin: IncrementalReadingPlugin,
  row: Pick<QueueRow, 'id' | 'type' | 'reference'>
): Promise<boolean> {
  const confirmed = await promptForConfirmation(plugin.app, {
    title: 'Permanently delete item',
    paragraphs: [
      `Delete "${row.reference}" and its review history? This can't be undone.`,
      ...(row.type === 'card'
        ? []
        : ['Snippets and cards made from it will be kept.']),
    ],
    confirmText: 'Delete',
    destructive: true,
  });
  if (!confirmed) return false;

  // The row was missing when the menu was built, from a queue page that may
  // be a minute old, and the user may have taken a while to answer: Sync can
  // have brought the note back since, and a file arriving at a row's
  // reference writes nothing that would have refreshed the page
  if (Obsidian.getNote(row.reference, plugin.app) !== null) {
    Obsidian.notify(`"${row.reference}" is back, so it was not deleted`);
    await invalidateQueue();
    return false;
  }

  try {
    await plugin.reviewManager.deleteRow(tableOf(row.type), row.id);
  } catch (error) {
    console.error(error);
    Obsidian.notify(`Failed to delete "${row.reference}"`);
    return false;
  }

  // Resetting is what asks the queue for the next item due
  if (store.getState().currentItemId === row.id) {
    store.dispatch(resetCurrentItem());
  }
  await invalidateQueue();
  return true;
}

/** Refetch every cached queue page: `'all'`, as `applyQueueChange` does, for pages not on screen. */
function invalidateQueue() {
  return queryClient.invalidateQueries({
    queryKey: ['queue'],
    refetchType: 'all',
  });
}
