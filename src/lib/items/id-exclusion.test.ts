import { MAX_SQL_QUERY_PARAMS } from '#/lib/constants';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import initSqlJs, { type Database } from 'sql.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { idNotIn } from './id-exclusion';

// #region HELPERS
let db: Database;

beforeAll(async () => {
  // The same build the plugin bundles
  const SQL = await initSqlJs({
    wasmBinary: readFileSync(
      require.resolve('sql.js/dist/sql-wasm.wasm')
    ) as unknown as ArrayBuffer,
  });
  db = new SQL.Database();
  db.exec('CREATE TABLE item (id TEXT PRIMARY KEY, n INTEGER)');
});

afterAll(() => {
  db.close();
});

/** Make `ids` the only rows of `item`, `n` counting up in the given order. */
function replaceRows(ids: readonly string[]) {
  db.exec('DELETE FROM item');
  ids.forEach((id, n) => {
    db.exec('INSERT INTO item (id, n) VALUES ($1, $2)', [id, n]);
  });
}

/** The ids of `item` the condition keeps, in insertion order. */
function kept(condition: string, params: unknown[]): string[] {
  const results = db.exec(
    `SELECT id FROM item WHERE ${condition} ORDER BY n`,
    params as never
  );
  return results.length ? results[0].values.map(([id]) => id as string) : [];
}

/**
 * Any id, including ones JSON or SQL would have to escape. Never one holding
 * NUL: sql.js binds text NUL-terminated, so the row's own id would be stored
 * cut short; ids are UUIDs, which never hold one.
 */
const idArb = fc.oneof(
  fc
    .string({ unit: 'binary' })
    .filter((id) => !id.includes(String.fromCharCode(0))),
  fc.uuid(),
  fc.constantFrom('', "'", '"', '\\', ')', '$1', '[]', 'null', '1', ' a ')
);
// #endregion

describe('idNotIn', () => {
  it('keeps exactly the rows whose id is not in the list, however long the list', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(idArb, { maxLength: 20 }),
        fc.array(fc.boolean(), { minLength: 20, maxLength: 20 }),
        fc.array(idArb, { maxLength: 5000, size: 'max' }),
        // Parameters the statement already holds
        fc.array(fc.integer(), { maxLength: 3 }),
        (rows, excluded, extra, before) => {
          replaceRows(rows);
          const ids = [...rows.filter((_, i) => excluded[i]), ...extra];
          const params: unknown[] = [...before];

          const condition = idNotIn(ids, params);

          // Bind the earlier parameters' placeholders too, as a statement would
          const leading = before.map((_, i) => `$${i + 1} = $${i + 1}`);
          expect(kept([...leading, condition].join(' AND '), params)).toEqual(
            rows.filter((id) => !ids.includes(id))
          );
        }
      ),
      { numRuns: 50 }
    );
  });

  it('adds one parameter to the statement, whatever the list holds', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { maxLength: 5000, size: 'max' }),
        fc.array(fc.anything(), { maxLength: MAX_SQL_QUERY_PARAMS - 1 }),
        (ids, before) => {
          const params = [...before];
          const condition = idNotIn(ids, params);
          expect(params).toEqual([...before, JSON.stringify(ids)]);
          // Its own placeholder, the one it added, and no other
          expect(condition.match(/\$\d+/g)).toEqual([`$${params.length}`]);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('leaves the caller’s list as it was', () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 50 }), (ids) => {
        const copy = [...ids];
        idNotIn(ids, []);
        expect(ids).toEqual(copy);
      })
    );
  });
});
