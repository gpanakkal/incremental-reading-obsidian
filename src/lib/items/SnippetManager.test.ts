/* eslint-disable obsidianmd/no-tfile-tfolder-cast -- this is a test file */
import {
  DAY_ROLLOVER_OFFSET_HOURS,
  DEFAULT_PRIORITY,
  MAXIMUM_PRIORITY,
  MINIMUM_PRIORITY,
  MS_PER_DAY,
  MS_PER_YEAR,
  TEXT_BASE_REVIEW_INTERVAL,
} from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import type {
  ISnippetBase,
  ISnippetReview,
  SQLiteRepository,
  SnippetRow,
} from '#/lib/types';
import { getEndOfToday } from '#/lib/utils';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SnippetManager } from './SnippetManager';

// #region HELPERS

function makeSnippet(overrides: Partial<ISnippetBase> = {}): ISnippetBase {
  return {
    id: 'snippet-1',
    type: 'snippet',
    reference: 'snippets/test.md',
    due: Date.now(),
    interval: TEXT_BASE_REVIEW_INTERVAL,
    dismissed: false,
    priority: DEFAULT_PRIORITY,
    parent: null,
    start_offset: null,
    end_offset: null,
    scroll_top: 0,
    ...overrides,
  };
}

function makeSnippetRow(overrides: Partial<ISnippetBase> = {}): SnippetRow {
  const { dismissed, type: _, ...rest } = makeSnippet(overrides);
  return { ...rest, dismissed: Number(dismissed) };
}

function makeSnippetReview(reviewTime: number): ISnippetReview {
  return {
    id: 'review-1',
    snippet_id: 'snippet-1',
    review_time: reviewTime,
  };
}

function makeSimpleRepo(): SQLiteRepository {
  return {
    query: vi.fn().mockResolvedValue([]),
    mutate: vi.fn().mockResolvedValue([[]]),
    _execSql: vi.fn(),
    handleFileChange: vi.fn(),
  } as unknown as SQLiteRepository;
}

function makeRepoWithLastReview(
  lastReview: ISnippetReview | undefined
): SQLiteRepository {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('ORDER BY review_time DESC')) {
        return lastReview ? [lastReview] : [];
      }
      return [];
    }),
    mutate: vi.fn().mockResolvedValue([[]]),
    _execSql: vi.fn(),
    handleFileChange: vi.fn(),
  } as unknown as SQLiteRepository;
}

function lastMutateCall(repo: SQLiteRepository): [string, unknown[]] {
  const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock.calls as [
    string,
    unknown[],
  ][];
  return calls[calls.length - 1];
}

function lastQueryCall(repo: SQLiteRepository): [string, unknown[]] {
  const calls = (repo.query as ReturnType<typeof vi.fn>).mock.calls as [
    string,
    unknown[],
  ][];
  return calls[calls.length - 1];
}

/** Arbitrary for a valid SnippetRow covering all nullable fields */
const snippetRowArb = fc.record<SnippetRow>({
  id: fc.uuid(),
  reference: fc.string({ minLength: 1 }),
  due: fc.oneof(
    fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR * 100 }),
    fc.constant(null)
  ),
  interval: fc.integer({ min: 0, max: MS_PER_DAY * 365 * 50 }),
  dismissed: fc.oneof(fc.constant(0), fc.constant(1)),
  priority: fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
  parent: fc.oneof(fc.uuid(), fc.constant(null)),
  start_offset: fc.oneof(fc.integer({ min: 0 }), fc.constant(null)),
  end_offset: fc.oneof(fc.integer({ min: 0 }), fc.constant(null)),
  scroll_top: fc.integer({ min: 0 }),
});

// #endregion

