import {
  DEFAULT_PRIORITY,
  MAXIMUM_PRIORITY,
  MINIMUM_PRIORITY,
  MS_PER_YEAR,
  TEXT_BASE_REVIEW_INTERVAL,
} from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import type {
  IArticleBase,
  IArticleReview,
  SQLiteRepository,
} from '#/lib/types';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { ArticleManager } from './ArticleManager';

// #region HELPERS
function makeArticle(overrides: Partial<IArticleBase> = {}): IArticleBase {
  return {
    id: 'article-1',
    reference: 'articles/test.md',
    due: Date.now(),
    interval: TEXT_BASE_REVIEW_INTERVAL,
    dismissed: false,
    priority: DEFAULT_PRIORITY,
    fixed_interval_days: null,
    scroll_top: 0,
    ...overrides,
  };
}

function makeReview(reviewTime: number): IArticleReview {
  return {
    id: 'review-1',
    article_id: 'article-1',
    review_time: reviewTime,
  };
}

function makeRepo(
  lastReview: IArticleReview | undefined,
  reviewCount: number
): SQLiteRepository {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('ORDER BY review_time DESC')) {
        return lastReview ? [lastReview] : [];
      }
      if (sql.includes('COUNT(id)')) {
        return [reviewCount];
      }
      return [];
    }),
    mutate: vi.fn().mockResolvedValue([[]]),
    _execSql: vi.fn(),
    handleFileChange: vi.fn(),
  } as unknown as SQLiteRepository;
}

/** Returns the [sql, params] tuple from the latest call to repo.mutate */
function lastMutateCall(repo: SQLiteRepository): [string, unknown[]] {
  const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock.calls as [
    string,
    unknown[],
  ][];
  return calls[calls.length - 1];
}
// #endregion

describe('disableFixedInterval', () => {
  it('throws if the priority is out of range', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.integer({ max: MINIMUM_PRIORITY - 1 }),
          fc.integer({ min: MAXIMUM_PRIORITY + 1 })
        ),
        async (badPriority) => {
          const article = makeArticle();
          const repo = makeRepo(undefined, 0);
          const manager = new ArticleManager({} as never, repo);
          await expect(async () =>
            manager.disableFixedInterval(article, badPriority)
          ).rejects.toThrow();
        }
      )
    );
  });
  describe('when the article has a prior review', () => {
    it('clears fixed_interval_days in the database', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: Date.now() }),
          fc.integer({ min: 0, max: 1_000 }),
          fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
          async (reviewTime, reviewCount, newPriority) => {
            const article = makeArticle();
            const repo = makeRepo(makeReview(reviewTime), reviewCount);
            const manager = new ArticleManager({} as never, repo);
            await manager.disableFixedInterval(article, newPriority);

            const [sql] = lastMutateCall(repo);
            expect(sql).toMatch(/fixed_interval_days = NULL/i);
          }
        )
      );
    });

    it('calculates the due time using the new priority', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: Date.now() }),
          fc.integer({ min: 0, max: 1_000 }),
          fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
          fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
          async (reviewTime, reviewCount, priority, newPriority) => {
            const article = makeArticle({ priority });
            const repo = makeRepo(makeReview(reviewTime), reviewCount);
            const manager = new ArticleManager({} as never, repo);
            await manager.disableFixedInterval(article, newPriority);

            const mult = IRScheduler.getIntervalMultiplier(newPriority);
            const expectedInterval =
              TEXT_BASE_REVIEW_INTERVAL * mult ** reviewCount;
            const expectedDue = reviewTime + expectedInterval;

            const [, params] = lastMutateCall(repo);
            expect(
              params[1],
              'should calculate the interval by simulating priority scheduling'
            ).toBe(expectedInterval);
            expect(params[0]).toBe(expectedDue);
          }
        )
      );
    });
  });

  describe('when the article has no prior reviews', () => {
    it('falls back to article.due', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR }),
          fc.integer({ min: 0, max: MS_PER_YEAR * 50 }),
          fc.boolean(),
          fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
          async (due, interval, dismissed, priority) => {
            const repo = makeRepo(undefined, 0);
            const manager = new ArticleManager({} as never, repo);
            const article = makeArticle({ due, interval, dismissed, priority });
            await manager.disableFixedInterval(article, priority);

            const [, params] = lastMutateCall(repo);
            expect(params[0]).toBe(due);
          }
        )
      );
    });

    it('sets interval to the default', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR }),
          fc.integer({ min: 0, max: MS_PER_YEAR * 50 }),
          fc.boolean(),
          fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
          async (due, interval, dismissed, priority) => {
            const repo = makeRepo(undefined, 0);
            const manager = new ArticleManager({} as never, repo);
            const article = makeArticle({ due, interval, dismissed, priority });
            await manager.disableFixedInterval(article, priority);

            const [, params] = lastMutateCall(repo);
            expect(params[1]).toBe(TEXT_BASE_REVIEW_INTERVAL);
          }
        )
      );
    });
  });
});
