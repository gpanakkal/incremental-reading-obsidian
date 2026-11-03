import { tombstoneRowStatements } from '#/lib/items/row-delete';
import fc from 'fast-check';
import { insertItemAt, type TestRepository } from './item-vault';

/**
 * A database write that can change which row holds a note: a row put in
 * (live or a tombstone, at the note's path or elsewhere), one tombstoned or
 * revived, one moved onto the note's path or off it, one deleted for good.
 * Rows are `x` or `y` of any item table.
 */
export const rowWriteArb = fc.record({
  kind: fc.constantFrom('insert', 'flag', 'move', 'purge' as const),
  table: fc.constantFrom('article', 'snippet', 'srs_card' as const),
  id: fc.constantFrom('x', 'y'),
  atNote: fc.boolean(),
  deleted: fc.boolean(),
});
export type RowWrite =
  typeof rowWriteArb extends fc.Arbitrary<infer T> ? T : never;

/**
 * Make `write` on `repo`, for the note at `notePath`.
 * @throws when it puts in a row whose id or path its table already holds
 */
export function applyRowWrite(
  repo: TestRepository,
  write: RowWrite,
  notePath: string
): void {
  const { table, id, atNote, deleted } = write;
  const path = atNote ? notePath : 'elsewhere/other.md';
  switch (write.kind) {
    case 'insert':
      insertItemAt(repo, table, { id, reference: path, deleted });
      return;
    case 'flag':
      repo.mutate(`UPDATE ${table} SET deleted = $1 WHERE id = $2`, [
        deleted,
        id,
      ]);
      return;
    case 'move':
      repo.mutate(`UPDATE ${table} SET reference = $1 WHERE id = $2`, [
        path,
        id,
      ]);
      return;
    case 'purge':
      for (const { query, params } of tombstoneRowStatements(table, id)) {
        repo.mutate(query, params);
      }
  }
}
