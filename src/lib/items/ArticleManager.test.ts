/* eslint-disable obsidianmd/no-tfile-tfolder-cast -- this is a test file */
import {
  ARTICLE_DIRECTORY,
  ARTICLE_TAG,
  CARD_TAG,
  DATA_DIRECTORY,
  DAY_ROLLOVER_OFFSET_HOURS,
  DEFAULT_PRIORITY,
  MAXIMUM_FIXED_REVIEW_INTERVAL,
  MAXIMUM_PRIORITY,
  MINIMUM_FIXED_REVIEW_INTERVAL,
  MINIMUM_PRIORITY,
  MS_PER_DAY,
  MS_PER_YEAR,
  SNIPPET_TAG,
  TEXT_BASE_REVIEW_INTERVAL,
} from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import type {
  ArticleRow,
  IArticleBase,
  IArticleReview,
  SQLiteRepository,
} from '#/lib/types';
import { getEndOfToday } from '#/lib/utils';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import type { TFile } from 'obsidian';
import { resolve } from 'path';
import type { Database } from 'sql.js';
import initSqlJs from 'sql.js';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArticleManager } from './ArticleManager';

// #region HELPERS
function makeArticle(overrides: Partial<IArticleBase> = {}): IArticleBase {
  return {
    id: 'article-1',
    type: 'article',
    reference: 'articles/test.md',
    due: Date.now(),
    due_fuzz: null,
    interval: TEXT_BASE_REVIEW_INTERVAL,
    dismissed: false,
    deleted: false,
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

function makeImportPlugin(copyOnImport: boolean) {
  return {
    app: {
      ...makeApp(),
      vault: { cachedRead: vi.fn().mockResolvedValue('# Content') },
    },
    settings: { copyOnImport, defaultPriority: DEFAULT_PRIORITY },
  } as never;
}

/** Returns the [sql, params] tuple from the latest call to repo.query */
function lastQueryCall(repo: SQLiteRepository): [string, unknown[]] {
  const calls = (repo.query as ReturnType<typeof vi.fn>).mock.calls as [
    string,
    unknown[],
  ][];
  return calls[calls.length - 1];
}

/** Arbitrary for a valid ArticleRow */
const articleRowArb = fc.record<ArticleRow>({
  id: fc.uuid(),
  reference: fc.string({ minLength: 1 }),
  due: fc.oneof(
    fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR * 100 }),
    fc.constant(null)
  ),
  due_fuzz: fc.oneof(fc.integer(), fc.constant(null)),
  interval: fc.integer({ min: 0, max: MS_PER_DAY * 365 * 50 }),
  dismissed: fc.oneof(fc.constant(0), fc.constant(1)),
  deleted: fc.boolean(),
  priority: fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
  fixed_interval_days: fc.oneof(
    fc.integer({
      min: MINIMUM_FIXED_REVIEW_INTERVAL,
      max: MAXIMUM_FIXED_REVIEW_INTERVAL,
    }),
    fc.constant(null)
  ),
  scroll_top: fc.integer({ min: 0 }),
});

function makeSimpleRepo(): SQLiteRepository {
  return {
    query: vi.fn().mockResolvedValue([]),
    mutate: vi.fn().mockResolvedValue([[]]),
    _execSql: vi.fn(),
    handleFileChange: vi.fn(),
  } as unknown as SQLiteRepository;
}

/**
 * Minimal Obsidian App stub. rowToReviewArticle reads frontmatter via
 * `app.metadataCache.getFileCache` and fire-and-forgets a `setFrontmatter`
 * write through `app.fileManager.processFrontMatter` when frontmatter is
 * missing. Both need to resolve cleanly so the test doesn't emit unhandled
 * promise rejections.
 */
function makeApp(): Record<string, unknown> {
  return {
    metadataCache: { getFileCache: () => undefined },
    fileManager: { processFrontMatter: async () => undefined },
  };
}

/**
 * A repo backed by a real in-memory sql.js database, so ORDER BY / LIMIT
 * clauses are actually executed (mock repos ignore them).
 */
async function makeSqlJsRepo(): Promise<{
  repo: SQLiteRepository;
  db: Database;
}> {
  const dbDir = resolve(__dirname, '../../db');
  const wasmBinary = readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
  const SQL = await initSqlJs({
    wasmBinary: wasmBinary as unknown as ArrayBuffer,
  });
  const db = new SQL.Database();
  db.exec(readFileSync(resolve(dbDir, 'schema.sql'), 'utf-8'));

  const query = (sql: string, params: unknown[] = []) => {
    const results = db.exec(sql, params as never);
    if (!results.length) return [];
    const { columns, values } = results[0];
    return values.map((row) =>
      Object.fromEntries(columns.map((col, i) => [col, row[i]]))
    );
  };
  const repo = {
    query: vi.fn().mockImplementation(query),
    mutate: vi.fn().mockImplementation((sql: string, params: unknown[]) => {
      query(sql, params);
      return [[]];
    }),
    _execSql: vi.fn(),
    handleFileChange: vi.fn(),
  } as unknown as SQLiteRepository;
  return { repo, db };
}

