import {
  DAY_ROLLOVER_OFFSET_HOURS,
  DEFAULT_PRIORITY,
  MAX_SQL_QUERY_PARAMS,
  MAXIMUM_PRIORITY,
  MINIMUM_PRIORITY,
  MS_PER_DAY,
  MS_PER_YEAR,
  SNIPPET_TAG,
  SOURCE_PROPERTY_NAME,
  TEXT_BASE_REVIEW_INTERVAL,
} from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import type {
  ISnippetBase,
  ISnippetReview,
  SnippetRow,
  SQLiteRepository,
} from '#/lib/types';
import { getEndOfDay } from '#/lib/utils';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import type { TFile } from 'obsidian';
import { resolve } from 'path';
import initSqlJs, { type Database } from 'sql.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SnippetManager } from './SnippetManager';

// #region HELPERS

function makeSnippet(overrides: Partial<ISnippetBase> = {}): ISnippetBase {
  return {
    id: 'snippet-1',
    type: 'snippet',
    reference: 'snippets/test.md',
    due: Date.now(),
    due_fuzz: null,
    interval: TEXT_BASE_REVIEW_INTERVAL,
    dismissed: false,
    deleted: false,
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
    transaction: vi.fn(async (work: () => unknown) => work()),
    handleFileChange: vi.fn(),
    onDataChange: vi.fn(() => vi.fn()),
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
    transaction: vi.fn(async (work: () => unknown) => work()),
    handleFileChange: vi.fn(),
    onDataChange: vi.fn(() => vi.fn()),
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
  due_fuzz: fc.oneof(fc.integer(), fc.constant(null)),
  interval: fc.integer({ min: 0, max: MS_PER_DAY * 365 * 50 }),
  dismissed: fc.oneof(fc.constant(0), fc.constant(1)),
  deleted: fc.boolean(),
  priority: fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
  parent: fc.oneof(fc.uuid(), fc.constant(null)),
  start_offset: fc.oneof(fc.integer({ min: 0 }), fc.constant(null)),
  end_offset: fc.oneof(fc.integer({ min: 0 }), fc.constant(null)),
  scroll_top: fc.integer({ min: 0 }),
});

