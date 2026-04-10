/* eslint-disable obsidianmd/no-tfile-tfolder-cast -- this is a test file */
import {
  DAY_ROLLOVER_OFFSET_HOURS,
  DEFAULT_PRIORITY,
  MAXIMUM_PRIORITY,
  MINIMUM_PRIORITY,
  MS_PER_YEAR,
  TEXT_BASE_REVIEW_INTERVAL,
} from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import type {
  IArticleBase,
  IArticleReview,
  SQLiteRepository,
} from '#/lib/types';
import { getEndOfToday } from '#/lib/utils';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArticleManager } from './ArticleManager';

// #region HELPERS
function makeArticle(overrides: Partial<IArticleBase> = {}): IArticleBase {
  return {
    id: 'article-1',
    type: 'article',
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
        return [{ ['COUNT(id)']: reviewCount }];
      }
      return [];
    }),
    mutate: vi.fn().mockResolvedValue([[]]),
    _execSql: vi.fn(),
    handleFileChange: vi.fn(),
  } as unknown as SQLiteRepository;
}

function makeArticleRow(overrides: Partial<IArticleBase> = {}) {
  const { dismissed, ...rest } = makeArticle(overrides);
  return { ...rest, dismissed: Number(dismissed) };
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
  it('does not mutate the database if the priority is invalid', async () => {
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
          await manager.disableFixedInterval(article, badPriority);
          const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock.calls;
          expect(calls).toHaveLength(0);
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

describe('getDue', () => {
  // Year 2000–2100 in ms, used to generate arbitrary "current time" values.
  const YEAR_2000_MS = new Date('2000-01-01T12:00:00Z').getTime();
  const YEAR_2100_MS = new Date('2100-01-01T12:00:00Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Obsidian, 'getNote').mockReturnValue({
      path: 'articles/test.md',
    } as TFile);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Repo that filters rows by the dueBy param, mirroring the SQL `due <= $1` condition. */
  function makeRepoWithArticles(
    rows: ReturnType<typeof makeArticleRow>[]
  ): SQLiteRepository {
    return {
      query: vi.fn().mockImplementation((sql: string, params: unknown[]) => {
        if (sql.startsWith('SELECT * FROM article')) {
          const dueBy = params[0] as number | undefined;
          return dueBy !== undefined
            ? rows.filter((r) => r.due !== null && r.due <= dueBy)
            : rows;
        }
        return [];
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;
  }

  it('returns articles due at or before the offset-adjusted end of day, but not after', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: YEAR_2000_MS, max: YEAR_2100_MS }),
        fc.integer({ min: DAY_ROLLOVER_OFFSET_HOURS.MIN, max: DAY_ROLLOVER_OFFSET_HOURS.MAX }),
        async (nowMs, offset) => {
          vi.setSystemTime(nowMs);

          const cutoff = getEndOfToday(offset);
          const rowAtCutoff = makeArticleRow({ id: 'at-cutoff', due: cutoff });
          const rowAfterCutoff = makeArticleRow({ id: 'after-cutoff', due: cutoff + 1 });
          const repo = makeRepoWithArticles([rowAtCutoff, rowAfterCutoff]);
          const plugin = {
            app: {},
            settings: { dayRolloverOffset: offset },
          } as never;
          const manager = new ArticleManager(plugin, repo);

          const results = await manager.getDue();

          const ids = results.map((r) => r.data.id);
          expect(ids).toContain('at-cutoff');
          expect(ids).not.toContain('after-cutoff');
        }
      )
    );
  });
});
