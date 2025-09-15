import QueryComposer from 'src/db/query-composer/QueryComposer';
import { SQLiteRepository } from 'src/db/repository';
import { MS_PER_DAY } from 'src/lib/constants';
import { describe, it, expect } from 'vitest';

describe('Query Composer', () => {
  // const testRepo = new SQLiteRepository(); // TODO: mock the App instance to enable integration tests;
  const db = new QueryComposer();

  describe('SELECT queries', () => {
    it('with specified columns and conditions', () => {
      // Should have access to snippet-specific columns
      const snippetQuery = db
        .select('snippet')
        .columns('reference', 'due')
        .where('reference')
        .eq('test.md')
        .and('dismissed')
        .eq(false);
      const result = snippetQuery.build();
      console.log(result);
      expect(result.query).toContain(
        'SELECT (reference, due) FROM snippet WHERE reference = $1 AND dismissed = $2'
      );
      expect(result.queryParams).toEqual(['test.md', false]);

      const otherQuery = db // TODO: test OR query
        .select('snippet')
        .columns('reference', 'due')
        .where('due')
        .gte(Date.now())
        .or('dismissed')
        .eq(true);
    });
  });

  describe('INSERT', () => {
    it('should construct queries with arguments instead of interpolating', () => {
      const insertValues = [
        {
          reference: `increading/snippets/example-snippet-name`,
          due: Date.now() + MS_PER_DAY,
        },
        {
          reference: `increading/snippets/incremental-learning`,
          due: Date.now() + MS_PER_DAY * 2,
        },
      ];
      const insertQuery = db
        .insert('snippet')
        .columns('reference', 'due')
        .values(...insertValues);

      const { query, queryParams } = insertQuery.build();
      expect(query).toContain(
        'INSERT INTO snippet (reference, due) VALUES (?, ?), (?, ?)'
      );
      // query params
      expect(queryParams).toEqual([
        insertValues[0].reference,
        insertValues[0].due,
        insertValues[1].reference,
        insertValues[1].due,
      ]);
    });
  });
});