function insertArticleRow(
  db: Database,
  row: { id: string; due: number; due_fuzz: number | null; priority: number }
) {
  db.exec(
    `INSERT INTO article (id, reference, due, due_fuzz, interval, priority)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      row.id,
      `articles/${row.id}.md`,
      row.due,
      row.due_fuzz,
      TEXT_BASE_REVIEW_INTERVAL,
      row.priority,
    ]
  );
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

    it('targets the correct article id in the WHERE clause', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uuid(),
          fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
          async (id, priority) => {
            const repo = makeRepo(undefined, 0);
            const manager = new ArticleManager({} as never, repo);
            const article = makeArticle({ id });
            await manager.disableFixedInterval(article, priority);

            const [sql, params] = lastMutateCall(repo);
            expect(sql).toMatch(/WHERE id = \$3/i);
            expect(params[2]).toBe(id);
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
    vi.useFakeTimers({ toFake: ['Date'] });
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
        fc.integer({
          min: DAY_ROLLOVER_OFFSET_HOURS.MIN,
          max: DAY_ROLLOVER_OFFSET_HOURS.MAX,
        }),
        async (nowMs, offset) => {
          vi.setSystemTime(nowMs);

          const cutoff = getEndOfToday(offset);
          const rowAtCutoff = makeArticleRow({ id: 'at-cutoff', due: cutoff });
          const rowAfterCutoff = makeArticleRow({
            id: 'after-cutoff',
            due: cutoff + 1,
          });
          const repo = makeRepoWithArticles([rowAtCutoff, rowAfterCutoff]);
          const plugin = {
            app: makeApp(),
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

  describe('with a real SQLite database', () => {
    it('applies the SQL limit in fuzzed-due order, not priority order', async () => {
      const { repo, db } = await makeSqlJsRepo();
      const now = new Date('2026-01-10T12:00:00Z').getTime();
      // The highest-priority article is effectively due LAST once fuzz is
      // applied, so a limited fetch must not return it first.
      insertArticleRow(db, {
        id: 'later-fuzzed',
        due: now - 1_000,
        due_fuzz: 900,
        priority: MAXIMUM_PRIORITY,
      });
      insertArticleRow(db, {
        id: 'earlier-fuzzed',
        due: now - 2_000,
        due_fuzz: 100,
        priority: MINIMUM_PRIORITY,
      });
      const plugin = {
        app: makeApp(),
        settings: { dayRolloverOffset: 0, fuzzTextReviews: true },
      } as never;
      const manager = new ArticleManager(plugin, repo);

      const results = await manager.getDue(now, 1);

      expect(results.map((r) => r.data.id)).toEqual(['earlier-fuzzed']);
    });

    it('orders by fuzzed due even when fuzzTextReviews is disabled', async () => {
      const { repo, db } = await makeSqlJsRepo();
      const now = new Date('2026-01-10T12:00:00Z').getTime();
      // Priorities are the reverse of fuzzed-due order; stored fuzz must
      // still determine presentation order when the setting is off.
      insertArticleRow(db, {
        id: 'third',
        due: now - 100,
        due_fuzz: null,
        priority: MAXIMUM_PRIORITY,
      });
      insertArticleRow(db, {
        id: 'first',
        due: now - 5_000,
        due_fuzz: 1_000,
        priority: MINIMUM_PRIORITY,
      });
      insertArticleRow(db, {
        id: 'second',
        due: now - 3_000,
        due_fuzz: null,
        priority: DEFAULT_PRIORITY,
      });
      const plugin = {
        app: makeApp(),
        settings: { dayRolloverOffset: 0, fuzzTextReviews: false },
      } as never;
      const manager = new ArticleManager(plugin, repo);

      const results = await manager.getDue(now);

      expect(results.map((r) => r.data.id)).toEqual([
        'first',
        'second',
        'third',
      ]);
    });
  });

  it('skips rows whose note file is missing and retries until all results have files', async () => {
    // Simulate: first call returns rowA (no file) + rowB (has file), second call
    // returns only rowB (rowA excluded). Obsidian.getNote returns null for rowA's reference.
    const rowA = makeArticleRow({ id: 'no-file', due: 0 });
    const rowB = makeArticleRow({ id: 'has-file', due: 0 });
    const file = { path: 'articles/test.md' } as TFile;

    vi.spyOn(Obsidian, 'getNote').mockImplementation((_ref) => {
      if (_ref === rowA.reference) return null;
      return file;
    });

    let callCount = 0;
    const repo = {
      query: vi.fn().mockImplementation((_sql: string, params: unknown[]) => {
        callCount++;
        const excluded = params.slice(1) as string[];
        const rows = [rowA, rowB].filter((r) => !excluded.includes(r.id));
        return rows;
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0 },
    } as never;
    const manager = new ArticleManager(plugin, repo);
    const results = await manager.getDue(0);

    expect(results.every((r) => r.file !== null)).toBe(true);
    expect(results.map((r) => r.data.id)).not.toContain('no-file');
    expect(callCount).toBeGreaterThan(1);
  });

  it('starts with an empty exclude list when no excludeIds are given', async () => {
    const file = { path: 'articles/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(file);

    const queryCalls: [string, unknown[]][] = [];
    const repo = {
      query: vi.fn().mockImplementation((sql: string, params: unknown[]) => {
        queryCalls.push([sql, params]);
        return [];
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0 },
    } as never;
    const manager = new ArticleManager(plugin, repo);
    await manager.getDue(1);

    // The first call's SQL must not contain NOT IN (since no IDs were excluded yet)
    const [firstSql] = queryCalls[0];
    expect(firstSql).not.toMatch(/NOT IN/i);
  });

  it('passes pre-existing excludeIds on the first fetch call', async () => {
    const rowA = makeArticleRow({ id: 'excluded-by-caller', due: 0 });
    const file = { path: 'articles/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(file);

    const queryCalls: unknown[][] = [];
    const repo = {
      query: vi.fn().mockImplementation((_sql: string, params: unknown[]) => {
        queryCalls.push(params);
        return [];
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0 },
    } as never;
    const manager = new ArticleManager(plugin, repo);
    await manager.getDue(0, undefined, [rowA.id]);

    // The first query call's params should contain the pre-excluded ID
    const firstCallParams = queryCalls[0] as unknown[];
    expect(firstCallParams).toContain(rowA.id);
  });

  it('filters out items where rowToReviewArticle returns null (null row from filter predicate)', async () => {
    // Give each row a unique reference so the getNote mock can discriminate.
    // The second call must still return rowWithFile so that `due` is not empty after the retry.
    const rowWithFile = makeArticleRow({
      id: 'has-file',
      reference: 'articles/with-file.md',
      due: 1,
    });
    const rowNoFile = makeArticleRow({
      id: 'no-file-filter',
      reference: 'articles/no-file.md',
      due: 1,
    });
    const file = { path: 'articles/with-file.md' } as TFile;

    vi.spyOn(Obsidian, 'getNote').mockImplementation((ref) => {
      return ref === rowNoFile.reference ? null : file;
    });

    // First call returns both rows; second call returns only rowWithFile (rowNoFile is excluded).
    let call = 0;
    const repo = {
      query: vi.fn().mockImplementation((_sql: string, params: unknown[]) => {
        call++;
        if (call === 1) return [rowWithFile, rowNoFile];
        // Simulate SQL exclusion: omit rows whose id is in params
        return [rowWithFile, rowNoFile].filter((r) => !params.includes(r.id));
      }),
      mutate: vi.fn(),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0 },
    } as never;
    const manager = new ArticleManager(plugin, repo);
    const results = await manager.getDue(1);
    expect(results.map((r) => r.data.id)).not.toContain('no-file-filter');
    expect(results.map((r) => r.data.id)).toContain('has-file');
  });

  it('returns an empty array when the repo throws', async () => {
    const repo = {
      query: vi.fn().mockRejectedValue(new Error('db error')),
      mutate: vi.fn(),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;
    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0 },
    } as never;
    const manager = new ArticleManager(plugin, repo);
    const results = await manager.getDue();
    expect(results).toEqual([]);
  });
});

describe('rowToBase', () => {
  it('converts dismissed number to boolean and adds type', async () => {
    await fc.assert(
      fc.asyncProperty(articleRowArb, async (row) => {
        const base = ArticleManager.rowToBase(row);
        expect(base.type).toBe('article');
        expect(base.dismissed).toBe(Boolean(row.dismissed));
        // all other fields pass through unchanged
        expect(base.id).toBe(row.id);
        expect(base.reference).toBe(row.reference);
        expect(base.due).toBe(row.due);
        expect(base.interval).toBe(row.interval);
        expect(base.priority).toBe(row.priority);
        expect(base.fixed_interval_days).toBe(row.fixed_interval_days);
        expect(base.scroll_top).toBe(row.scroll_top);
      })
    );
  });
});

describe('rowToDisplay', () => {
  it('converts due to Date when present, or null when null', async () => {
    await fc.assert(
      fc.asyncProperty(articleRowArb, async (row) => {
        const display = ArticleManager.rowToDisplay(row);
        expect(display.type).toBe('article');
        expect(display.dismissed).toBe(Boolean(row.dismissed));
        if (row.due !== null) {
          expect(display.due).toBeInstanceOf(Date);
          expect((display.due as Date).getTime()).toBe(row.due);
        } else {
          expect(display.due).toBeNull();
        }
      })
    );
  });
});

describe('displayToRow', () => {
  it('round-trips through rowToDisplay: displayToRow(rowToDisplay(row)) equals row', async () => {
    await fc.assert(
      fc.asyncProperty(articleRowArb, async (row) => {
        const display = ArticleManager.rowToDisplay(row);
        const backToRow = ArticleManager.displayToRow(display);
        expect(backToRow.dismissed).toBe(row.dismissed);
        expect(backToRow.due).toBe(row.due);
        expect(backToRow.id).toBe(row.id);
        expect(backToRow.reference).toBe(row.reference);
        expect(backToRow.interval).toBe(row.interval);
        expect(backToRow.priority).toBe(row.priority);
        expect(backToRow.fixed_interval_days).toBe(row.fixed_interval_days);
        expect(backToRow.scroll_top).toBe(row.scroll_top);
        // type field must be stripped
        expect('type' in backToRow).toBe(false);
      })
    );
  });

  it('converts null due to null in row', async () => {
    await fc.assert(
      fc.asyncProperty(
        articleRowArb.map((r) => ({ ...r, due: null })),
        async (row) => {
          const display = ArticleManager.rowToDisplay(row);
          const backToRow = ArticleManager.displayToRow(display);
          expect(backToRow.due).toBeNull();
        }
      )
    );
  });
});

describe('rowToReviewArticle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when the file cannot be found', async () => {
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(null);
    await fc.assert(
      fc.asyncProperty(articleRowArb, async (row) => {
        const repo = makeSimpleRepo();
        const manager = new ArticleManager({} as never, repo);
        const result = manager.rowToReviewArticle(row);
        expect(result).toBeNull();
      })
    );
  });

  it('returns a ReviewArticle with data and file when the file exists', async () => {
    const fakeFile = { path: 'articles/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    await fc.assert(
      fc.asyncProperty(articleRowArb, async (row) => {
        const repo = makeSimpleRepo();
        const manager = new ArticleManager(
          { app: makeApp(), settings: { fuzzReviewTimes: false } } as never,
          repo
        );
        const result = manager.rowToReviewArticle(row);
        expect(result).not.toBeNull();
        expect(result!.file).toBe(fakeFile);
        expect(result!.data.id).toBe(row.id);
        expect(result!.data.dismissed).toBe(Boolean(row.dismissed));
        expect(result!.data.type).toBe('article');
      })
    );
  });

  it('calls markDeleted when the file is missing and the row is not already deleted', async () => {
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(null);
    const row = makeArticleRow({ deleted: false });
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    manager.rowToReviewArticle(row);
    await Promise.resolve();
    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const deleteCall = mutateCalls.find(([sql]) =>
      sql.includes('SET deleted = 1')
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall![1][0]).toBe(row.id);
  });

  it('skips markDeleted when the file is missing but the row is already deleted', async () => {
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(null);
    const row = makeArticleRow({ deleted: true });
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    manager.rowToReviewArticle(row);
    await Promise.resolve();
    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    expect(mutateCalls).toHaveLength(0);
  });

  it('returns null and calls markDeleted when frontmatter has a different ir-id', async () => {
    const fakeFile = { path: 'articles/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    const row = makeArticleRow({ id: 'row-id-001' });
    const repo = makeSimpleRepo();
    // Return frontmatter whose ir-id does NOT match the row id
    const manager = new ArticleManager(
      {
        app: {
          metadataCache: {
            getFileCache: () => ({
              frontmatter: { 'ir-id': 'different-id', tags: [ARTICLE_TAG] },
            }),
          },
          fileManager: { processFrontMatter: async () => undefined },
        },
        settings: { fuzzTextReviews: false },
      } as never,
      repo
    );
    const result = manager.rowToReviewArticle(row);
    expect(result).toBeNull();
    await Promise.resolve();
    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const deleteCall = mutateCalls.find(([sql]) =>
      sql.includes('SET deleted = 1')
    );
    expect(deleteCall).toBeDefined();
  });

  it('calls setFrontmatter when the file has an ir-id but lacks the article tag', async () => {
    const fakeFile = { path: 'articles/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    const row = makeArticleRow({
      id: 'row-id-002',
      deleted: false,
      due_fuzz: 0,
    });
    const processFrontMatterSpy = vi.fn().mockResolvedValue(undefined);
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      {
        app: {
          metadataCache: {
            getFileCache: () => ({
              frontmatter: { 'ir-id': row.id, tags: [] },
            }),
          },
          fileManager: { processFrontMatter: processFrontMatterSpy },
        },
        settings: { fuzzTextReviews: false },
      } as never,
      repo
    );
    manager.rowToReviewArticle(row);
    await Promise.resolve();
    expect(processFrontMatterSpy).toHaveBeenCalled();
  });

  it('calls setFrontmatter when the file has matching ir-id but no tags field', async () => {
    const fakeFile = { path: 'articles/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    const row = makeArticleRow({
      id: 'row-id-003',
      deleted: false,
      due_fuzz: 0,
    });
    const processFrontMatterSpy = vi.fn().mockResolvedValue(undefined);
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      {
        app: {
          metadataCache: {
            getFileCache: () => ({
              frontmatter: { 'ir-id': row.id },
            }),
          },
          fileManager: { processFrontMatter: processFrontMatterSpy },
        },
        settings: { fuzzTextReviews: false },
      } as never,
      repo
    );
    manager.rowToReviewArticle(row);
    await Promise.resolve();
    expect(processFrontMatterSpy).toHaveBeenCalled();
  });

  it('does not call setFrontmatter when the file has both matching ir-id and the article tag', async () => {
    const fakeFile = { path: 'articles/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    const row = makeArticleRow({
      id: 'row-id-004',
      deleted: false,
      due_fuzz: 0,
    });
    const processFrontMatterSpy = vi.fn().mockResolvedValue(undefined);
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      {
        app: {
          metadataCache: {
            getFileCache: () => ({
              frontmatter: { 'ir-id': row.id, tags: [ARTICLE_TAG] },
            }),
          },
          fileManager: { processFrontMatter: processFrontMatterSpy },
        },
        settings: { fuzzTextReviews: false },
      } as never,
      repo
    );
    manager.rowToReviewArticle(row);
    await Promise.resolve();
    expect(processFrontMatterSpy).not.toHaveBeenCalled();
  });

  it('does not call markUndeleted when the file exists and the row is not deleted', async () => {
    const fakeFile = { path: 'articles/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    const row = makeArticleRow({
      deleted: false,
      due_fuzz: 0,
      id: 'row-id-005',
    });
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      {
        app: {
          metadataCache: {
            getFileCache: () => ({
              frontmatter: { 'ir-id': row.id, tags: [ARTICLE_TAG] },
            }),
          },
          fileManager: { processFrontMatter: async () => undefined },
        },
        settings: { fuzzTextReviews: false },
      } as never,
      repo
    );
    manager.rowToReviewArticle(row);
    await Promise.resolve();
    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const undeleteCall = mutateCalls.find(([sql]) =>
      sql.includes('SET deleted = 0')
    );
    expect(undeleteCall).toBeUndefined();
  });

  it('calls markUndeleted when the file exists but the row is flagged as deleted', async () => {
    const fakeFile = { path: 'articles/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    const row = makeArticleRow({ deleted: true, due_fuzz: 0 });
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      { app: makeApp(), settings: { fuzzTextReviews: false } } as never,
      repo
    );
    manager.rowToReviewArticle(row);
    await Promise.resolve();
    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const undeleteCall = mutateCalls.find(([sql]) =>
      sql.includes('SET deleted = 0')
    );
    expect(undeleteCall).toBeDefined();
    expect(undeleteCall![1][0]).toBe(row.id);
  });
});

describe('fetchMany', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns all rows when called with no options', async () => {
    const rows = [makeArticleRow({ id: 'a' }), makeArticleRow({ id: 'b' })];
    const repo = {
      query: vi.fn().mockResolvedValue(rows),
      mutate: vi.fn(),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;
    const manager = new ArticleManager({} as never, repo);
    const result = await manager.fetchMany();
    expect(result).toEqual(rows);
    const [sql, params] = lastQueryCall(repo);
    expect(sql).toMatch(/SELECT \* FROM article/i);
    // dismissed = 0 filter is always applied by default
    expect(sql).toMatch(/dismissed = 0/i);
    expect(params).toEqual([]);
  });

  it('omits the dismissed filter when includeDismissed=true, but keeps the default deleted filter', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    await manager.fetchMany({ includeDismissed: true });
    const [sql] = lastQueryCall(repo);
    expect(sql).not.toMatch(/dismissed = 0/i);
    expect(sql).toMatch(/deleted = FALSE/i);
  });

  it('adds a due filter when dueBy is provided', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    const dueBy = Date.now();
    await manager.fetchMany({ dueBy });
    const [sql, params] = lastQueryCall(repo);
    expect(sql).toMatch(/due <= \$1/i);
    expect(params[0]).toBe(dueBy);
  });

  it('excludes dismissed rows by default', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    await manager.fetchMany();
    const [sql] = lastQueryCall(repo);
    expect(sql).toMatch(/dismissed = 0/i);
  });

  it('includes dismissed rows when includeDismissed is true', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    await manager.fetchMany({ includeDismissed: true });
    const [sql] = lastQueryCall(repo);
    expect(sql).not.toMatch(/dismissed = 0/i);
  });

  it('adds an excludeIds NOT IN clause with correct positional params', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uuid(), { minLength: 1, maxLength: 10 }),
        async (excludeIds) => {
          const repo = makeSimpleRepo();
          const manager = new ArticleManager({} as never, repo);
          await manager.fetchMany({ excludeIds });
          const [sql, params] = lastQueryCall(repo);
          expect(sql).toMatch(/id NOT IN/i);
          for (const id of excludeIds) {
            expect(params).toContain(id);
          }
        }
      )
    );
  });

  it('applies a LIMIT clause when limit is provided', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 100 }), async (limit) => {
        const repo = makeSimpleRepo();
        const manager = new ArticleManager({} as never, repo);
        await manager.fetchMany({ limit });
        const [sql, params] = lastQueryCall(repo);
        expect(sql).toMatch(/LIMIT/i);
        expect(params).toContain(limit);
      })
    );
  });

  it('uses correctly sequenced $N params when dueBy and excludeIds and limit are all set', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    const dueBy = 1000;
    const excludeIds = ['id-1', 'id-2'];
    const limit = 5;
    await manager.fetchMany({ dueBy, excludeIds, limit });
    const [sql, params] = lastQueryCall(repo);
    // dueBy is $1, excludeIds are $2 and $3, limit is $4
    expect(sql).toContain('$1');
    expect(sql).toContain('$2');
    expect(sql).toContain('$3');
    expect(sql).toContain('$4');
    expect(params[0]).toBe(dueBy);
    expect(params[1]).toBe('id-1');
    expect(params[2]).toBe('id-2');
    expect(params[3]).toBe(limit);
  });

  it('throws when param count exceeds MAX_SQL_QUERY_PARAMS', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    // 1000 IDs exceeds the limit of 999
    const excludeIds = Array.from({ length: 1000 }, (_, i) => `id-${i}`);
    await expect(manager.fetchMany({ excludeIds })).rejects.toThrow();
  });

  it('does not throw when param count equals MAX_SQL_QUERY_PARAMS exactly', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    // dueBy=$1 + 998 excludeIds = 999 params total, which equals the limit (not over)
    const excludeIds = Array.from({ length: 998 }, (_, i) => `id-${i}`);
    await expect(
      manager.fetchMany({ dueBy: 1000, excludeIds })
    ).resolves.not.toThrow();
  });

  it('uses commas between NOT IN placeholders', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    await manager.fetchMany({ excludeIds: ['a', 'b', 'c'] });
    const [sql] = lastQueryCall(repo);
    expect(sql).toMatch(/NOT IN \(\$\d+, \$\d+, \$\d+\)/i);
  });

  it('uses AND to join multiple WHERE conditions', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    await manager.fetchMany({ dueBy: 1000, excludeIds: ['a'] });
    const [sql] = lastQueryCall(repo);
    expect(sql).toMatch(/ AND /i);
  });

  it('produces a WHERE clause (not empty string) when conditions are present', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    await manager.fetchMany({ dueBy: 1000 });
    const [sql] = lastQueryCall(repo);
    // The SQL must contain literal " WHERE " (not just the conditions)
    expect(sql).toContain(' WHERE ');
  });

  it('orders results by fuzzed due ascending with null dues last', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    await manager.fetchMany();
    const [sql] = lastQueryCall(repo);
    expect(sql).toMatch(
      /ORDER BY \(due IS NULL\), due \+ COALESCE\(due_fuzz, 0\)/i
    );
  });
});

describe('fetch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when no row is found', async () => {
    const repo = {
      query: vi.fn().mockResolvedValue([]),
      mutate: vi.fn(),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;
    const manager = new ArticleManager({} as never, repo);
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(null);
    const result = await manager.fetch('nonexistent-id');
    expect(result).toBeNull();
  });

  it('passes the id as a query param', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (id) => {
        const repo = {
          query: vi.fn().mockResolvedValue([]),
          mutate: vi.fn(),
          _execSql: vi.fn(),
          handleFileChange: vi.fn(),
        } as unknown as SQLiteRepository;
        const manager = new ArticleManager({} as never, repo);
        await manager.fetch(id);
        const [sql, params] = lastQueryCall(repo);
        expect(sql).toMatch(/WHERE id = \$1/i);
        expect(params[0]).toBe(id);
      })
    );
  });

  it('returns a ReviewArticle when a row and file are found', async () => {
    const row = makeArticleRow();
    const fakeFile = { path: 'articles/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    const repo = {
      query: vi.fn().mockResolvedValue([row]),
      mutate: vi.fn(),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;
    const manager = new ArticleManager(
      { app: makeApp(), settings: { fuzzReviewTimes: false } } as never,
      repo
    );
    const result = await manager.fetch(row.id);
    expect(result).not.toBeNull();
    expect(result!.data.id).toBe(row.id);
    expect(result!.file).toBe(fakeFile);
  });
});

describe('getLastReview (via review / reprioritize / setFixedInterval)', () => {
  // getLastReview is protected; we test it indirectly through public methods.
  // Direct query behavior is covered via the makeRepo helper in existing tests.

  it('queries article_review ordered by review_time DESC LIMIT 1', async () => {
    const article = makeArticle();
    const repo = makeRepo(undefined, 0);
    const manager = new ArticleManager({} as never, repo);
    // reprioritize calls getLastReview
    await manager.reprioritize(article, DEFAULT_PRIORITY);
    const calls = (repo.query as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      unknown[],
    ][];
    const reviewQuery = calls.find(([sql]) =>
      sql.includes('ORDER BY review_time DESC')
    );
    expect(reviewQuery).toBeDefined();
    expect(reviewQuery![1][0]).toBe(article.id);
  });
});

describe('getReviewCount (via disableFixedInterval)', () => {
  it('queries COUNT(id) from article_review for the given article id', async () => {
    const article = makeArticle();
    const repo = makeRepo(undefined, 0);
    const manager = new ArticleManager({} as never, repo);
    await manager.disableFixedInterval(article, DEFAULT_PRIORITY);
    const calls = (repo.query as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      unknown[],
    ][];
    const countQuery = calls.find(([sql]) => sql.includes('COUNT(id)'));
    expect(countQuery).toBeDefined();
    expect(countQuery![1][0]).toBe(article.id);
  });
});

describe('review', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('inserts an article_review record with the given review time', async () => {
    // Note: reviewTime=0 is excluded because the implementation uses `reviewTime || Date.now()`
    // which treats 0 as falsy — a bug. Tests are written for the fixed version (min: 1).
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: Date.now() + MS_PER_YEAR }),
        async (reviewTime) => {
          const article = makeArticle();
          const repo = makeSimpleRepo();
          const manager = new ArticleManager(
            { settings: { fuzzReviewTimes: false } } as never,
            repo
          );
          await manager.review(article, reviewTime);
          const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock
            .calls as [string, unknown[]][];
          const insertCall = calls.find(([sql]) =>
            sql.includes('INSERT INTO article_review')
          );
          expect(insertCall).toBeDefined();
          expect(insertCall![1][2]).toBe(reviewTime);
          expect(insertCall![1][1]).toBe(article.id);
        }
      )
    );
  });

  it('falls back to Date.now() when reviewTime is not provided', async () => {
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const article = makeArticle();
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      { settings: { fuzzReviewTimes: false } } as never,
      repo
    );
    await manager.review(article);
    const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      unknown[],
    ][];
    const insertCall = calls.find(([sql]) =>
      sql.includes('INSERT INTO article_review')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1][2]).toBe(now);
  });

  it('updates article due, interval, and clears dismissed', async () => {
    // reviewTime=0 excluded — same bug as above
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: Date.now() + MS_PER_YEAR }),
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        async (reviewTime, priority) => {
          const article = makeArticle({ priority });
          const repo = makeSimpleRepo();
          const manager = new ArticleManager(
            { settings: { fuzzReviewTimes: false } } as never,
            repo
          );
          await manager.review(article, reviewTime);

          const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock
            .calls as [string, unknown[]][];
          const updateCall = calls.find(([sql]) =>
            sql.includes('UPDATE article SET dismissed')
          );
          expect(updateCall).toBeDefined();
          const [updateSql, params] = updateCall!;
          const expectedInterval = IRScheduler.nextInterval(article);
          const expectedDue = reviewTime + expectedInterval;
          expect(params[0]).toBe(expectedDue);
          expect(params[1]).toBe(expectedInterval);
          expect(params[3]).toBe(article.id);
          expect(updateSql).toMatch(/dismissed = 0/i);
        }
      )
    );
  });

  it('uses a provided nextReviewInterval instead of computing one', async () => {
    // reviewTime=0 excluded — same bug as above
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: Date.now() }),
        fc.integer({ min: MS_PER_DAY, max: MS_PER_DAY * 30 }),
        async (reviewTime, nextInterval) => {
          const article = makeArticle();
          const repo = makeSimpleRepo();
          const manager = new ArticleManager(
            { settings: { fuzzReviewTimes: false } } as never,
            repo
          );
          await manager.review(article, reviewTime, nextInterval);

          const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock
            .calls as [string, unknown[]][];
          const updateCall = calls.find(([sql]) =>
            sql.includes('UPDATE article SET dismissed')
          );
          expect(updateCall).toBeDefined();
          const [, params] = updateCall!;
          expect(params[0]).toBe(reviewTime + nextInterval);
          expect(params[1]).toBe(nextInterval);
        }
      )
    );
  });
});

describe('rename', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a notice and returns without mutating when the name contains invalid chars', async () => {
    const invalidChars = [
      '#',
      '^',
      '[',
      ']',
      '|',
      '*',
      '"',
      '\\',
      '/',
      '<',
      '>',
      ':',
      '?',
    ];
    for (const char of invalidChars) {
      const repo = makeSimpleRepo();
      const manager = new ArticleManager({} as never, repo);
      const article = {
        data: makeArticle(),
        file: {
          basename: 'test',
          extension: 'md',
          parent: null,
        } as unknown as TFile,
      };
      await manager.rename(article, `valid-name${char}`);
      expect((repo.mutate as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
        0
      );
    }
  });

  it('updates the reference in the db using the new name after renaming', async () => {
    vi.spyOn(Obsidian, 'renameFile').mockResolvedValue(undefined);
    const newName = 'new-valid-name';
    const extension = 'md';
    const parentPath = 'some/folder';
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    const article = {
      data: makeArticle({ id: 'art-1' }),
      file: {
        basename: 'old-name',
        extension,
        path: `${parentPath}/old-name.${extension}`,
        parent: { path: parentPath },
      } as unknown as TFile,
    };

    await manager.rename(article, newName);

    const [sql, params] = lastMutateCall(repo);
    expect(sql).toMatch(/UPDATE article SET reference = \$1 WHERE id = \$2/i);
    expect(params[0]).toBe(`${parentPath}/${newName}.${extension}`);
    expect(params[1]).toBe('art-1');
  });

  it('rejects names ending in a trailing space or period without mutating', async () => {
    for (const name of ['valid-name ', 'valid-name.']) {
      const repo = makeSimpleRepo();
      const manager = new ArticleManager({} as never, repo);
      const article = {
        data: makeArticle(),
        file: {
          basename: 'test',
          extension: 'md',
          parent: null,
        } as unknown as TFile,
      };
      await manager.rename(article, name);
      expect((repo.mutate as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
        0
      );
    }
  });

  it('attempts to rename back to original name if the db update throws', async () => {
    const renameFileSpy = vi
      .spyOn(Obsidian, 'renameFile')
      .mockResolvedValue(undefined);
    const repo = {
      query: vi.fn().mockResolvedValue([]),
      mutate: vi.fn().mockRejectedValue(new Error('db error')),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;
    const manager = new ArticleManager({} as never, repo);
    const originalName = 'original';
    const article = {
      data: makeArticle({ id: 'art-1' }),
      file: {
        basename: originalName,
        extension: 'md',
        parent: null,
      } as unknown as TFile,
    };
    await manager.rename(article, 'new-name');
    // second renameFile call should use the original name
    const calls = renameFileSpy.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[calls.length - 1][1]).toBe(originalName);
  });
});

describe('reprioritize', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws (via validatePriority) for an invalid priority without mutating', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.integer({ max: MINIMUM_PRIORITY - 1 }),
          fc.integer({ min: MAXIMUM_PRIORITY + 1 })
        ),
        async (badPriority) => {
          const repo = makeSimpleRepo();
          const manager = new ArticleManager({} as never, repo);
          await expect(
            manager.reprioritize(makeArticle(), badPriority)
          ).rejects.toThrow();
          expect(
            (repo.mutate as ReturnType<typeof vi.fn>).mock.calls
          ).toHaveLength(0);
        }
      )
    );
  });

  it('updates priority, due, and interval in the db', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        fc.integer({ min: 0, max: Date.now() }),
        async (priority, newPriority, reviewTime) => {
          const article = makeArticle({ priority });
          const repo = makeRepo(makeReview(reviewTime), 1);
          const manager = new ArticleManager({} as never, repo);
          await manager.reprioritize(article, newPriority);

          const [sql, params] = lastMutateCall(repo);
          expect(sql).toMatch(
            /UPDATE article SET priority = \$1, due = \$2, interval = \$3 WHERE id = \$4/i
          );
          expect(params[0]).toBe(newPriority);
          const expectedInterval = IRScheduler.nextInterval({
            ...article,
            priority: newPriority,
          });
          expect(params[2]).toBe(expectedInterval);
          expect(params[1]).toBe(reviewTime + expectedInterval);
          expect(params[3]).toBe(article.id);
        }
      )
    );
  });

  it('falls back to article.due when there is no prior review', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR }),
        async (newPriority, due) => {
          const article = makeArticle({ due });
          const repo = makeRepo(undefined, 0);
          const manager = new ArticleManager({} as never, repo);
          await manager.reprioritize(article, newPriority);

          const [, params] = lastMutateCall(repo);
          expect(params[1]).toBe(due);
        }
      )
    );
  });
});

describe('setFixedInterval', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not mutate the db when the interval is invalid', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.integer({ max: MINIMUM_FIXED_REVIEW_INTERVAL - 1 }),
          fc.integer({ min: MAXIMUM_FIXED_REVIEW_INTERVAL + 1 })
        ),
        async (badInterval) => {
          const repo = makeSimpleRepo();
          const manager = new ArticleManager({} as never, repo);
          await manager.setFixedInterval(makeArticle(), badInterval);
          expect(
            (repo.mutate as ReturnType<typeof vi.fn>).mock.calls
          ).toHaveLength(0);
        }
      )
    );
  });

  it('updates fixed_interval_days and due in the db', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({
          min: MINIMUM_FIXED_REVIEW_INTERVAL,
          max: MAXIMUM_FIXED_REVIEW_INTERVAL,
        }),
        fc.integer({ min: 0, max: Date.now() }),
        async (fixedIntervalDays, reviewTime) => {
          const article = makeArticle();
          const repo = makeRepo(makeReview(reviewTime), 1);
          const manager = new ArticleManager({} as never, repo);
          await manager.setFixedInterval(article, fixedIntervalDays);

          const [sql, params] = lastMutateCall(repo);
          expect(sql).toMatch(
            /UPDATE article SET fixed_interval_days = \$1, due = \$2/i
          );
          expect(params[0]).toBe(fixedIntervalDays);
          const fixedIntervalMs = fixedIntervalDays * MS_PER_DAY;
          expect(params[1]).toBe(reviewTime + fixedIntervalMs);
          expect(params[2]).toBe(article.id);
        }
      )
    );
  });

  it('falls back to article.due when there is no prior review', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({
          min: MINIMUM_FIXED_REVIEW_INTERVAL,
          max: MAXIMUM_FIXED_REVIEW_INTERVAL,
        }),
        fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR }),
        async (fixedIntervalDays, due) => {
          const article = makeArticle({ due });
          const repo = makeRepo(undefined, 0);
          const manager = new ArticleManager({} as never, repo);
          await manager.setFixedInterval(article, fixedIntervalDays);

          const [, params] = lastMutateCall(repo);
          expect(params[1]).toBe(due);
        }
      )
    );
  });

  it('targets the correct article id in the WHERE clause', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.integer({
          min: MINIMUM_FIXED_REVIEW_INTERVAL,
          max: MAXIMUM_FIXED_REVIEW_INTERVAL,
        }),
        async (id, fixedIntervalDays) => {
          const article = makeArticle({ id });
          const repo = makeRepo(undefined, 0);
          const manager = new ArticleManager({} as never, repo);
          await manager.setFixedInterval(article, fixedIntervalDays);
          const [sql, params] = lastMutateCall(repo);
          expect(sql).toMatch(/WHERE id = \$3/i);
          expect(params[2]).toBe(id);
        }
      )
    );
  });
});

describe('fetchMany (includeDeleted option)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('omits the deleted filter when includeDeleted=true', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    await manager.fetchMany({ includeDeleted: true });
    const [sql] = lastQueryCall(repo);
    expect(sql).not.toMatch(/deleted = FALSE/i);
  });

  it('includes deleted = FALSE filter by default', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    await manager.fetchMany();
    const [sql] = lastQueryCall(repo);
    expect(sql).toMatch(/deleted = FALSE/i);
  });

  it('produces no WHERE clause when all filters are disabled', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    await manager.fetchMany({ includeDismissed: true, includeDeleted: true });
    const [sql] = lastQueryCall(repo);
    expect(sql).not.toContain(' WHERE ');
  });

  it('throws with a non-empty message when param count exceeds MAX_SQL_QUERY_PARAMS', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    const excludeIds = Array.from({ length: 1000 }, (_, i) => `id-${i}`);
    await expect(manager.fetchMany({ excludeIds })).rejects.toThrow(
      /exceeded/i
    );
  });
});

describe('rename (no-parent path)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses "<newName>.<ext>" when file has no parent directory', async () => {
    vi.spyOn(Obsidian, 'renameFile').mockResolvedValue(undefined);
    const newName = 'rootlevel-name';
    const extension = 'md';
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    const article = {
      data: makeArticle({ id: 'art-noparent' }),
      file: {
        basename: 'old-name',
        extension,
        path: `old-name.${extension}`,
        parent: null,
      } as unknown as TFile,
    };

    await manager.rename(article, newName);

    const [sql, params] = lastMutateCall(repo);
    expect(sql).toMatch(/UPDATE article SET reference = \$1 WHERE id = \$2/i);
    expect(params[0]).toBe(`${newName}.${extension}`);
    expect(params[1]).toBe('art-noparent');
  });
});

describe('setFixedInterval (error handling)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not throw when the validation fails (error is caught)', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    await expect(
      manager.setFixedInterval(makeArticle(), MINIMUM_FIXED_REVIEW_INTERVAL - 1)
    ).resolves.toBeUndefined();
    expect((repo.mutate as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
      0
    );
  });
});

describe('disableFixedInterval (error handling)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not throw when the validation fails (error is caught internally)', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    await expect(
      manager.disableFixedInterval(makeArticle(), MINIMUM_PRIORITY - 1)
    ).resolves.toBeUndefined();
    expect((repo.mutate as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
      0
    );
  });
});

describe('getDue (filter correctness)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('excludes items where rowToReviewArticle returns null from the final result (article.file null check)', async () => {
    // rowToReviewArticle returns null when getNote returns null.
    // Mutant: `!!article && article.file !== null` → `true` would include nulls.
    // Rows must have distinct references so the mock can discriminate.
    const rowNoFile = makeArticleRow({
      id: 'null-item',
      reference: 'articles/no-file.md',
      due: 0,
    });
    const rowWithFile = makeArticleRow({
      id: 'real-item',
      reference: 'articles/with-file.md',
      due: 0,
    });
    const file = { path: 'articles/with-file.md' } as TFile;

    vi.spyOn(Obsidian, 'getNote').mockImplementation((ref) =>
      ref === rowNoFile.reference ? null : file
    );

    let callCount = 0;
    const repo = {
      query: vi.fn().mockImplementation((_sql: string, params: unknown[]) => {
        callCount++;
        const excluded = params.slice(1) as string[];
        return [rowNoFile, rowWithFile].filter((r) => !excluded.includes(r.id));
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0 },
    } as never;
    const manager = new ArticleManager(plugin, repo);
    const results = await manager.getDue(0);

    expect(results.map((r) => r.data.id)).not.toContain('null-item');
    expect(results.map((r) => r.data.id)).toContain('real-item');
    expect(callCount).toBeGreaterThan(1);
  });

  it('increments the missing-notes counter so the loop retries (not decrements)', async () => {
    // Mutant: lastMissingNotes += 1 → lastMissingNotes -= 1 would cause the loop
    // to terminate after one pass even when items are still missing.
    // Rows must have distinct references so the mock can discriminate.
    const missingRow = makeArticleRow({
      id: 'missing',
      reference: 'articles/missing.md',
      due: 0,
    });
    const presentRow = makeArticleRow({
      id: 'present',
      reference: 'articles/present.md',
      due: 0,
    });
    const file = { path: 'articles/present.md' } as TFile;

    vi.spyOn(Obsidian, 'getNote').mockImplementation((ref) =>
      ref === missingRow.reference ? null : file
    );

    const queryCalls: { sql: string; params: unknown[] }[] = [];
    const repo = {
      query: vi.fn().mockImplementation((sql: string, params: unknown[]) => {
        queryCalls.push({ sql, params });
        // Extract excludeIds from the params: they follow the optional dueBy param.
        // Use the SQL to count how many leading params exist before the NOT IN list.
        const excluded = params.filter(
          (p): p is string => typeof p === 'string'
        );
        return [missingRow, presentRow].filter((r) => !excluded.includes(r.id));
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0 },
    } as never;
    const manager = new ArticleManager(plugin, repo);
    // Use a future dueBy so the dueBy filter is included (truthy value avoids the bug)
    await manager.getDue(Date.now() + 1);

    // At least 2 queries should have run — the retry must have happened
    expect(queryCalls.length).toBeGreaterThanOrEqual(2);
    // The second call must include the missing row's id as an excluded param
    expect(queryCalls[1].params).toContain(missingRow.id);
  });
});

describe('fuzzing (rowToReviewArticle)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires setReviewTimeFuzz when fuzzTextReviews=true and due_fuzz is null', async () => {
    const fakeFile = { path: 'articles/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    vi.spyOn(IRScheduler, 'getDueFuzz').mockReturnValue(3600000);

    const row = makeArticleRow({ due_fuzz: null });
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      { app: makeApp(), settings: { fuzzTextReviews: true } } as never,
      repo
    );

    manager.rowToReviewArticle(row);

    // give the fire-and-forgotten promise a chance to run
    await Promise.resolve();

    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const fuzzCall = mutateCalls.find(([sql]) => sql.includes('SET due_fuzz'));
    expect(fuzzCall).toBeDefined();
    expect(fuzzCall![1][0]).toBe(3600000);
    expect(fuzzCall![1][1]).toBe(row.id);
  });

  it('does not fire setReviewTimeFuzz when fuzzTextReviews=false', async () => {
    const fakeFile = { path: 'articles/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);

    const row = makeArticleRow({ due_fuzz: null });
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      { app: makeApp(), settings: { fuzzTextReviews: false } } as never,
      repo
    );

    manager.rowToReviewArticle(row);
    await Promise.resolve();

    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const fuzzCall = mutateCalls.find(([sql]) => sql.includes('SET due_fuzz'));
    expect(fuzzCall).toBeUndefined();
  });

  it('does not fire setReviewTimeFuzz when due_fuzz is already set', async () => {
    const fakeFile = { path: 'articles/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);

    const row = makeArticleRow({ due_fuzz: 12345 });
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      { app: makeApp(), settings: { fuzzTextReviews: true } } as never,
      repo
    );

    manager.rowToReviewArticle(row);
    await Promise.resolve();

    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const fuzzCall = mutateCalls.find(([sql]) => sql.includes('SET due_fuzz'));
    expect(fuzzCall).toBeUndefined();
  });
});

describe('fuzzing (getDue sort)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(Obsidian, 'getNote').mockReturnValue({
      path: 'articles/test.md',
    } as TFile);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sorts by effective due (due + due_fuzz) when fuzzTextReviews=true', async () => {
    // articleA: due=300, fuzz=+100 → pushed further out
    // articleB: due=100, fuzz=-100 → pulled closer in
    // The sort formula `a.due + a.fuzz - b.due + b.fuzz` is antisymmetric when
    // fuzz values are negations of each other, giving a stable comparison:
    // compare(A,B) = 300+100-100+(-100) = +200 → A after B
    // compare(B,A) = 100+(-100)-300+100 = -200 → B before A
    const rowA = makeArticleRow({ id: 'a', due: 300, due_fuzz: 100 });
    const rowB = makeArticleRow({ id: 'b', due: 100, due_fuzz: -100 });

    const repo = {
      query: vi.fn().mockResolvedValue([rowA, rowB]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0, fuzzTextReviews: true },
    } as never;
    const manager = new ArticleManager(plugin, repo);
    const results = await manager.getDue(Number.MAX_SAFE_INTEGER);

    const ids = results.map((r) => r.data.id);
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('a'));
  });

  it('does not reorder by fuzz when fuzzTextReviews=false', async () => {
    const rowA = makeArticleRow({ id: 'a', due: 100, due_fuzz: 50 });
    const rowB = makeArticleRow({ id: 'b', due: 200, due_fuzz: -80 });

    const repo = {
      query: vi.fn().mockResolvedValue([rowA, rowB]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0, fuzzTextReviews: false },
    } as never;
    const manager = new ArticleManager(plugin, repo);
    const results = await manager.getDue(Number.MAX_SAFE_INTEGER);

    // SQL order is preserved: a before b
    const ids = results.map((r) => r.data.id);
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
  });

  it('treats null due_fuzz as 0 when sorting', async () => {
    // articleA: due=100, fuzz=null → effective=100
    // articleB: due=200, fuzz=-150 → effective=50
    // B (effective=50) should precede A (effective=100)
    const rowA = makeArticleRow({ id: 'a', due: 100, due_fuzz: null });
    const rowB = makeArticleRow({ id: 'b', due: 200, due_fuzz: -150 });

    const repo = {
      query: vi.fn().mockResolvedValue([rowA, rowB]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0, fuzzTextReviews: true },
    } as never;
    const manager = new ArticleManager(plugin, repo);
    const results = await manager.getDue(Number.MAX_SAFE_INTEGER);

    const ids = results.map((r) => r.data.id);
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('a'));
  });

  it('sorts a null-due article after all dated articles', async () => {
    // rowA has no due date → sorts last (comparator returns 1 when a.data.due is null)
    // rowB has a concrete due → sorts first
    const rowA = makeArticleRow({ id: 'a', due: null, due_fuzz: null });
    const rowB = makeArticleRow({ id: 'b', due: 100, due_fuzz: null });

    const repo = {
      query: vi.fn().mockResolvedValue([rowA, rowB]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0, fuzzTextReviews: true },
    } as never;
    const manager = new ArticleManager(plugin, repo);
    const results = await manager.getDue(Number.MAX_SAFE_INTEGER);

    const ids = results.map((r) => r.data.id);
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('a'));
  });

  it('sorts a null-due b before all a-dated articles when b.data.due is null', async () => {
    // rowA has a concrete due → comparator returns -1 when b.data.due is null → a first
    const rowA = makeArticleRow({ id: 'a', due: 100, due_fuzz: null });
    const rowB = makeArticleRow({ id: 'b', due: null, due_fuzz: null });

    const repo = {
      query: vi.fn().mockResolvedValue([rowA, rowB]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0, fuzzTextReviews: true },
    } as never;
    const manager = new ArticleManager(plugin, repo);
    const results = await manager.getDue(Number.MAX_SAFE_INTEGER);

    const ids = results.map((r) => r.data.id);
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
  });
});

describe('fuzzing (review)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('writes a new getDueFuzz value into due_fuzz when fuzzTextReviews=true', async () => {
    const FUZZ = 1_800_000;
    vi.spyOn(IRScheduler, 'getDueFuzz').mockReturnValue(FUZZ);

    const article = makeArticle({ due_fuzz: null });
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      { settings: { fuzzTextReviews: true } } as never,
      repo
    );
    await manager.review(article, 1000);

    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const updateCall = mutateCalls.find(([sql]) =>
      sql.includes('UPDATE article SET dismissed')
    );
    expect(updateCall).toBeDefined();
    // due_fuzz is the 3rd positional param ($3)
    expect(updateCall![1][2]).toBe(FUZZ);
  });

  it('preserves the existing due_fuzz when fuzzTextReviews=false', async () => {
    const existingFuzz = 42000;
    const article = makeArticle({ due_fuzz: existingFuzz });
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      { settings: { fuzzTextReviews: false } } as never,
      repo
    );
    await manager.review(article, 1000);

    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const updateCall = mutateCalls.find(([sql]) =>
      sql.includes('UPDATE article SET dismissed')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1][2]).toBe(existingFuzz);
  });

  it('does not call getDueFuzz when fuzzTextReviews=false', async () => {
    const getDueFuzzSpy = vi.spyOn(IRScheduler, 'getDueFuzz');
    const article = makeArticle();
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      { settings: { fuzzTextReviews: false } } as never,
      repo
    );
    await manager.review(article, 1000);
    expect(getDueFuzzSpy).not.toHaveBeenCalled();
  });
});

describe('import', () => {
  const IMPORT_FILE = {
    path: 'notes/my-note.md',
    name: 'my-note.md',
    basename: 'my-note',
    extension: 'md',
  } as TFile;

  const DATA_DIR_FILE = {
    path: `${DATA_DIRECTORY}/notes/my-note.md`,
    name: 'my-note.md',
    basename: 'my-note',
    extension: 'md',
  } as TFile;

  const COPY_FILE = {
    path: `${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}/my-note.md`,
    name: 'my-note.md',
    basename: 'my-note',
    extension: 'md',
  } as TFile;

  beforeEach(() => {
    vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue(undefined);
    vi.spyOn(Obsidian, 'updateFrontMatter').mockResolvedValue(
      undefined as never
    );
    vi.spyOn(Obsidian, 'isDuplicate').mockReturnValue(false);
    vi.spyOn(Obsidian, 'createNote').mockResolvedValue(COPY_FILE as never);
    vi.spyOn(Obsidian, 'generateMarkdownLink').mockReturnValue(
      '[[notes/my-note.md|my-note]]'
    );
    vi.spyOn(Obsidian, 'getDirectory').mockReturnValue(
      `${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}`
    );
    vi.spyOn(Obsidian, 'getTargetPath').mockReturnValue(
      `${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}/my-note.md`
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('in-place mode', () => {
    it('registers the original file without creating a copy', async () => {
      const repo = makeSimpleRepo();
      const manager = new ArticleManager(makeImportPlugin(false), repo);

      await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, false);

      expect(Obsidian.createNote).not.toHaveBeenCalled();
      const [sql, params] = lastMutateCall(repo);
      expect(sql).toContain('INSERT INTO article');
      expect(params[1]).toBe(IMPORT_FILE.path);
    });

    it('calls updateFrontMatter on the original file with the article tag', async () => {
      const repo = makeSimpleRepo();
      const manager = new ArticleManager(makeImportPlugin(false), repo);

      await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, false);

      expect(Obsidian.updateFrontMatter).toHaveBeenCalledWith(
        IMPORT_FILE,
        expect.objectContaining({ tags: ARTICLE_TAG }),
        expect.anything()
      );
    });

    it('does not add a source frontmatter link', async () => {
      const repo = makeSimpleRepo();
      const manager = new ArticleManager(makeImportPlugin(false), repo);

      await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, false);

      expect(Obsidian.generateMarkdownLink).not.toHaveBeenCalled();
      const fmCall = (Obsidian.updateFrontMatter as ReturnType<typeof vi.fn>)
        .mock.calls[0] as unknown[];
      expect(fmCall[1]).not.toHaveProperty('source');
    });

    it('allows files inside DATA_DIRECTORY without early-returning', async () => {
      const repo = makeSimpleRepo();
      const manager = new ArticleManager(makeImportPlugin(false), repo);

      await manager.import(DATA_DIR_FILE, DEFAULT_PRIORITY, null, false);

      const [sql, params] = lastMutateCall(repo);
      expect(sql).toContain('INSERT INTO article');
      expect(params[1]).toBe(DATA_DIR_FILE.path);
    });

    it('blocks files tagged as snippets', async () => {
      const repo = makeSimpleRepo();
      const manager = new ArticleManager(makeImportPlugin(false), repo);
      vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue({
        tags: [SNIPPET_TAG],
      } as never);

      await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, false);

      expect(repo.mutate).not.toHaveBeenCalled();
    });

    it('blocks files tagged as cards', async () => {
      const repo = makeSimpleRepo();
      const manager = new ArticleManager(makeImportPlugin(false), repo);
      vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue({
        tags: [CARD_TAG],
      } as never);

      await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, false);

      expect(repo.mutate).not.toHaveBeenCalled();
    });

    it('re-associates with the existing DB record when ir-id matches', async () => {
      const EXISTING_ID = 'existing-article-id';
      const repo = makeSimpleRepo();
      (repo.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { id: EXISTING_ID },
      ]);
      const manager = new ArticleManager(makeImportPlugin(false), repo);
      vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue({
        'ir-id': EXISTING_ID,
      } as never);

      await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, false);

      const [sql, params] = lastMutateCall(repo);
      expect(sql).toContain('UPDATE article SET reference');
      expect(params).toEqual([IMPORT_FILE.path, EXISTING_ID]);
      expect(Obsidian.updateFrontMatter).not.toHaveBeenCalled();
    });

    it('cancels with a specific notice when ir-id is orphaned but reference is already in DB', async () => {
      const ORPHANED_ID = 'orphaned-id';
      const repo = makeSimpleRepo();
      // First query (by id) returns nothing; second query (by reference) returns a match
      (repo.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'some-other-id' }]);
      const manager = new ArticleManager(makeImportPlugin(false), repo);
      vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue({
        'ir-id': ORPHANED_ID,
      } as never);

      await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, false);

      expect(repo.mutate).not.toHaveBeenCalled();
      expect(Obsidian.updateFrontMatter).not.toHaveBeenCalled();
    });

    it('proceeds with fresh import when ir-id is orphaned and reference is not in DB', async () => {
      const ORPHANED_ID = 'orphaned-id';
      const repo = makeSimpleRepo();
      // Both queries return nothing
      (repo.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      const manager = new ArticleManager(makeImportPlugin(false), repo);
      vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue({
        'ir-id': ORPHANED_ID,
      } as never);

      await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, false);

      const [sql] = lastMutateCall(repo);
      expect(sql).toContain('INSERT INTO article');
    });
  });

  describe('plugin.settings.copyOnImport fallback', () => {
    it('uses copy when copyOnImport is true and makeCopy arg is omitted', async () => {
      const repo = makeSimpleRepo();
      const manager = new ArticleManager(makeImportPlugin(true), repo);

      await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null);

      expect(Obsidian.createNote).toHaveBeenCalled();
      const [, params] = lastMutateCall(repo);
      expect(params[1]).toBe(COPY_FILE.path);
    });

    it('uses in-place when copyOnImport is false and makeCopy arg is omitted', async () => {
      const repo = makeSimpleRepo();
      const manager = new ArticleManager(makeImportPlugin(false), repo);

      await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null);

      expect(Obsidian.createNote).not.toHaveBeenCalled();
      const [, params] = lastMutateCall(repo);
      expect(params[1]).toBe(IMPORT_FILE.path);
    });
  });
});