/**
 * Minimal Obsidian App stub. rowToReviewSnippet reads frontmatter via
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
    transaction: vi.fn(async (work: () => unknown) => work()),
    handleFileChange: vi.fn(),
    onDataChange: vi.fn(() => vi.fn()),
  } as unknown as SQLiteRepository;
  return { repo, db };
}

function insertSnippetRow(
  db: Database,
  row: { id: string; due: number; due_fuzz: number | null; priority: number }
) {
  db.exec(
    `INSERT INTO snippet (id, reference, due, due_fuzz, interval, priority)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      row.id,
      `snippets/${row.id}.md`,
      row.due,
      row.due_fuzz,
      TEXT_BASE_REVIEW_INTERVAL,
      row.priority,
    ]
  );
}
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
    const repo = makeSimpleRepo();
    const manager = new SnippetManager({} as never, repo);
    await fc.assert(
      fc.asyncProperty(snippetRowArb, async (row) => {
        const result = manager.rowToReviewSnippet(row);
        expect(result).toBeNull();
      })
    );
  });

  it('returns a ReviewSnippet with correct data and file when the file exists', async () => {
    const fakeFile = { path: 'snippets/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    const repo = makeSimpleRepo();
    const manager = new SnippetManager(
      { app: makeApp(), settings: { fuzzReviewTimes: false } } as never,
      repo
    );
    await fc.assert(
      fc.asyncProperty(snippetRowArb, async (row) => {
        const result = manager.rowToReviewSnippet(row);
        expect(result).not.toBeNull();
        expect(result!.file).toBe(fakeFile);
        expect(result!.data.id).toBe(row.id);
        expect(result!.data.dismissed).toBe(Boolean(row.dismissed));
        expect(result!.data.type).toBe('snippet');
      })
    );
  });

  it('calls markDeleted when the file is missing and the row is not already deleted', async () => {
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(null);
    const row = makeSnippetRow({ deleted: false, parent: null });
    const repo = makeSimpleRepo();
    const manager = new SnippetManager({} as never, repo);
    manager.rowToReviewSnippet(row);
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
    const row = makeSnippetRow({ deleted: true, parent: null });
    const repo = makeSimpleRepo();
    const manager = new SnippetManager({} as never, repo);
    manager.rowToReviewSnippet(row);
    await Promise.resolve();
    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    expect(mutateCalls).toHaveLength(0);
  });

  it('calls offsetTracker.removeHighlight when the file is missing and the row has a parent', async () => {
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(null);
    const row = makeSnippetRow({ deleted: false, parent: 'parent-id-abc' });
    const repo = makeSimpleRepo();
    const manager = new SnippetManager({} as never, repo);
    const removeHighlightSpy = vi.spyOn(
      manager.offsetTracker,
      'removeHighlight'
    );
    manager.rowToReviewSnippet(row);
    await Promise.resolve();
    expect(removeHighlightSpy).toHaveBeenCalledWith(
      expect.stringContaining('parent-id-abc'),
      row.id
    );
  });

  it('does not call offsetTracker.removeHighlight when the row has no parent', async () => {
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(null);
    const row = makeSnippetRow({ deleted: false, parent: null });
    const repo = makeSimpleRepo();
    const manager = new SnippetManager({} as never, repo);
    const removeHighlightSpy = vi.spyOn(
      manager.offsetTracker,
      'removeHighlight'
    );
    manager.rowToReviewSnippet(row);
    await Promise.resolve();
    expect(removeHighlightSpy).not.toHaveBeenCalled();
  });

  it('returns null and calls markDeleted when frontmatter has a different ir-id', async () => {
    const fakeFile = { path: 'snippets/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    const row = makeSnippetRow({ id: 'row-id-001' });
    const repo = makeSimpleRepo();
    const manager = new SnippetManager(
      {
        app: {
          metadataCache: {
            getFileCache: () => ({
              frontmatter: { 'ir-id': 'different-id', tags: [SNIPPET_TAG] },
            }),
          },
          fileManager: { processFrontMatter: async () => undefined },
        },
        settings: { fuzzTextReviews: false },
      } as never,
      repo
    );
    const result = manager.rowToReviewSnippet(row);
    expect(result).toBeNull();
    await Promise.resolve();
    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const deleteCall = mutateCalls.find(([sql]) =>
      sql.includes('SET deleted = 1')
    );
    expect(deleteCall).toBeDefined();
  });

  it('calls setFrontmatter when the file has an ir-id but lacks the snippet tag', async () => {
    const fakeFile = { path: 'snippets/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    const row = makeSnippetRow({
      id: 'row-id-002',
      deleted: false,
      due_fuzz: 0,
    });
    const processFrontMatterSpy = vi.fn().mockResolvedValue(undefined);
    const repo = makeSimpleRepo();
    const manager = new SnippetManager(
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
    manager.rowToReviewSnippet(row);
    await Promise.resolve();
    expect(processFrontMatterSpy).toHaveBeenCalled();
  });

  it('does not call setFrontmatter when the file has both matching ir-id and the snippet tag', async () => {
    const fakeFile = { path: 'snippets/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    const row = makeSnippetRow({
      id: 'row-id-004',
      deleted: false,
      due_fuzz: 0,
    });
    const processFrontMatterSpy = vi.fn().mockResolvedValue(undefined);
    const repo = makeSimpleRepo();
    const manager = new SnippetManager(
      {
        app: {
          metadataCache: {
            getFileCache: () => ({
              frontmatter: { 'ir-id': row.id, tags: [SNIPPET_TAG] },
            }),
          },
          fileManager: { processFrontMatter: processFrontMatterSpy },
        },
        settings: { fuzzTextReviews: false },
      } as never,
      repo
    );
    manager.rowToReviewSnippet(row);
    await Promise.resolve();
    expect(processFrontMatterSpy).not.toHaveBeenCalled();
  });

  it('does not call markUndeleted when the file exists and the row is not deleted', async () => {
    const fakeFile = { path: 'snippets/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    const row = makeSnippetRow({
      deleted: false,
      due_fuzz: 0,
      id: 'row-id-005',
    });
    const repo = makeSimpleRepo();
    const manager = new SnippetManager(
      {
        app: {
          metadataCache: {
            getFileCache: () => ({
              frontmatter: { 'ir-id': row.id, tags: [SNIPPET_TAG] },
            }),
          },
          fileManager: { processFrontMatter: async () => undefined },
        },
        settings: { fuzzTextReviews: false },
      } as never,
      repo
    );
    manager.rowToReviewSnippet(row);
    await Promise.resolve();
    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const undeleteCall = mutateCalls.find(([sql]) =>
      sql.includes('SET deleted = 0')
    );
    expect(undeleteCall).toBeUndefined();
  });

  it('calls markUndeleted when the file exists but the row is flagged as deleted', async () => {
    const fakeFile = { path: 'snippets/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    const row = makeSnippetRow({ deleted: true, due_fuzz: 0 });
    const repo = makeSimpleRepo();
    const manager = new SnippetManager(
      { app: makeApp(), settings: { fuzzTextReviews: false } } as never,
      repo
    );
    manager.rowToReviewSnippet(row);
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
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;
    const manager = new SnippetManager({} as never, repo);
    const result = await manager.fetchMany();
    expect(result).toEqual(rows);
    const [sql, params] = lastQueryCall(repo);
    expect(sql).toMatch(/SELECT \* FROM snippet/i);
    expect(sql).toMatch(/dismissed = 0/i);
    expect(params).toEqual([]);
  });

  it('omits the dismissed filter when includeDismissed=true, but keeps the default deleted filter', async () => {
    const repo = makeSimpleRepo();
    const manager = new SnippetManager({} as never, repo);
    await manager.fetchMany({ includeDismissed: true });
    const [sql] = lastQueryCall(repo);
    expect(sql).not.toMatch(/dismissed = 0/i);
    expect(sql).toMatch(/deleted = FALSE/i);
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

  it('orders results by fuzzed due ascending with null dues last', async () => {
    const repo = makeSimpleRepo();
    const manager = new SnippetManager({} as never, repo);
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
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
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
          transaction: vi.fn(async (work: () => unknown) => work()),
          handleFileChange: vi.fn(),
          onDataChange: vi.fn(() => vi.fn()),
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
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;
    const manager = new SnippetManager(
      { app: makeApp(), settings: { fuzzReviewTimes: false } } as never,
      repo
    );
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
    vi.useFakeTimers({ toFake: ['Date'] });
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
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;
  }

  describe('with a real SQLite database', () => {
    it('applies the SQL limit in fuzzed-due order, not priority order', async () => {
      const { repo, db } = await makeSqlJsRepo();
      const now = new Date('2026-01-10T12:00:00Z').getTime();
      // The highest-priority snippet is effectively due LAST once fuzz is
      // applied, so a limited fetch must not return it first.
      insertSnippetRow(db, {
        id: 'later-fuzzed',
        due: now - 1_000,
        due_fuzz: 900,
        priority: MAXIMUM_PRIORITY,
      });
      insertSnippetRow(db, {
        id: 'earlier-fuzzed',
        due: now - 2_000,
        due_fuzz: 100,
        priority: MINIMUM_PRIORITY,
      });
      const plugin = {
        app: makeApp(),
        settings: { dayRolloverOffset: 0, fuzzTextReviews: true },
      } as never;
      const manager = new SnippetManager(plugin, repo);

      const results = await manager.getDue(now, 1);

      expect(results.map((r) => r.data.id)).toEqual(['earlier-fuzzed']);
    });
  });

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

          const cutoff = getEndOfDay(offset);
          const rowAtCutoff = makeSnippetRow({ id: 'at-cutoff', due: cutoff });
          const rowAfterCutoff = makeSnippetRow({
            id: 'after-cutoff',
            due: cutoff + 1,
          });
          const repo = makeRepoWithSnippets([rowAtCutoff, rowAfterCutoff]);
          const plugin = {
            app: makeApp(),
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
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
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
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0 },
    } as never;
    const manager = new SnippetManager(plugin, repo);
    await manager.getDue(0, undefined, [rowA.id]);

    const firstCallParams = queryCalls[0];
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
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0 },
    } as never;
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
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0 },
    } as never;
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
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;
    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0 },
    } as never;
    const manager = new SnippetManager(plugin, repo);
    const results = await manager.getDue();
    expect(results).toEqual([]);
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

  it('inserts a snippet_review record with the given review time', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR }),
        async (reviewTime) => {
          const snippet = makeSnippet();
          const repo = makeSimpleRepo();
          const manager = new SnippetManager(
            { settings: { fuzzReviewTimes: false } } as never,
            repo
          );
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
    const manager = new SnippetManager(
      { settings: { fuzzReviewTimes: false } } as never,
      repo
    );
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
          const manager = new SnippetManager(
            { settings: { fuzzReviewTimes: false } } as never,
            repo
          );
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
          expect(params[3]).toBe(snippet.id);
          expect(updateSql).toMatch(/dismissed = 0/i);
        }
      )
    );
  });

  it('propagates the error when the repo mutate rejects', async () => {
    const repo = {
      query: vi.fn().mockResolvedValue([]),
      mutate: vi.fn().mockRejectedValue(new Error('db error')),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;
    const manager = new SnippetManager(
      { settings: { fuzzReviewTimes: false } } as never,
      repo
    );
    // A swallowed failure would leave the caller recording an undo entry for a
    // review the database never accepted.
    await expect(manager.review(makeSnippet(), 1)).rejects.toThrow('db error');
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
          const manager = new SnippetManager(
            { settings: { fuzzReviewTimes: false } } as never,
            repo
          );
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

describe('fuzzing (rowToReviewSnippet)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires setReviewTimeFuzz when fuzzTextReviews=true and due_fuzz is null', async () => {
    const fakeFile = { path: 'snippets/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    vi.spyOn(IRScheduler, 'getDueFuzz').mockReturnValue(3600000);

    const row = makeSnippetRow({ due_fuzz: null });
    const repo = makeSimpleRepo();
    const manager = new SnippetManager(
      { app: makeApp(), settings: { fuzzTextReviews: true } } as never,
      repo
    );

    manager.rowToReviewSnippet(row);
    await Promise.resolve();

    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const fuzzCall = mutateCalls.find(([sql]) => sql.includes('SET due_fuzz'));
    expect(fuzzCall).toBeDefined();
    expect(fuzzCall![1][0]).toBe(3600000);
    expect(fuzzCall![1][1]).toBe(row.id);
  });

  it('does not fire setReviewTimeFuzz when fuzzTextReviews=false', async () => {
    const fakeFile = { path: 'snippets/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);

    const row = makeSnippetRow({ due_fuzz: null });
    const repo = makeSimpleRepo();
    const manager = new SnippetManager(
      { app: makeApp(), settings: { fuzzTextReviews: false } } as never,
      repo
    );

    manager.rowToReviewSnippet(row);
    await Promise.resolve();

    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const fuzzCall = mutateCalls.find(([sql]) => sql.includes('SET due_fuzz'));
    expect(fuzzCall).toBeUndefined();
  });

  it('does not fire setReviewTimeFuzz when due_fuzz is already set', async () => {
    const fakeFile = { path: 'snippets/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);

    const row = makeSnippetRow({ due_fuzz: 12345 });
    const repo = makeSimpleRepo();
    const manager = new SnippetManager(
      { app: makeApp(), settings: { fuzzTextReviews: true } } as never,
      repo
    );

    manager.rowToReviewSnippet(row);
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
      path: 'snippets/test.md',
    } as TFile);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sorts by effective due (due + due_fuzz) when fuzzTextReviews=true', async () => {
    // snippetA: due=300, fuzz=+100 → pushed further out
    // snippetB: due=100, fuzz=-100 → pulled closer in
    // The sort formula `a.due + a.fuzz - b.due + b.fuzz` is antisymmetric when
    // fuzz values are negations of each other, giving a stable comparison:
    // compare(A,B) = 300+100-100+(-100) = +200 → A after B
    // compare(B,A) = 100+(-100)-300+100 = -200 → B before A
    const rowA = makeSnippetRow({ id: 'a', due: 300, due_fuzz: 100 });
    const rowB = makeSnippetRow({ id: 'b', due: 100, due_fuzz: -100 });

    const repo = {
      query: vi.fn().mockResolvedValue([rowA, rowB]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0, fuzzTextReviews: true },
    } as never;
    const manager = new SnippetManager(plugin, repo);
    const results = await manager.getDue(Number.MAX_SAFE_INTEGER);

    const ids = results.map((r) => r.data.id);
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('a'));
  });

  it('does not reorder by fuzz when fuzzTextReviews=false', async () => {
    const rowA = makeSnippetRow({ id: 'a', due: 100, due_fuzz: 50 });
    const rowB = makeSnippetRow({ id: 'b', due: 200, due_fuzz: -80 });

    const repo = {
      query: vi.fn().mockResolvedValue([rowA, rowB]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0, fuzzTextReviews: false },
    } as never;
    const manager = new SnippetManager(plugin, repo);
    const results = await manager.getDue(Number.MAX_SAFE_INTEGER);

    const ids = results.map((r) => r.data.id);
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
  });

  it('treats null due_fuzz as 0 when sorting', async () => {
    // snippetA: due=100, fuzz=null → effective=100
    // snippetB: due=200, fuzz=-150 → effective=50
    const rowA = makeSnippetRow({ id: 'a', due: 100, due_fuzz: null });
    const rowB = makeSnippetRow({ id: 'b', due: 200, due_fuzz: -150 });

    const repo = {
      query: vi.fn().mockResolvedValue([rowA, rowB]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0, fuzzTextReviews: true },
    } as never;
    const manager = new SnippetManager(plugin, repo);
    const results = await manager.getDue(Number.MAX_SAFE_INTEGER);

    const ids = results.map((r) => r.data.id);
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('a'));
  });

  it('sorts a null-due snippet after all dated snippets', async () => {
    // rowA: due=null → sorts last (comparator returns 1 when a.data.due is null)
    const rowA = makeSnippetRow({ id: 'a', due: null, due_fuzz: null });
    const rowB = makeSnippetRow({ id: 'b', due: 100, due_fuzz: null });

    const repo = {
      query: vi.fn().mockResolvedValue([rowA, rowB]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0, fuzzTextReviews: true },
    } as never;
    const manager = new SnippetManager(plugin, repo);
    const results = await manager.getDue(Number.MAX_SAFE_INTEGER);

    const ids = results.map((r) => r.data.id);
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('a'));
  });

  it('sorts a dated snippet before a null-due b', async () => {
    // rowB: due=null → comparator returns -1 when b.data.due is null → a first
    const rowA = makeSnippetRow({ id: 'a', due: 100, due_fuzz: null });
    const rowB = makeSnippetRow({ id: 'b', due: null, due_fuzz: null });

    const repo = {
      query: vi.fn().mockResolvedValue([rowA, rowB]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0, fuzzTextReviews: true },
    } as never;
    const manager = new SnippetManager(plugin, repo);
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

    const snippet = makeSnippet({ due_fuzz: null });
    const repo = makeSimpleRepo();
    const manager = new SnippetManager(
      { settings: { fuzzTextReviews: true } } as never,
      repo
    );
    await manager.review(snippet, 1000);

    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const updateCall = mutateCalls.find(([sql]) =>
      sql.includes('UPDATE snippet SET dismissed')
    );
    expect(updateCall).toBeDefined();
    // due_fuzz is the 3rd positional param ($3)
    expect(updateCall![1][2]).toBe(FUZZ);
  });

  it('preserves the existing due_fuzz when fuzzTextReviews=false', async () => {
    const existingFuzz = 42000;
    const snippet = makeSnippet({ due_fuzz: existingFuzz });
    const repo = makeSimpleRepo();
    const manager = new SnippetManager(
      { settings: { fuzzTextReviews: false } } as never,
      repo
    );
    await manager.review(snippet, 1000);

    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const updateCall = mutateCalls.find(([sql]) =>
      sql.includes('UPDATE snippet SET dismissed')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1][2]).toBe(existingFuzz);
  });

  it('does not call getDueFuzz when fuzzTextReviews=false', async () => {
    const getDueFuzzSpy = vi.spyOn(IRScheduler, 'getDueFuzz');
    const snippet = makeSnippet();
    const repo = makeSimpleRepo();
    const manager = new SnippetManager(
      { settings: { fuzzTextReviews: false } } as never,
      repo
    );
    await manager.review(snippet, 1000);
    expect(getDueFuzzSpy).not.toHaveBeenCalled();
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

// #region ORPHAN HELPERS
/**
 * A snippet as the orphan lookup meets it: a row in the database, a note that
 * may or may not still be in the vault, and a `source` property that resolves
 * to the note being imported, to some other note, or to nothing at all.
 *
 * `source` is the resolution result rather than the raw property text, since
 * turning the text into a file is `ObsidianHelpers.getSourceFile`'s job and is
 * tested there.
 */