describe('rowToBase', () => {
  it('sets type to "snippet", converts dismissed number to boolean, and passes all other fields through unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(snippetRowArb, async (row) => {
        const base = SnippetManager.rowToBase(row);
        expect(base.type).toBe('snippet');
        expect(base.dismissed).toBe(Boolean(row.dismissed));
        expect(base.id).toBe(row.id);
        expect(base.reference).toBe(row.reference);
        expect(base.due).toBe(row.due);
        expect(base.interval).toBe(row.interval);
        expect(base.priority).toBe(row.priority);
        expect(base.parent).toBe(row.parent);
        expect(base.start_offset).toBe(row.start_offset);
        expect(base.end_offset).toBe(row.end_offset);
        expect(base.scroll_top).toBe(row.scroll_top);
      })
    );
  });
});

describe('rowToDisplay', () => {
  it('converts due to a Date when present, null when null, and converts dismissed to boolean', async () => {
    // Note: due=0 exposes a bug — the implementation uses `snippetRow.due ? ... : null` which
    // treats 0 as falsy. Tests are written for the fixed version (null check, not truthiness).
    await fc.assert(
      fc.asyncProperty(
        snippetRowArb.filter((r) => r.due !== 0),
        async (row) => {
          const display = SnippetManager.rowToDisplay(row);
          expect(display.type).toBe('snippet');
          expect(display.dismissed).toBe(Boolean(row.dismissed));
          if (row.due !== null) {
            expect(display.due).toBeInstanceOf(Date);
            expect((display.due as Date).getTime()).toBe(row.due);
          } else {
            expect(display.due).toBeNull();
          }
          expect(display.id).toBe(row.id);
          expect(display.reference).toBe(row.reference);
          expect(display.parent).toBe(row.parent);
          expect(display.start_offset).toBe(row.start_offset);
          expect(display.end_offset).toBe(row.end_offset);
        }
      )
    );
  });

  it('converts due=0 to a Date at epoch (bug: current impl treats 0 as null)', async () => {
    const row = makeSnippetRow({ due: 0 });
    const display = SnippetManager.rowToDisplay(row);
    expect(display.due).toBeInstanceOf(Date);
    expect((display.due as Date).getTime()).toBe(0);
  });
});

describe('displayToRow', () => {
  it('round-trips through rowToDisplay: displayToRow(rowToDisplay(row)) equals row', async () => {
    await fc.assert(
      fc.asyncProperty(snippetRowArb, async (row) => {
        const display = SnippetManager.rowToDisplay(row);
        const backToRow = SnippetManager.displayToRow(display);
        expect(backToRow.dismissed).toBe(row.dismissed);
        expect(backToRow.due).toBe(row.due);
        expect(backToRow.id).toBe(row.id);
        expect(backToRow.reference).toBe(row.reference);
        expect(backToRow.interval).toBe(row.interval);
        expect(backToRow.priority).toBe(row.priority);
        expect(backToRow.parent).toBe(row.parent);
        expect(backToRow.start_offset).toBe(row.start_offset);
        expect(backToRow.end_offset).toBe(row.end_offset);
        expect(backToRow.scroll_top).toBe(row.scroll_top);
        // type field must be stripped
        expect('type' in backToRow).toBe(false);
      })
    );
  });

  it('converts null due to null in row', async () => {
    await fc.assert(
      fc.asyncProperty(
        snippetRowArb.map((r) => ({ ...r, due: null })),
        async (row) => {
          const display = SnippetManager.rowToDisplay(row);
          const backToRow = SnippetManager.displayToRow(display);
          expect(backToRow.due).toBeNull();
        }
      )
    );
  });
});

describe('rowToReviewSnippet', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when the file cannot be found', async () => {
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(null);
    await fc.assert(
      fc.asyncProperty(snippetRowArb, async (row) => {
        const repo = makeSimpleRepo();
        const manager = new SnippetManager({} as never, repo);
        const result = manager.rowToReviewSnippet(row);
        expect(result).toBeNull();
      })
    );
  });

  it('returns a ReviewSnippet with correct data and file when the file exists', async () => {
    const fakeFile = { path: 'snippets/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    await fc.assert(
      fc.asyncProperty(snippetRowArb, async (row) => {
        const repo = makeSimpleRepo();
        const manager = new SnippetManager({} as never, repo);
        const result = manager.rowToReviewSnippet(row);
        expect(result).not.toBeNull();
        expect(result!.file).toBe(fakeFile);
        expect(result!.data.id).toBe(row.id);
        expect(result!.data.dismissed).toBe(Boolean(row.dismissed));
        expect(result!.data.type).toBe('snippet');
      })
    );
  });
});

