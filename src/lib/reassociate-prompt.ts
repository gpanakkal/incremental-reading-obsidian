import { formatQueueDate } from '#/components/review-queue/columns';
import { promptForChoice, promptForConfirmation } from '#/views/ConfirmModal';
import type { App, TFile } from 'obsidian';
import type { HeldChoice, PathHolder as RowAtPath } from './crash-leftovers';

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
  const state = holder.deleted ? `A deleted ${kind}` : `A ${kind}`;
  return promptForConfirmation(app, {
    title: `Re-associate "${file.basename}" with ${kind}?`,
    paragraphs: [
      `${state} was at this note's path ("${file.path}"), but had a different ID than this note.`,
      [`Last reviewed: ${reviewed}`],
      `"Re-associate" points the ${kind} to this note instead of importing it as an article, keeping its schedule and review history${holder.deleted ? ', and restores it to the review queue' : ''}.`,
    ],
    confirmText: 'Re-associate',
  });
}

/** The day `ms` falls on, as the queue writes it. */
const dayOf = (ms: number) => formatQueueDate(new Date(ms));

/** The short form of the id `id`, as the user is shown it. */
const shortId = (id: string) => id.slice(0, 8);

/**
 * What the user is shown of `holder` to choose by: its id, when it is due,
 * last reviewed and last changed, and on which device, and what it was taken
 * from, if anything.
 */
function detailsOf(holder: RowAtPath, thisDevice: string): string[] {
  const { id, due, dismissed, lastReview, updatedAt, updatedBy, parent } =
    holder;
  const details = [
    `ID: ${id}`,
    `Due: ${formatQueueDate(due === null ? null : new Date(due))}${dismissed ? ' (dismissed)' : ''}`,
    `Last reviewed: ${lastReview === null ? 'never' : dayOf(lastReview)}`,
  ];
  if (updatedAt > 0) {
    const device =
      updatedBy === ''
        ? ''
        : updatedBy === thisDevice
          ? ', on this device'
          : `, on another device (${shortId(updatedBy)})`;
    details.push(`Last changed: ${dayOf(updatedAt)}${device}`);
  }
  if (parent) {
    details.push(
      `Created from: ${parent.path ?? `a deleted item (ID ${parent.id})`}`
    );
  }
  return details;
}

/**
 * Ask what to do about `holder`, a row at the path of `file`, a note left
 * holding an id no row holds (see `crash-leftovers`): make the note that
 * row's note, the default, or erase the row and save the note as a new item,
 * which is asked once more, as it can't be undone.
 * @param thisDevice this device's id (see `getDeviceId`), to say whether the
 *   row was last changed here
 * @returns what the user chose, `null` for neither
 */
export async function askToResolveHeld(
  app: App,
  file: TFile,
  holder: RowAtPath,
  thisDevice: string
): Promise<HeldChoice> {
  const { kind, id, deleted } = holder;
  const state = deleted
    ? `A deleted ${kind}`
    : `${kind === 'article' ? 'An' : 'A'} ${kind} whose note is missing`;
  const choice = await promptForChoice(app, {
    title: `Re-associate "${file.basename}" with ${kind}?`,
    paragraphs: [
      `${state} was at this note's path ("${file.path}"), but had a different ID than this note.`,
      detailsOf(holder, thisDevice),
      `"Re-associate" points the ${kind} to this note, keeping its schedule and review history${deleted ? ', and restores it to the review queue' : ''}.`,
      `"Erase and import fresh" erases the ${kind} and its review history, then saves this note as a new item.`,
    ],
    confirmText: 'Re-associate',
    alternative: { text: 'Erase and import fresh', destructive: true },
  });
  if (choice === 'confirm') return 'reassociate';
  if (choice === 'cancel') return null;
  const sure = await promptForConfirmation(app, {
    title: `Erase the ${kind}?`,
    paragraphs: [
      `Erase the ${kind} ${id} and its review history for good, then save "${file.basename}" as a new item? This can't be undone.`,
      ...(kind === 'card'
        ? []
        : ['Snippets and cards made from it will be kept.']),
    ],
    confirmText: 'Erase',
    destructive: true,
  });
  return sure ? 'erase' : null;
}