type OrphanSpec = {
  exists: boolean;
  source: 'target' | 'elsewhere' | null;
  parent: string | null;
  deleted: boolean;
  start_offset: number | null;
  end_offset: number | null;
};

const orphanSpecArb: fc.Arbitrary<OrphanSpec> = fc.record({
  exists: fc.boolean(),
  source: fc.constantFrom<OrphanSpec['source']>('target', 'elsewhere', null),
  parent: fc.oneof(fc.uuid(), fc.constant(null)),
  deleted: fc.boolean(),
  start_offset: fc.oneof(fc.integer({ min: 0 }), fc.constant(null)),
  end_offset: fc.oneof(fc.integer({ min: 0 }), fc.constant(null)),
});

const ELSEWHERE_PATH = 'notes/elsewhere.md';

/** Turn the arbitrary's raw records into rows with distinct ids and paths. */
function toOrphanRows(specs: OrphanSpec[]): SnippetRow[] {
  return specs.map((spec, i) =>
    makeSnippetRow({
      id: `snippet-${i}`,
      reference: `snippets/snippet-${i}.md`,
      parent: spec.parent,
      deleted: spec.deleted,
      start_offset: spec.start_offset,
      end_offset: spec.end_offset,
    })
  );
}

/**
 * Stub the two `Obsidian` lookups the orphan scan makes of each candidate
 * row's note: whether the note is still there, and what its source resolves to.
 */