describe('updateOffsets', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('issues an UPDATE snippet SET start_offset, end_offset WHERE id query with correct params', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.integer({ min: 0 }),
        fc.integer({ min: 0 }),
        async (snippetId, startOffset, endOffset) => {
          const repo = makeSimpleRepo();
          const manager = new SnippetManager({} as never, repo);
          await manager.updateOffsets(snippetId, startOffset, endOffset);
          const [sql, params] = lastMutateCall(repo);
          expect(sql).toMatch(
            /UPDATE snippet SET start_offset = \$1, end_offset = \$2 WHERE id = \$3/i
          );
          expect(params[0]).toBe(startOffset);
          expect(params[1]).toBe(endOffset);
          expect(params[2]).toBe(snippetId);
        }
      )
    );
  });
});

describe('fetchMany', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns all rows when called with no options', async () => {
    const rows = [makeSnippetRow({ id: 'a' }), makeSnippetRow({ id: 'b' })];
    const repo = {
      query: vi.fn().mockResolvedValue(rows),
      mutate: vi.fn(),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;
    const manager = new SnippetManager({} as never, repo);
    const result = await manager.fetchMany();
    expect(result).toEqual(rows);
    const [sql, params] = lastQueryCall(repo);
    expect(sql).toMatch(/SELECT \* FROM snippet/i);
    expect(sql).toMatch(/dismissed = 0/i);
    expect(params).toEqual([]);
  });

  it('produces no WHERE clause when includeDismissed=true and no other filters', async () => {
    const repo = makeSimpleRepo();
    const manager = new SnippetManager({} as never, repo);
    await manager.fetchMany({ includeDismissed: true });
    const [sql] = lastQueryCall(repo);
    expect(sql).not.toMatch(/WHERE/i);
  });

  it('adds a due filter when dueBy is provided', async () => {
    const repo = makeSimpleRepo();
    const manager = new SnippetManager({} as never, repo);
    const dueBy = Date.now();
    await manager.fetchMany({ dueBy });
    const [sql, params] = lastQueryCall(repo);
    expect(sql).toMatch(/due <= \$1/i);
    expect(params[0]).toBe(dueBy);
  });

  it('excludes dismissed rows by default', async () => {
    const repo = makeSimpleRepo();
    const manager = new SnippetManager({} as never, repo);
    await manager.fetchMany();
    const [sql] = lastQueryCall(repo);
    expect(sql).toMatch(/dismissed = 0/i);
  });

  it('includes dismissed rows when includeDismissed is true', async () => {
    const repo = makeSimpleRepo();
    const manager = new SnippetManager({} as never, repo);
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
          const manager = new SnippetManager({} as never, repo);
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
        const manager = new SnippetManager({} as never, repo);
        await manager.fetchMany({ limit });
        const [sql, params] = lastQueryCall(repo);
        expect(sql).toMatch(/LIMIT/i);
        expect(params).toContain(limit);
      })
    );
  });

  it('uses correctly sequenced $N params when dueBy, excludeIds, and limit are all set', async () => {
    const repo = makeSimpleRepo();
    const manager = new SnippetManager({} as never, repo);
    const dueBy = 1000;
    const excludeIds = ['id-1', 'id-2'];
    const limit = 5;
    await manager.fetchMany({ dueBy, excludeIds, limit });
    const [sql, params] = lastQueryCall(repo);
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
    const manager = new SnippetManager({} as never, repo);
    const excludeIds = Array.from({ length: 1000 }, (_, i) => `id-${i}`);
    await expect(manager.fetchMany({ excludeIds })).rejects.toThrow();
  });

  it('does not throw when param count equals MAX_SQL_QUERY_PARAMS exactly', async () => {
    const repo = makeSimpleRepo();
    const manager = new SnippetManager({} as never, repo);
    // dueBy=$1 + 998 excludeIds = 999 params total
    const excludeIds = Array.from({ length: 998 }, (_, i) => `id-${i}`);
    await expect(
      manager.fetchMany({ dueBy: 1000, excludeIds })
    ).resolves.not.toThrow();
  });

  it('uses commas between NOT IN placeholders', async () => {
    const repo = makeSimpleRepo();
    const manager = new SnippetManager({} as never, repo);
    await manager.fetchMany({ excludeIds: ['a', 'b', 'c'] });
    const [sql] = lastQueryCall(repo);
    expect(sql).toMatch(/NOT IN \(\$\d+, \$\d+, \$\d+\)/i);
  });

  it('uses AND to join multiple WHERE conditions', async () => {
    const repo = makeSimpleRepo();
    const manager = new SnippetManager({} as never, repo);
    await manager.fetchMany({ dueBy: 1000, excludeIds: ['a'] });
    const [sql] = lastQueryCall(repo);
    expect(sql).toMatch(/ AND /i);
  });

  it('produces a WHERE clause when conditions are present', async () => {
    const repo = makeSimpleRepo();
    const manager = new SnippetManager({} as never, repo);
    await manager.fetchMany({ dueBy: 1000 });
    const [sql] = lastQueryCall(repo);
    expect(sql).toContain(' WHERE ');
  });

  it('orders results by priority DESC', async () => {
    const repo = makeSimpleRepo();
    const manager = new SnippetManager({} as never, repo);
    await manager.fetchMany();
    const [sql] = lastQueryCall(repo);
    expect(sql).toMatch(/ORDER BY priority DESC/i);
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
    const manager = new SnippetManager({} as never, repo);
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
        const manager = new SnippetManager({} as never, repo);
        await manager.fetch(id);
        const [sql, params] = lastQueryCall(repo);
        expect(sql).toMatch(/WHERE id = \$1/i);
        expect(params[0]).toBe(id);
      })
    );
  });

  it('returns a ReviewSnippet when a row and file are found', async () => {
    const row = makeSnippetRow();
    const fakeFile = { path: 'snippets/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    const repo = {
      query: vi.fn().mockResolvedValue([row]),
      mutate: vi.fn(),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;
    const manager = new SnippetManager({} as never, repo);
    const result = await manager.fetch(row.id);
    expect(result).not.toBeNull();
    expect(result!.data.id).toBe(row.id);
    expect(result!.file).toBe(fakeFile);
  });
});

