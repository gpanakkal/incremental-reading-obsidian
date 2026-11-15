import { letGoOfStatements, NOT_PURGED } from '#/lib/items/row-delete';
import type { Database, SqlValue } from 'sql.js';

/**
 * SQL true of `link`, an id, naming an article or snippet that a row can sit
 * under or be taken from: one that is there and not deleted for good.
 */
const holdsItem = (link: string) =>
  `(EXISTS (SELECT 1 FROM article WHERE id = ${link} AND ${NOT_PURGED}) ` +
  `OR EXISTS (SELECT 1 FROM snippet WHERE id = ${link} AND ${NOT_PURGED}))`;

/** Each link a snippet or card not deleted for good holds. */
const LINKS = ['snippet', 'srs_card']
  .flatMap((table) =>
    ['parent', 'context'].map(
      (column) =>
        `SELECT ${column} AS id FROM ${table} ` +
        `WHERE ${column} IS NOT NULL AND ${NOT_PURGED}`
    )
  )
  .join(' UNION ');

/**
 * The ids rows still link to that name no row to link to: rows deleted for
 * good, or gone altogether once retention pruned their tombstones, with the
 * snippets deleted for good above them, which a drop would have walked up
 * through. Topmost first, so that each hands what sat under it to a row
 * already settled: a row's depth is the longest way down to it from a link,
 * and every row above another is deeper than it. The walk stops at the
 * number of snippets, which no chain of parents is longer than unless it
 * loops.
 */
const DANGLING = `
  WITH RECURSIVE
    link(id) AS (${LINKS}),
    dangling(id, depth) AS (
      SELECT id, 0 FROM link WHERE NOT ${holdsItem('link.id')}
      UNION
      SELECT up.parent, dangling.depth + 1
      FROM dangling JOIN snippet AS up ON up.id = dangling.id
      WHERE up.parent IS NOT NULL AND NOT ${holdsItem('up.parent')}
        AND dangling.depth < (SELECT COUNT(*) FROM snippet)
    )
  SELECT id, EXISTS (SELECT 1 FROM article WHERE article.id = dangling.id)
  FROM dangling GROUP BY id ORDER BY MAX(depth) DESC, id`;

const SAVEPOINT = 'rehome_orphans';

/**
 * Apply the rule a drop follows (see `letGoOfStatements`) to the rows that
 * escaped it: snippets and cards, not deleted for good themselves, whose
 * `parent` or `context` names a row deleted for good or gone. Another device
 * made them before it saw the drop, an older plugin version dropped without
 * moving them, or retention pruned what they sat under. Each such context is
 * erased; each such parent becomes the nearest item above it still there,
 * walking up through rows deleted for good, or none at the top. A row only
 * trashed can come back, so what links to it is left be.
 *
 * Every device that holds the same rows writes the same values, so devices
 * that each run it converge whichever write wins. One query when nothing
 * dangles, as is usual; a few writes for each row that does. Atomic, and
 * nested in a transaction the caller holds, if any, which can still undo it.
 * Its writes are the caller's to stamp, by the triggers armed or not.
 * @returns how many row writes it made: none, nothing to save. A row can
 * take two, its context and its parent
 * @throws if a statement fails, having changed nothing
 */
export function rehomeOrphans(db: Database): number {
  const [found] = db.exec(DANGLING);
  if (!found) return 0;
  db.exec(`SAVEPOINT ${SAVEPOINT}`);
  try {
    let written = 0;
    for (const [id, isArticle] of found.values) {
      const table = isArticle ? 'article' : 'snippet';
      for (const { query, params } of letGoOfStatements(table, String(id))) {
        db.run(query, params as SqlValue[]);
        written += db.getRowsModified();
      }
    }
    db.exec(`RELEASE ${SAVEPOINT}`);
    return written;
  } catch (error) {
    db.exec(`ROLLBACK TO ${SAVEPOINT}`);
    db.exec(`RELEASE ${SAVEPOINT}`);
    throw error;
  }
}
