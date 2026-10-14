/**
 * A condition leaving out the rows whose `id` is in `ids`.
 *
 * The whole list is bound as one JSON array parameter, so however long it
 * grows (review excludes every item seen this session) the statement stays
 * far inside `MAX_SQL_QUERY_PARAMS`. Uses SQLite's `json_each`, built in since
 * SQLite 3.38; sql.js 1.13 ships 3.49.
 *
 * @param params The statement's parameters so far. The list is appended, and
 * the condition names it by its position.
 */
export function idNotIn(ids: readonly string[], params: unknown[]): string {
  params.push(JSON.stringify(ids));
  return `id NOT IN (SELECT value FROM json_each($${params.length}))`;
}
