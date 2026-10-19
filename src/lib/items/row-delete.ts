import type { ItemTable } from '#/lib/moved-note-scan';
import type { MutationStatement } from '#/lib/types';

/** Each item table's review log, and the column there naming the item. */
const REVIEW_LOG_OF: Readonly<Record<ItemTable, readonly [string, string]>> = {
  article: ['article_review', 'article_id'],
  snippet: ['snippet_review', 'snippet_id'],
  srs_card: ['srs_card_review', 'card_id'],
};

/**
 * The writes that remove the `table` row `id` for good, as
 * `ReviewManager.deleteRow` runs them: its snippets and cards freed,
 * its review history and any startup rebind deleted, then the row itself,
 * last. Run in chunks that can stop between any two (`bulkMutate`), a run
 * stopping short of the last leaves the row there, which deleting again
 * finishes.
 */
export function deleteRowStatements(
  table: ItemTable,
  id: string
): MutationStatement[] {
  const [log, column] = REVIEW_LOG_OF[table];
  return [
    {
      query: 'UPDATE snippet SET parent = NULL WHERE parent = $1',
      params: [id],
    },
    {
      query: 'UPDATE srs_card SET parent = NULL WHERE parent = $1',
      params: [id],
    },
    { query: `DELETE FROM ${log} WHERE ${column} = $1`, params: [id] },
    // Only an article is ever rebound; for anything else this is a no-op
    { query: 'DELETE FROM rebind WHERE article_id = $1', params: [id] },
    { query: `DELETE FROM ${table} WHERE id = $1`, params: [id] },
  ];
}