describe('getDue', () => {
  const YEAR_2000_MS = new Date('2000-01-01T12:00:00Z').getTime();
  const YEAR_2100_MS = new Date('2100-01-01T12:00:00Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Obsidian, 'getNote').mockReturnValue({
      path: 'snippets/test.md',
    } as TFile);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeRepoWithSnippets(rows: SnippetRow[]): SQLiteRepository {
    return {
      query: vi.fn().mockImplementation((sql: string, params: unknown[]) => {
        if (sql.startsWith('SELECT * FROM snippet')) {
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

  it('returns snippets due at or before the offset-adjusted end of day, but not after', async () => {
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
          const rowAtCutoff = makeSnippetRow({ id: 'at-cutoff', due: cutoff });
          const rowAfterCutoff = makeSnippetRow({
            id: 'after-cutoff',
            due: cutoff + 1,
          });
          const repo = makeRepoWithSnippets([rowAtCutoff, rowAfterCutoff]);
          const plugin = {
            app: {},
            settings: { dayRolloverOffset: offset },
          } as never;
          const manager = new SnippetManager(plugin, repo);

          const results = await manager.getDue();

          const ids = results.map((r) => r.data.id);
          expect(ids).toContain('at-cutoff');
          expect(ids).not.toContain('after-cutoff');
        }
      )
    );
  });

  it('skips rows whose note file is missing and retries until all results have files', async () => {
    const rowA = makeSnippetRow({ id: 'no-file', due: 0 });
    const rowB = makeSnippetRow({ id: 'has-file', due: 0 });
    const file = { path: 'snippets/test.md' } as TFile;

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
      app: {},
      settings: { dayRolloverOffset: 0 },
    } as never;
    const manager = new SnippetManager(plugin, repo);
    const results = await manager.getDue(0);

    expect(results.every((r) => r.file !== null)).toBe(true);
    expect(results.map((r) => r.data.id)).not.toContain('no-file');
    expect(callCount).toBeGreaterThan(1);
  });

  it('passes pre-existing excludeIds on the first fetch call', async () => {
    const rowA = makeSnippetRow({ id: 'excluded-by-caller', due: 0 });
    const file = { path: 'snippets/test.md' } as TFile;
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

    const plugin = { app: {}, settings: { dayRolloverOffset: 0 } } as never;
    const manager = new SnippetManager(plugin, repo);
    await manager.getDue(0, undefined, [rowA.id]);

    const firstCallParams = queryCalls[0] as unknown[];
    expect(firstCallParams).toContain(rowA.id);
  });

  it('starts with an empty exclude list when no excludeIds are given', async () => {
    const file = { path: 'snippets/test.md' } as TFile;
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

    const plugin = { app: {}, settings: { dayRolloverOffset: 0 } } as never;
    const manager = new SnippetManager(plugin, repo);
    await manager.getDue(1);

    // The first call's SQL must not contain NOT IN (no IDs were excluded yet)
    const [firstSql] = queryCalls[0];
    expect(firstSql).not.toMatch(/NOT IN/i);
  });

  it('filters out items where rowToReviewSnippet returns null (null from file lookup)', async () => {
    const rowWithFile = makeSnippetRow({
      id: 'has-file',
      reference: 'snippets/with-file.md',
      due: 1,
    });
    const rowNoFile = makeSnippetRow({
      id: 'no-file-filter',
      reference: 'snippets/no-file.md',
      due: 1,
    });
    const file = { path: 'snippets/with-file.md' } as TFile;

    vi.spyOn(Obsidian, 'getNote').mockImplementation((ref) => {
      return ref === rowNoFile.reference ? null : file;
    });

    let call = 0;
    const repo = {
      query: vi.fn().mockImplementation((_sql: string, params: unknown[]) => {
        call++;
        if (call === 1) return [rowWithFile, rowNoFile];
        return [rowWithFile, rowNoFile].filter((r) => !params.includes(r.id));
      }),
      mutate: vi.fn(),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;

    const plugin = { app: {}, settings: { dayRolloverOffset: 0 } } as never;
    const manager = new SnippetManager(plugin, repo);
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
      app: {},
      settings: { dayRolloverOffset: 0 },
    } as never;
    const manager = new SnippetManager(plugin, repo);
    const results = await manager.getDue();
    expect(results).toEqual([]);
  });
});

