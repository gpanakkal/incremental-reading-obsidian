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
 * history and any startup rebind of it, as the last of
 * {@link deleteRowStatements}, which every drop runs instead: each is flagged `deleted`, with a
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
 * The tables whose rows sit under another item (`parent`) and are taken from
 * one (`context`). Neither is a foreign key: an article, snippet or card is
 * never deleted outright, only tombstoned, so nothing would clear them.
 */
const CHILD_TABLES = ['snippet', 'srs_card'] as const;

/**
 * SQL for the item the `table` row `$1` sits under, while that is one a row
 * can sit under: an article or snippet not deleted for good. An article sits
 * under nothing; nor does a row whose parent names a row dropped before its
 * children moved up, or none at all.
 */
function itemAbove(table: ItemTable): string {
  if (table === 'article') return 'NULL';
  return (
    `(SELECT up.parent FROM ${table} AS up WHERE up.id = $1 AND up.parent IN ` +
    `(SELECT id FROM article WHERE ${NOT_PURGED} ` +
    `UNION ALL SELECT id FROM snippet WHERE ${NOT_PURGED}))`
  );
}

/**
 * The writes that drop the `table` row `id` for good, which every way a row
 * is deleted for good runs (`ReviewManager.deleteRow`, `deleteWithNote`, an
 * un-import), so that each leaves the tree of items whole: what was taken
 * from it loses its context, the note it has gone with (see
 * `ISnippetBase.context`); what sat under it moves up to the item it sat
 * under, or, with none, to the top. Then the row is tombstoned with its
 * history (see {@link tombstoneRowStatements}), keeping its own links.
 *
 * Run in chunks that can stop between any two (`bulkMutate`), a run stopping
 * short of the last leaves the row there, which deleting again finishes:
 * each write changes nothing run a second time.
 */
export function deleteRowStatements(
  table: ItemTable,
  id: string
): MutationStatement[] {
  return [
    ...CHILD_TABLES.map((child) => ({
      query: `UPDATE ${child} SET context = NULL WHERE context = $1`,
      params: [id],
    })),
    ...CHILD_TABLES.map((child) => ({
      query: `UPDATE ${child} SET parent = ${itemAbove(table)} WHERE parent = $1`,
      params: [id],
    })),
    ...tombstoneRowStatements(table, id),
  ];
}