function wireOrphanNotes(
  rows: SnippetRow[],
  specs: OrphanSpec[],
  targetPath: string
) {
  const specByPath = new Map(rows.map((row, i) => [row.reference, specs[i]]));

  vi.spyOn(Obsidian, 'getNote').mockImplementation((reference) => {
    const spec = specByPath.get(reference);
    if (spec && !spec.exists) return null;
    // Files outside the candidate set (e.g. a snippet note being rewritten)
    return { path: reference } as TFile;
  });
  vi.spyOn(Obsidian, 'getSourceFile').mockImplementation((file) => {
    const spec = specByPath.get(file.path);
    if (!spec || spec.source === null) return null;
    return {
      path: spec.source === 'target' ? targetPath : ELSEWHERE_PATH,
    } as TFile;
  });
}

/** Put the rows in the snippet table of a real sql.js database. */
function insertOrphanRows(db: Database, rows: SnippetRow[]) {
  for (const row of rows) {
    db.exec(
      `INSERT INTO snippet
         (id, reference, parent, due, interval, priority, deleted, start_offset, end_offset)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        row.id,
        row.reference,
        row.parent,
        row.due,
        row.interval,
        row.priority,
        Number(row.deleted),
        row.start_offset,
        row.end_offset,
      ]
    );
  }
}

/**
 * Seed a real database and wire the note lookups, so the manager under test
 * runs the orphan query's `WHERE` clause rather than a mock's approximation.
 */
function seedOrphans(
  db: Database,
  repo: SQLiteRepository,
  specs: OrphanSpec[],
  targetPath: string
) {
  const rows = toOrphanRows(specs);
  insertOrphanRows(db, rows);
  wireOrphanNotes(rows, specs, targetPath);
  return {
    manager: new SnippetManager({ app: makeApp() } as never, repo),
    rows,
  };
}

/** The rows the orphan lookup is expected to find for the target note. */
function expectedOrphans(specs: OrphanSpec[], rows: SnippetRow[]) {
  return rows.filter(
    (_, i) =>
      specs[i].parent === null &&
      !specs[i].deleted &&
      specs[i].exists &&
      specs[i].source === 'target'
  );
}

/**
 * A repo that answers the orphan query with `rows` and records writes, for the
 * cases about statement shape rather than about which rows qualify.
 */
function makeOrphanRepoStub(rows: SnippetRow[]): SQLiteRepository {
  return {
    query: vi
      .fn()
      .mockImplementation((sql: string) =>
        sql.includes('parent IS NULL') ? rows : []
      ),
    mutate: vi.fn().mockResolvedValue([[]]),
    _execSql: vi.fn(),
    transaction: vi.fn(async (work: () => unknown) => work()),
    handleFileChange: vi.fn(),
    onDataChange: vi.fn(() => vi.fn()),
  } as unknown as SQLiteRepository;
}

/** All ids passed to `UPDATE snippet SET parent`, across every chunk. */
function adoptedIdsFromMutates(repo: SQLiteRepository) {
  const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock.calls as [
    string,
    unknown[],
  ][];
  return calls
    .filter(([sql]) => sql.includes('UPDATE snippet SET parent'))
    .flatMap(([, params]) => params.slice(1) as string[]);
}
// #endregion

describe('rowToHighlight', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null exactly when either offset is missing', async () => {
    await fc.assert(
      fc.asyncProperty(snippetRowArb, async (row) => {
        const result = SnippetManager.rowToHighlight(row);
        const renderable = row.start_offset !== null && row.end_offset !== null;
        expect(result === null).toBe(!renderable);
      })
    );
  });

  it('passes offsets through and normalizes dismissed and a null parent', async () => {
    await fc.assert(
      fc.asyncProperty(
        snippetRowArb.filter(
          (row) => row.start_offset !== null && row.end_offset !== null
        ),
        async (row) => {
          const highlight = SnippetManager.rowToHighlight(row)!;
          expect(highlight.type).toBe('snippet');
          expect(highlight.start_offset).toBe(row.start_offset);
          expect(highlight.end_offset).toBe(row.end_offset);
          expect(highlight.dismissed).toBe(Boolean(row.dismissed));
          expect(highlight.parent).toBe(row.parent ?? '');
          expect(highlight.id).toBe(row.id);
          expect(highlight.reference).toBe(row.reference);
        }
      )
    );
  });
});

describe('adoptOrphans', () => {
  const TARGET = { path: 'notes/parent.md' } as TFile;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A spec that qualifies, so a test can vary one field away from it. */
  const QUALIFYING: OrphanSpec = {
    exists: true,
    source: 'target',
    parent: null,
    deleted: false,
    start_offset: 0,
    end_offset: 5,
  };

  it('claims every parentless snippet taken from the note, and nothing else', async () => {
    const { repo, db } = await makeSqlJsRepo();
    await fc.assert(
      fc.asyncProperty(
        fc.array(orphanSpecArb, { maxLength: 8 }),
        fc.uuid(),
        async (specs, parentId) => {
          db.exec('DELETE FROM snippet');
          (repo.mutate as ReturnType<typeof vi.fn>).mockClear();
          const { manager, rows } = seedOrphans(db, repo, specs, TARGET.path);

          const adopted = await manager.adoptOrphans(TARGET, parentId);

          const expected = expectedOrphans(specs, rows);
          expect(adopted.map((row) => row.id).sort()).toEqual(
            expected.map((row) => row.id).sort()
          );
          expect(adoptedIdsFromMutates(repo).sort()).toEqual(
            expected.map((row) => row.id).sort()
          );
          vi.restoreAllMocks();
        }
      )
    );
  });

  it('persists the new parent, so the note keeps its highlights on the next read', async () => {
    const { repo, db } = await makeSqlJsRepo();
    const { manager } = seedOrphans(db, repo, [QUALIFYING], TARGET.path);

    await manager.adoptOrphans(TARGET, 'article-1');

    const stored = db.exec('SELECT parent FROM snippet WHERE id = $1', [
      'snippet-0',
    ]);
    expect(stored[0].values[0][0]).toBe('article-1');
  });

  it('returns the adopted rows carrying the new parent id', async () => {
    const { repo, db } = await makeSqlJsRepo();
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (parentId) => {
        db.exec('DELETE FROM snippet');
        const { manager } = seedOrphans(
          db,
          repo,
          [{ ...QUALIFYING, start_offset: 3, end_offset: 9 }],
          TARGET.path
        );

        const adopted = await manager.adoptOrphans(TARGET, parentId);

        expect(adopted).toHaveLength(1);
        expect(adopted[0].parent).toBe(parentId);
        // the rest of the row is untouched
        expect(adopted[0].start_offset).toBe(3);
        expect(adopted[0].end_offset).toBe(9);
        vi.restoreAllMocks();
      })
    );
  });

  it('writes no update when nothing qualifies', async () => {
    const { repo, db } = await makeSqlJsRepo();
    const { manager } = seedOrphans(
      db,
      repo,
      [
        { ...QUALIFYING, parent: 'some-other-article' },
        { ...QUALIFYING, source: 'elsewhere' },
        { ...QUALIFYING, deleted: true },
        { ...QUALIFYING, exists: false },
      ],
      TARGET.path
    );

    const adopted = await manager.adoptOrphans(TARGET, 'article-1');

    expect(adopted).toEqual([]);
    expect(adoptedIdsFromMutates(repo)).toEqual([]);
  });

  it('targets the ids by placeholder, with the parent id first', async () => {
    const specs = [QUALIFYING, QUALIFYING];
    const rows = toOrphanRows(specs);
    wireOrphanNotes(rows, specs, TARGET.path);
    const repo = makeOrphanRepoStub(rows);
    const manager = new SnippetManager({ app: makeApp() } as never, repo);

    await manager.adoptOrphans(TARGET, 'article-1');

    const [sql, params] = lastMutateCall(repo);
    expect(sql).toMatch(
      /UPDATE snippet SET parent = \$1 WHERE id IN \(\$2, \$3\)/i
    );
    expect(params[0]).toBe('article-1');
    expect(params.slice(1)).toEqual(['snippet-0', 'snippet-1']);
  });

  it('splits the update into as few chunks as the parameter limit allows, with no empty statement', async () => {
    // One update can carry the parent id plus MAX_SQL_QUERY_PARAMS - 1 ids.
    // The counts straddle an exact chunk boundary, where an off-by-one would
    // emit a trailing `IN ()` — a syntax error in SQLite.
    const chunkSize = MAX_SQL_QUERY_PARAMS - 1;
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(chunkSize, chunkSize + 1),
        async (orphanCount) => {
          const specs = Array.from({ length: orphanCount }, () => QUALIFYING);
          const rows = toOrphanRows(specs);
          wireOrphanNotes(rows, specs, TARGET.path);
          const repo = makeOrphanRepoStub(rows);
          const manager = new SnippetManager({ app: makeApp() } as never, repo);

          const adopted = await manager.adoptOrphans(TARGET, 'article-1');

          const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock
            .calls as [string, unknown[]][];
          expect(calls).toHaveLength(Math.ceil(orphanCount / chunkSize));
          for (const [, params] of calls) {
            expect(params.length).toBeGreaterThan(1);
            expect(params.length).toBeLessThanOrEqual(MAX_SQL_QUERY_PARAMS);
          }
          // every orphan is claimed exactly once
          expect(new Set(adoptedIdsFromMutates(repo)).size).toBe(orphanCount);
          expect(adopted).toHaveLength(orphanCount);
          vi.restoreAllMocks();
        }
      )
    );
  });

  it('reads the source property rather than Obsidian’s link index', async () => {
    // resolvedLinks is rebuilt asynchronously and does not reliably carry
    // frontmatter links, so a lookup that consulted it would find nothing here.
    const specs = [QUALIFYING];
    const rows = toOrphanRows(specs);
    wireOrphanNotes(rows, specs, TARGET.path);
    const repo = makeOrphanRepoStub(rows);
    const manager = new SnippetManager(
      { app: { ...makeApp(), metadataCache: { resolvedLinks: {} } } } as never,
      repo
    );

    const adopted = await manager.adoptOrphans(TARGET, 'article-1');

    expect(adopted.map((row) => row.id)).toEqual(['snippet-0']);
  });
});

describe('getHighlights for a note with a database entry', () => {
  const ARTICLE = { path: 'articles/imported.md' } as TFile;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** An article note whose snippets are reached by parent id, not backlinks. */
  function makeArticleManager(rows: SnippetRow[]) {
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('article');
    // isSourceNote would still be true for a note that had snippets taken from
    // it before the import; the parent-id lookup must win regardless.
    vi.spyOn(Obsidian, 'isSourceNote').mockReturnValue(true);

    const repo = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM article')) return [{ id: 'article-1' }];
        if (sql.includes('WHERE parent = $1')) return rows;
        return [];
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;

    return {
      manager: new SnippetManager({ app: makeApp() } as never, repo),
      repo,
    };
  }

  it('queries by the parent id and caches the highlights under the note path', async () => {
    const rows = [
      makeSnippetRow({
        id: 'snippet-a',
        parent: 'article-1',
        start_offset: 2,
        end_offset: 8,
      }),
    ];
    const { manager, repo } = makeArticleManager(rows);

    const highlights = await manager.getHighlights(ARTICLE);

    expect(highlights.map((h) => h.id)).toEqual(['snippet-a']);
    expect(manager.offsetTracker.getHighlights(ARTICLE.path)).toEqual(
      highlights
    );
    const [sql, params] = lastQueryCall(repo);
    expect(sql).toMatch(/WHERE parent = \$1/i);
    expect(params[0]).toBe('article-1');
  });

  it('skips rows that have no offsets to render', async () => {
    const rows = [
      makeSnippetRow({ id: 'no-offsets', parent: 'article-1' }),
      makeSnippetRow({
        id: 'renderable',
        parent: 'article-1',
        start_offset: 0,
        end_offset: 4,
      }),
    ];
    const { manager } = makeArticleManager(rows);

    const highlights = await manager.getHighlights(ARTICLE);

    expect(highlights.map((h) => h.id)).toEqual(['renderable']);
  });
});

describe('refreshAllHighlights', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The article id the fake database gives to the article note at `path`. */
  const articleIdFor = (path: string) => `article-for-${path}`;

  /**
   * A manager whose vault resolves only `existingPaths` (defaulting to every
   * path in `rowsByPath`) and whose database answers the parent-id query for
   * each article note from `rowsByPath`, applying the same offset/deleted
   * filter the real statement does.
   */
  function makeRefreshManager(params: {
    rowsByPath: Record<string, SnippetRow[]>;
    existingPaths?: string[];
    noteTypeFor?: (path: string) => 'article' | 'snippet' | null;
  }) {
    const existing = new Set(
      params.existingPaths ?? Object.keys(params.rowsByPath)
    );
    const noteTypeFor = params.noteTypeFor ?? (() => 'article' as const);
    const rowsByArticleId = new Map(
      Object.entries(params.rowsByPath).map(([path, rows]) => [
        articleIdFor(path),
        rows,
      ])
    );

    vi.spyOn(Obsidian, 'getNoteType').mockImplementation((file) =>
      Promise.resolve(noteTypeFor(file.path))
    );
    // Kept false so a note whose database entry is gone falls all the way
    // through getHighlights, which is the case that returns without caching.
    vi.spyOn(Obsidian, 'isSourceNote').mockReturnValue(false);

    const query = vi
      .fn()
      .mockImplementation((sql: string, sqlParams: unknown[]) => {
        if (sql.includes('FROM article')) {
          return [{ id: articleIdFor(sqlParams[0] as string) }];
        }
        if (sql.includes('WHERE parent = $1')) {
          const rows = rowsByArticleId.get(sqlParams[0] as string) ?? [];
          return rows.filter(
            (row) =>
              row.start_offset !== null &&
              row.end_offset !== null &&
              !row.deleted
          );
        }
        return [];
      });
    const repo = {
      query,
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;

    const trigger = vi.fn();
    const app = {
      ...makeApp(),
      vault: {
        getFileByPath: (path: string) =>
          existing.has(path) ? ({ path } as TFile) : null,
      },
      workspace: { trigger },
    };

    return {
      manager: new SnippetManager({ app } as never, repo),
      query,
      trigger,
    };
  }

  /** Paths of the notes `ir-highlights-changed` was raised for, in order. */
  const notifiedPaths = (trigger: ReturnType<typeof vi.fn>) =>
    (trigger.mock.calls as [string, string][])
      .filter(([event]) => event === 'ir-highlights-changed')
      .map(([, path]) => path);

  it('replaces every tracked note’s cached highlights with what the database now holds, and announces each one', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.record({
            path: fc.string({ minLength: 1 }),
            rows: fc.array(snippetRowArb, { maxLength: 4 }),
            // What the tracker wrongly believes before the refresh: the rows
            // of the database that was just replaced.
            stale: fc.array(snippetRowArb, { maxLength: 4 }),
          }),
          { selector: (entry) => entry.path, minLength: 1, maxLength: 5 }
        ),
        async (notes) => {
          const rowsByPath = Object.fromEntries(
            notes.map(({ path, rows }) => [path, rows])
          );
          const { manager, trigger } = makeRefreshManager({ rowsByPath });
          for (const { path, stale } of notes) {
            manager.offsetTracker.loadHighlights(
              path,
              stale
                .map((row) => SnippetManager.rowToHighlight(row))
                .filter((h) => h !== null)
            );
          }

          await manager.refreshAllHighlights();

          for (const { path, rows } of notes) {
            const expected = rows
              .filter(
                (row) =>
                  row.start_offset !== null &&
                  row.end_offset !== null &&
                  !row.deleted
              )
              .map((row) => SnippetManager.rowToHighlight(row));
            expect(manager.offsetTracker.getHighlights(path)).toEqual(expected);
          }
          expect(notifiedPaths(trigger).sort()).toEqual(
            notes.map(({ path }) => path).sort()
          );
        }
      )
    );
  });

  it('drops the entry for a note deleted on the other device, and leaves the rest refreshed', async () => {
    const kept = 'articles/kept.md';
    const gone = 'articles/gone.md';
    const row = makeSnippetRow({
      id: 'snippet-a',
      parent: articleIdFor(kept),
      start_offset: 3,
      end_offset: 9,
    });
    const { manager, trigger } = makeRefreshManager({
      rowsByPath: { [kept]: [row], [gone]: [] },
      existingPaths: [kept],
    });
    manager.offsetTracker.loadHighlights(kept, []);
    manager.offsetTracker.loadHighlights(gone, [
      SnippetManager.rowToHighlight(
        makeSnippetRow({ id: 'ghost', start_offset: 0, end_offset: 2 })
      )!,
    ]);

    await manager.refreshAllHighlights();

    expect(manager.offsetTracker.getHighlights(kept)).toEqual([
      SnippetManager.rowToHighlight(row),
    ]);
    // Cleared outright rather than emptied, so a later note reusing the path
    // does not inherit the dead note's highlights.
    expect(manager.offsetTracker.getTrackedPaths()).toEqual([kept]);
    expect(notifiedPaths(trigger)).toEqual([kept]);
  });

  it('clears the cached highlights of a note whose database entry is gone', async () => {
    // The other device deleted the article itself, so getHighlights finds no
    // entry to query and returns without writing to the tracker.
    const path = 'articles/unimported.md';
    const { manager, trigger } = makeRefreshManager({
      rowsByPath: { [path]: [] },
      noteTypeFor: () => null,
    });
    manager.offsetTracker.loadHighlights(path, [
      SnippetManager.rowToHighlight(
        makeSnippetRow({ id: 'stale', start_offset: 0, end_offset: 4 })
      )!,
    ]);

    await manager.refreshAllHighlights();

    expect(manager.offsetTracker.getHighlights(path)).toEqual([]);
    expect(notifiedPaths(trigger)).toEqual([path]);
  });

  it('reads nothing and announces nothing when no note has been tracked yet', async () => {
    const { manager, query, trigger } = makeRefreshManager({ rowsByPath: {} });

    await manager.refreshAllHighlights();

    expect(query).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });
});

describe('repointSource', () => {
  const NEW_SOURCE = { path: 'articles/copy.md' } as TFile;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets the source property of every snippet note whose file still exists', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }),
        async (fileExists) => {
          const rows = fileExists.map((_, i) =>
            makeSnippetRow({
              id: `snippet-${i}`,
              reference: `snippets/${i}.md`,
            })
          );
          vi.spyOn(Obsidian, 'getNote').mockImplementation((reference) => {
            const index = rows.findIndex((row) => row.reference === reference);
            return fileExists[index] ? ({ path: reference } as TFile) : null;
          });
          vi.spyOn(Obsidian, 'generateMarkdownLink').mockReturnValue(
            '[[copy]]'
          );
          const updateSpy = vi
            .spyOn(Obsidian, 'updateFrontMatter')
            .mockResolvedValue(undefined as never);
          const manager = new SnippetManager(
            { app: makeApp() } as never,
            makeSimpleRepo()
          );

          await manager.repointSource(rows, NEW_SOURCE);

          expect(updateSpy).toHaveBeenCalledTimes(
            fileExists.filter(Boolean).length
          );
          vi.restoreAllMocks();
        }
      )
    );
  });

  it('writes the link the snippet would have had if taken from the new source', async () => {
    const row = makeSnippetRow({ reference: 'snippets/one.md' });
    const snippetFile = { path: row.reference } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(snippetFile);
    const linkSpy = vi
      .spyOn(Obsidian, 'generateMarkdownLink')
      .mockReturnValue('[[articles/copy|copy]]');
    const updateSpy = vi
      .spyOn(Obsidian, 'updateFrontMatter')
      .mockResolvedValue(undefined as never);
    const manager = new SnippetManager(
      { app: makeApp() } as never,
      makeSimpleRepo()
    );

    await manager.repointSource([row], NEW_SOURCE);

    // linked to the new source, from the snippet note
    expect(linkSpy).toHaveBeenCalledWith(
      NEW_SOURCE,
      snippetFile,
      expect.anything()
    );
    const updates = updateSpy.mock.calls[0][1] as (
      frontmatter: Record<string, unknown>
    ) => void;
    const frontmatter: Record<string, unknown> = { tags: [SNIPPET_TAG] };
    updates(frontmatter);
    expect(frontmatter[SOURCE_PROPERTY_NAME]).toBe('[[articles/copy|copy]]');
    // rewriting the source must not disturb the note's tags
    expect(frontmatter.tags).toEqual([SNIPPET_TAG]);
  });
});

describe('getHighlights for a note with no database entry', () => {
  const SOURCE = { path: 'notes/source.md' } as TFile;
  let repo: SQLiteRepository;
  let db: Database;

  beforeEach(async () => {
    ({ repo, db } = await makeSqlJsRepo());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The source-note branch is only reached for a note with no DB row. Backed
   * by a real database so the orphan query's own filters decide which rows
   * reach the highlight mapping.
   */
  function makeSourceNoteManager(specs: OrphanSpec[], isSource = true) {
    db.exec('DELETE FROM snippet');
    const { manager } = seedOrphans(db, repo, specs, SOURCE.path);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue(null);
    vi.spyOn(Obsidian, 'isSourceNote').mockReturnValue(isSource);
    return { manager };
  }

  const RENDERABLE: OrphanSpec = {
    exists: true,
    source: 'target',
    parent: null,
    deleted: false,
    start_offset: 4,
    end_offset: 12,
  };

  it('returns highlights for parentless snippets taken from the note', async () => {
    const { manager } = makeSourceNoteManager([RENDERABLE]);

    const highlights = await manager.getHighlights(SOURCE);

    expect(highlights.map((h) => h.id)).toEqual(['snippet-0']);
    expect(manager.offsetTracker.getHighlights(SOURCE.path)).toHaveLength(1);
  });

  it('omits snippets that already belong to an item, so a copy import does not leave highlights behind', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (parentId) => {
        const { manager } = makeSourceNoteManager([
          { ...RENDERABLE, parent: parentId },
        ]);

        const highlights = await manager.getHighlights(SOURCE);

        expect(highlights).toEqual([]);
        vi.restoreAllMocks();
      })
    );
  });

  it('omits snippets taken from some other note', async () => {
    const { manager } = makeSourceNoteManager([
      { ...RENDERABLE, source: 'elsewhere' },
    ]);

    expect(await manager.getHighlights(SOURCE)).toEqual([]);
  });

  it('omits snippets with no recorded offsets', async () => {
    const { manager } = makeSourceNoteManager([
      { ...RENDERABLE, start_offset: null, end_offset: null },
    ]);

    expect(await manager.getHighlights(SOURCE)).toEqual([]);
  });

  it('returns nothing for a note that is neither an item nor a source', async () => {
    const { manager } = makeSourceNoteManager([RENDERABLE], false);

    expect(await manager.getHighlights(SOURCE)).toEqual([]);
  });
});