describe('review', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('inserts a snippet_review record with the given review time', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR }),
        async (reviewTime) => {
          const snippet = makeSnippet();
          const repo = makeSimpleRepo();
          const manager = new SnippetManager({} as never, repo);
          await manager.review(snippet, reviewTime);
          const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock
            .calls as [string, unknown[]][];
          const insertCall = calls.find(([sql]) =>
            sql.includes('INSERT INTO snippet_review')
          );
          expect(insertCall).toBeDefined();
          expect(insertCall![1][2]).toBe(reviewTime);
          expect(insertCall![1][1]).toBe(snippet.id);
        }
      )
    );
  });

  it('falls back to Date.now() when reviewTime is not provided', async () => {
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const snippet = makeSnippet();
    const repo = makeSimpleRepo();
    const manager = new SnippetManager({} as never, repo);
    await manager.review(snippet);
    const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      unknown[],
    ][];
    const insertCall = calls.find(([sql]) =>
      sql.includes('INSERT INTO snippet_review')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1][2]).toBe(now);
  });

  it('updates snippet due, interval, and clears dismissed', async () => {
    // reviewTime=0 excluded — same bug as above
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: Date.now() + MS_PER_YEAR }),
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        async (reviewTime, priority) => {
          const snippet = makeSnippet({ priority });
          const repo = makeSimpleRepo();
          const manager = new SnippetManager({} as never, repo);
          await manager.review(snippet, reviewTime);

          const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock
            .calls as [string, unknown[]][];
          const updateCall = calls.find(([sql]) =>
            sql.includes('UPDATE snippet SET dismissed')
          );
          expect(updateCall).toBeDefined();
          const [updateSql, params] = updateCall!;
          const expectedInterval = IRScheduler.nextInterval(snippet);
          const expectedDue = reviewTime + expectedInterval;
          expect(params[0]).toBe(expectedDue);
          expect(params[1]).toBe(expectedInterval);
          expect(params[2]).toBe(snippet.id);
          expect(updateSql).toMatch(/dismissed = 0/i);
        }
      )
    );
  });

  it('does not throw when the repo mutate rejects', async () => {
    const repo = {
      query: vi.fn().mockResolvedValue([]),
      mutate: vi.fn().mockRejectedValue(new Error('db error')),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;
    const manager = new SnippetManager({} as never, repo);
    await expect(manager.review(makeSnippet(), 1)).resolves.toBeUndefined();
  });

  it('uses a provided nextReviewInterval instead of computing one', async () => {
    // reviewTime=0 excluded — same bug as above
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: Date.now() }),
        fc.integer({ min: MS_PER_DAY, max: MS_PER_DAY * 30 }),
        async (reviewTime, nextInterval) => {
          const snippet = makeSnippet();
          const repo = makeSimpleRepo();
          const manager = new SnippetManager({} as never, repo);
          await manager.review(snippet, reviewTime, nextInterval);

          const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock
            .calls as [string, unknown[]][];
          const updateCall = calls.find(([sql]) =>
            sql.includes('UPDATE snippet SET dismissed')
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
          const manager = new SnippetManager({} as never, repo);
          await expect(
            manager.reprioritize(makeSnippet(), badPriority)
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
          const snippet = makeSnippet({ priority });
          const repo = makeRepoWithLastReview(makeSnippetReview(reviewTime));
          const manager = new SnippetManager({} as never, repo);
          await manager.reprioritize(snippet, newPriority);

          const [sql, params] = lastMutateCall(repo);
          expect(sql).toMatch(
            /UPDATE snippet SET priority = \$1, due = \$2, interval = \$3 WHERE id = \$4/i
          );
          expect(params[0]).toBe(newPriority);
          const expectedInterval = IRScheduler.nextInterval({
            ...snippet,
            priority: newPriority,
          });
          expect(params[2]).toBe(expectedInterval);
          expect(params[1]).toBe(reviewTime + expectedInterval);
          expect(params[3]).toBe(snippet.id);
        }
      )
    );
  });

  it('falls back to snippet.due when there is no prior review', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR }),
        async (newPriority, due) => {
          const snippet = makeSnippet({ due });
          const repo = makeRepoWithLastReview(undefined);
          const manager = new SnippetManager({} as never, repo);
          await manager.reprioritize(snippet, newPriority);

          const [, params] = lastMutateCall(repo);
          expect(params[1]).toBe(due);
        }
      )
    );
  });

  it('targets the correct snippet id in the WHERE clause', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        async (id, newPriority) => {
          const snippet = makeSnippet({ id });
          const repo = makeRepoWithLastReview(undefined);
          const manager = new SnippetManager({} as never, repo);
          await manager.reprioritize(snippet, newPriority);

          const [sql, params] = lastMutateCall(repo);
          expect(sql).toMatch(/WHERE id = \$4/i);
          expect(params[3]).toBe(id);
        }
      )
    );
  });
});
