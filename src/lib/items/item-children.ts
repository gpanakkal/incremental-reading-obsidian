import type { SQLiteRepository } from '#/lib/types';
import { NOT_PURGED } from './row-delete';

/** A snippet or card under another item: see {@link childrenOf}. */
export interface ItemChild {
  readonly table: 'snippet' | 'srs_card';
  readonly id: string;
  /** Whether it is in the trash: deleted, but not for good, so still restorable. */
  readonly trashed: boolean;
  /** Where its own note is, which names it to the user. */
  readonly reference: string;
  /**
   * Where its highlight shows: the note, or PDF, of the item it was taken
   * from, while there is one.
   */
  readonly highlightedIn: string | null;
}

/**
 * Every snippet and card under the items `roots` (articles, snippets or
 * cards, by id), however deep: whose `parent`, or its parent's, and so on,
 * is one of them. The roots themselves are left out, as are rows deleted for
 * good and whatever hangs only under one of those, which no longer sits in
 * the tree. Trashed rows count: the user may still restore them. Each comes
 * with what names it to the user, read in the same query, so asking about
 * them reads the database once.
 *
 * Read as the database holds them now, so rows another device made and this
 * one merged since count too. Listed deepest first, each ahead of the row it
 * sits under, so removing them in order never moves one up a level (see
 * `deleteRowStatements`) just before it is removed itself.
 * @param options.liveRoots to find only what hangs under the roots that are
 *   live, neither in the trash nor deleted for good: for an undo that passes
 *   the others over, and so removes nothing under them
 * @throws when the database can't be read: finding nothing would pass for
 *   there being nothing under them
 */
export async function childrenOf(
  repo: Pick<SQLiteRepository, 'query'>,
  roots: readonly string[],
  { liveRoots = false }: { liveRoots?: boolean } = {}
): Promise<ItemChild[]> {
  if (roots.length === 0) return [];
  const ids = roots.map((_, i) => `$${i + 1}`).join(', ');
  // A row deleted for good is flagged deleted too (see `NOT_PURGED`)
  const tops = liveRoots
    ? ['article', 'snippet', 'srs_card']
        .map(
          (table) =>
            `SELECT id FROM ${table} WHERE id IN (${ids}) AND deleted = FALSE`
        )
        .join(' UNION ALL ')
    : ids;
  // Each row has one parent, so a path down from the roots only loops back
  // through one of them, in data no write makes; the depth is capped at the
  // number of rows, which no loopless path reaches, so the walk always ends.
  const rows = (await repo.query(
    `WITH RECURSIVE
       link(tbl, id, parent, context, deleted, reference) AS (
         SELECT 'snippet', id, parent, context, deleted, reference FROM snippet
           WHERE ${NOT_PURGED}
         UNION ALL
         SELECT 'srs_card', id, parent, context, deleted, reference
           FROM srs_card WHERE ${NOT_PURGED}
       ),
       under(id, depth) AS (
         SELECT id, 1 FROM link WHERE parent IN (${tops})
         UNION
         SELECT link.id, under.depth + 1 FROM link
           JOIN under ON link.parent = under.id
           WHERE under.depth < (SELECT COUNT(*) FROM link)
       )
     SELECT link.tbl AS tbl, link.id AS id, link.deleted AS deleted,
       link.reference AS reference, MAX(under.depth) AS depth,
       (SELECT reference FROM article WHERE id = link.context AND ${NOT_PURGED}
        UNION ALL
        SELECT reference FROM snippet WHERE id = link.context AND ${NOT_PURGED}
       ) AS highlighted_in
     FROM under JOIN link ON link.id = under.id
     WHERE link.id NOT IN (${ids})
     GROUP BY link.id
     ORDER BY depth DESC`,
    [...roots],
    { throwOnError: true }
  )) as unknown as {
    tbl: ItemChild['table'];
    id: string;
    deleted: number;
    reference: string;
    highlighted_in: string | null;
  }[];
  return rows.map((row) => ({
    table: row.tbl,
    id: row.id,
    trashed: Boolean(row.deleted),
    reference: row.reference,
    highlightedIn: row.highlighted_in,
  }));
}
