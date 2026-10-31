import { formatQueueDate } from '#/components/review-queue/columns';
import { promptForConfirmation } from '#/views/ConfirmModal';
import type { App, TFile } from 'obsidian';

/**
 * A snippet or card row whose path a note is at, though the note doesn't
 * carry its `ir-id`: the item's note was deleted or renamed away, and another
 * note took its place.
 */
export interface PathHolder {
  table: 'snippet' | 'srs_card';
  id: string;
  /** Whether the row is deleted (its note was), though not for good. */
  deleted: boolean;
  /** When the item was last reviewed, in ms; null when it never was. */
  lastReview: number | null;
}

/**
 * Ask whether `file`, at the path of the item `holder` but no note of its,
 * is to become that item's note rather than be imported as an article.
 * @returns whether the user confirmed
 */
export function askToReassociate(
  app: App,
  file: TFile,
  holder: PathHolder
): Promise<boolean> {
  const kind = holder.table === 'snippet' ? 'snippet' : 'card';
  const reviewed =
    holder.lastReview === null
      ? 'never'
      : formatQueueDate(new Date(holder.lastReview));
  const state = holder.deleted ? `a deleted ${kind}` : `a ${kind}`;
  return promptForConfirmation(app, {
    title: `Re-associate with ${kind}?`,
    paragraphs: [
      `This note's path, "${file.path}", belongs to ${state}, but the note doesn't carry the ${kind}'s ID.`,
      `The ${kind} was last reviewed: ${reviewed}.`,
      holder.deleted
        ? `Make this note the ${kind}'s note instead of importing it as an article? The ${kind} comes back to review.`
        : `Make this note the ${kind}'s note instead of importing it as an article?`,
    ],
    confirmText: 'Re-associate',
  });
}
