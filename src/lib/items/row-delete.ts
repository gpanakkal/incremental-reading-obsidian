import type { ItemTable } from '#/lib/moved-note-scan';
import type { MutationStatement } from '#/lib/types';

/** Each item table's review log, and the column there naming the item. */
export const REVIEW_LOG_OF: Readonly<
  Record<ItemTable, readonly [string, string]>
> = {
  article: ['article_review', 'article_id'],
  snippet: ['snippet_review', 'snippet_id'],
  srs_card: ['srs_card_review', 'card_id'],
};

/**
 * What the reference of an item row deleted for good starts with. Synced rows
 * are never deleted outright, only flagged (a tombstone), so that the delete
 * reaches the other devices; but a flagged row that kept its path would hold
 * it (`reference` is unique) against a new import, and would be brought back
 * by everything that brings back a row whose note returns to its path. Vault
 * paths never start with a slash, so this names no note, as with the spots
 * `moved-note-scan` parks rows at.
 */
export const PURGED_REFERENCE_PREFIX = '/ir-deleted/';

/** The reference the item row `id` is left holding once deleted for good. */
export function purgedReference(id: string): string {
  return PURGED_REFERENCE_PREFIX + id;
}

/**
 * SQL true of an item row that is not deleted for good: one that is live, or
 * deleted in a way that can still be undone (its note trashed, say). Readers
 * that find rows by id, which a tombstone keeps, add it so that a row deleted
 * for good reads as no row at all, as it did when such rows were removed.
 */
export const NOT_PURGED = `reference != ('${PURGED_REFERENCE_PREFIX}' || id)`;

/**
 * The writes that tombstone the `table` row `id` for good, with its review
 * history and any startup rebind of it: each is flagged `deleted`, with a
 * fresh stamp, rather than deleted, and the row lets go of its path (see
 * {@link PURGED_REFERENCE_PREFIX}). The row itself goes last, so a run
 * stopping short leaves it live, for deleting again to finish.
 */
export function tombstoneRowStatements(
  table: ItemTable,
  id: string
): MutationStatement[] {
  const [log, column] = REVIEW_LOG_OF[table];
  return [
    {
      query: `UPDATE ${log} SET deleted = TRUE WHERE ${column} = $1`,
      params: [id],
    },
    // Only an article is ever rebound; for anything else this is a no-op
    {
      query: 'UPDATE rebind SET deleted = TRUE WHERE article_id = $1',
      params: [id],
    },
    {
      query: `UPDATE ${table} SET deleted = TRUE, reference = $1 WHERE id = $2`,
      params: [purgedReference(id), id],
    },
  ];
}

/**
 * The writes that remove the `table` row `id` for good, as
 * `ReviewManager.deleteRow` runs them: its snippets and cards freed, then the
 * row tombstoned with its history (see {@link tombstoneRowStatements}). Run
 * in chunks that can stop between any two (`bulkMutate`), a run stopping
 * short of the last leaves the row there, which deleting again finishes.
 */
export function deleteRowStatements(
  table: ItemTable,
  id: string
): MutationStatement[] {
  return [
    {
      query: 'UPDATE snippet SET parent = NULL WHERE parent = $1',
      params: [id],
    },
    {
      query: 'UPDATE srs_card SET parent = NULL WHERE parent = $1',
      params: [id],
    },
    ...tombstoneRowStatements(table, id),
  ];
}
