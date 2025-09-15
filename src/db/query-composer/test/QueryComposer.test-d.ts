import QueryComposer from 'src/db/query-composer/QueryComposer';
import { describe, it, expect } from 'vitest';

describe('Query Composer', () => {
  const db = new QueryComposer();

  describe('SELECT', () => {
    it('should provide type-safe column access for specific tables', () => {
      // Should have access to snippet-specific columns
      const snippetQuery = db
        .select('snippet')
        .columns('reference', 'due', 'dismissed')
        .where('reference')
        .eq('test.md')
        .and('dismissed')
        .eq(false);

      // Should have access to snippet_review-specific columns
      const reviewQuery = db
        .select('snippet_review')
        .columns('snippet_id', 'review_time')
        .where('snippet_id')
        .eq(1);
    });

    it('should provide proper method chaining', () => {
      const query = db
        .select('snippet')
        .where('dismissed')
        .eq(false)
        .sort([['due', 'ASC']])
        .limit(10);

      expect(query).toBeDefined();

      db.select('snippet')
        .join('snippet_review')
        .on('snippet.id', 'snippet_review.snippet_id');
    });

    // TODO: test invalid queries raise errors
  });

  describe('INSERT', () => {
    it('should provide type-safe column specification', () => {
      const insertQuery = db.insert('snippet').columns('reference', 'due');

      expect(insertQuery).toBeDefined();
    });
  });
});
