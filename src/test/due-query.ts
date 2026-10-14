import { MS_PER_DAY, TEXT_BASE_REVIEW_INTERVAL } from '#/lib/constants';
import fc from 'fast-check';
import type { Database } from 'sql.js';
import { expect } from 'vitest';

/**
 * An article or snippet row for a due-query property: due within a day either
 * side of the cutoffs the properties pick, fuzzed or not, live or not, and
 * seen this session or not.
 */
export const textItemSpecArb = fc.record({
  id: fc.uuid(),
  due: fc.oneof(
    fc.integer({ min: -MS_PER_DAY, max: 3 * MS_PER_DAY }),
    // Near and at small cutoffs, where ties are likely
    fc.integer({ min: -2, max: 2 })
  ),
  dueFuzz: fc.option(fc.integer({ min: 0, max: 60 * 60 * 1000 })),
  dismissed: fc.boolean(),
  deleted: fc.boolean(),
  seen: fc.boolean(),
});

/**
 * Ids seen this session that are not in the table a property queries (other
 * item types, or deleted since): any count from none to well past what
 * `MAX_SQL_QUERY_PARAMS` once allowed, some of them ids JSON or SQL would
 * have to escape. Built from the count, so a failure shrinks by halving it
 * rather than by dropping thousands of ids one at a time.
 */
export const seenElsewhereArb = fc
  .tuple(
    fc.subarray(['', "'", '"', '\\', ')', '$1', '[]', 'null', '1', ' a ']),
    fc.integer({ min: 0, max: 5000 })
  )
  .map(([awkward, count]) => [
    ...awkward,
    ...Array.from({ length: count }, (_, i) => `elsewhere-${i}`),
  ]);

export type TextItemSpec =
  typeof textItemSpecArb extends fc.Arbitrary<infer T> ? T : never;

/** Add `spec` to `table`, at a note of its own. */
export function insertTextItemRow(
  db: Database,
  table: 'article' | 'snippet',
  spec: TextItemSpec
) {
  db.exec(
    `INSERT INTO ${table}
      (id, reference, due, due_fuzz, interval, priority, dismissed, deleted)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      spec.id,
      `${table}s/${spec.id}.md`,
      spec.due,
      spec.dueFuzz,
      TEXT_BASE_REVIEW_INTERVAL,
      30,
      Number(spec.dismissed),
      Number(spec.deleted),
    ]
  );
}

/**
 * Expect `ids` to be the first `limit` (or all) of the live, unseen `specs`
 * due by `dueBy`, soonest fuzzed due first. Rows tied on fuzzed due may come
 * back in either order, and either side of the limit.
 */
export function expectDueInOrder(
  ids: readonly string[],
  specs: readonly TextItemSpec[],
  dueBy: number,
  limit: number | undefined
) {
  const fuzzedDue = (spec: TextItemSpec) => spec.due + (spec.dueFuzz ?? 0);
  const eligible = specs
    .filter(
      (spec) =>
        !spec.dismissed && !spec.deleted && !spec.seen && spec.due <= dueBy
    )
    .sort((a, b) => fuzzedDue(a) - fuzzedDue(b));
  const byId = new Map(specs.map((spec) => [spec.id, spec]));

  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) {
    expect(eligible.map((spec) => spec.id)).toContain(id);
  }
  expect(ids.map((id) => fuzzedDue(byId.get(id)!))).toEqual(
    eligible.slice(0, limit ?? eligible.length).map(fuzzedDue)
  );
}

/**
 * The ids a manager's query leaves out, read from its parameters as a mock
 * repo sees them: the JSON array `idNotIn` binds, or none.
 */
export function excludedIdsOf(params: readonly unknown[]): string[] {
  for (const param of params) {
    if (typeof param !== 'string') continue;
    try {
      const parsed: unknown = JSON.parse(param);
      if (Array.isArray(parsed)) return parsed as string[];
    } catch {
      // Not the list: some other string parameter
    }
  }
  return [];
}
