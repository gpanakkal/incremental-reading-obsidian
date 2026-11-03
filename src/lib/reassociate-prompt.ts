import { formatQueueDate } from '#/components/review-queue/columns';
import { promptForChoice, promptForConfirmation } from '#/views/ConfirmModal';
import type { App, TFile } from 'obsidian';
import type {
  HeldChoice,
  Plan,
  PurgedRow,
  PathHolder as RowAtPath,
} from './crash-leftovers';
import type { NoteType } from './types';

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
 * On which device the row last written by `device` was, as the user is told:
 * nothing when unknown.
 */
function deviceOf(device: string, thisDevice: string): string {
  if (device === '') return '';
  return device === thisDevice
    ? ', on this device'
    : `, on another device (${shortId(device)})`;
}

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
    details.push(
      `Last changed: ${dayOf(updatedAt)}${deviceOf(updatedBy, thisDevice)}`
    );
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

/** `kind` with its article: "an article", "a snippet". */
const withArticle = (kind: string) =>
  `${kind === 'article' ? 'an' : 'a'} ${kind}`;

/**
 * Ask whether to make `file`, a leftover note (see `crash-leftovers`), the
 * note of what `plan` offers, its target: the row holding the note's id,
 * deleted or with its note missing, coming to the note's path from where its
 * note was; or the row at its path while one holds its id. Shown are the
 * row's details, the deleted row at the path that gives it up, if any, and
 * each row holding the note's id that isn't offered, with why. A plan that
 * offers erasing (only the row at the path, while no row holds the note's
 * id) is asked about as {@link askToResolveHeld} asks.
 * @param thisDevice this device's id (see `getDeviceId`), to say whether the
 *   row was last changed here
 * @returns `reassociate` if the user confirmed; else, or with no target,
 *   `null`
 */
export async function askToResolve(
  app: App,
  file: TFile,
  plan: Plan,
  thisDevice: string
): Promise<HeldChoice> {
  const { target, evicts, refused } = plan;
  if (!target) return null;
  if (plan.erase) return askToResolveHeld(app, file, target.row, thisDevice);
  const { kind, deleted } = target.row;
  const state = deleted
    ? `a deleted ${kind}`
    : `${withArticle(kind)} whose note is missing`;
  let opening = `This note's path, "${file.path}", belongs to ${state}, but the note holds another ID.`;
  if (target.by === 'id') {
    const { reference } = target.row;
    opening =
      reference === file.path
        ? `This note holds the ID of ${state} recorded at this note's path.`
        : `This note holds the ID of ${state}, last recorded at "${reference}".`;
  }
  const paragraphs: (string | string[])[] = [
    opening,
    detailsOf(target.row, thisDevice),
  ];
  if (evicts) {
    paragraphs.push(
      `The deleted ${evicts.kind} recorded at this note's path (ID ${shortId(evicts.id)}) gives that path up.`
    );
  }
  for (const { row, why } of refused) {
    paragraphs.push(
      why === 'copy'
        ? `The ${row.kind} holding this note's ID (${shortId(row.id)}) isn't offered: the note at "${row.reference}" still holds that ID, so this note is a copy.`
        : `The ${row.kind} holding this note's ID (${shortId(row.id)}), last recorded at "${row.reference}", isn't offered: the ${kind} holds this note's path.`
    );
  }
  paragraphs.push(
    `Re-associate makes this note the ${kind}'s note, keeping its schedule and review history${deleted ? ', and brings it back to review' : ''}.`
  );
  const confirmed = await promptForConfirmation(app, {
    title: `Re-associate "${file.basename}" with ${kind}?`,
    paragraphs,
    confirmText: 'Re-associate',
  });
  return confirmed ? 'reassociate' : null;
}

/**
 * Ask whether to import `file`, a leftover note (see `crash-leftovers`) whose
 * id `row`, a row deleted for good, held, as a new item of `as` under a new
 * id: the only way to keep it as an item, as that row is gone for good and
 * its id with it. Shown are what the row was, its id, and when and on which
 * device it was erased, when known.
 * @param thisDevice this device's id (see `getDeviceId`), to say whether the
 *   row was erased here
 * @returns whether the user confirmed
 */
export function askToImportFresh(
  app: App,
  file: TFile,
  row: PurgedRow,
  as: NoteType,
  thisDevice: string
): Promise<boolean> {
  const { kind, id, erasedAt, erasedBy } = row;
  const details = [`ID: ${id}`];
  if (erasedAt > 0) {
    details.push(`Erased: ${dayOf(erasedAt)}${deviceOf(erasedBy, thisDevice)}`);
  }
  const state = kind === 'article' ? 'An article' : `A ${kind}`;
  return promptForConfirmation(app, {
    title: `Import "${file.basename}" fresh?`,
    paragraphs: [
      `${state} that was erased for good had this note's ID. It can't be restored, and this note can't be saved under its ID.`,
      details,
      `"Import fresh" gives this note a new ID and saves it as a new ${as}.`,
    ],
    confirmText: 'Import fresh',
  });
}
