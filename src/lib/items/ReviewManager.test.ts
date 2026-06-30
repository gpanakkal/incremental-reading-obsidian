/* eslint-disable obsidianmd/no-tfile-tfolder-cast -- this is a test file */
import { DATA_DIRECTORY, MS_PER_DAY } from '#/lib/constants';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import type {
  ArticleRow,
  IArticleBase,
  ISnippetBase,
  NoteType,
  ReviewArticle,
  ReviewCard,
  ReviewItem,
  ReviewSnippet,
  SnippetRow,
  SQLiteRepository,
  SRSCardRow,
} from '#/lib/types';
import fc from 'fast-check';
import type { TAbstractFile, TFile } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardManager } from './CardManager';
import ReviewManager from './ReviewManager';

// #region HELPERS

const YEAR_2000_MS = new Date('2000-01-01T12:00:00Z').getTime();
const YEAR_2100_MS = new Date('2100-01-01T12:00:00Z').getTime();

const FAKE_FILE = { path: 'incremental-reading/test.md' } as TFile;

function makeRepo(): SQLiteRepository {
  return {
    query: vi.fn().mockResolvedValue([]),
    mutate: vi.fn().mockResolvedValue([[]]),
    _execSql: vi.fn(),
    handleFileChange: vi.fn(),
  } as unknown as SQLiteRepository;
}

function makePlugin(appOverrides: Record<string, unknown> = {}) {
  return {
    app: { ...appOverrides },
    settings: { dayRolloverOffset: 4 },
    registerEvent: vi.fn(),
  } as never;
}

function makeArticleBase(overrides: Partial<IArticleBase> = {}): IArticleBase {
  return {
    id: 'article-1',
    type: 'article',
    reference: 'articles/test.md',
    due: Date.now(),
    interval: 86_400_000,
    dismissed: false,
    deleted: false,
    priority: 30,
    fixed_interval_days: null,
    scroll_top: 0,
    ...overrides,
  };
}

function makeSnippetBase(overrides: Partial<ISnippetBase> = {}): ISnippetBase {
  return {
    id: 'snippet-1',
    type: 'snippet',
    reference: 'snippets/test.md',
    due: Date.now(),
    interval: 86_400_000,
    dismissed: false,
    deleted: false,
    priority: 30,
    parent: null,
    start_offset: null,
    end_offset: null,
    scroll_top: 0,
    ...overrides,
  };
}

function makeArticleRow(overrides: Partial<ArticleRow> = {}): ArticleRow {
  const base = makeArticleBase();
  return {
    id: base.id,
    reference: base.reference,
    due: base.due,
    interval: base.interval,
    dismissed: 0,
    deleted: false,
    priority: base.priority,
    fixed_interval_days: base.fixed_interval_days,
    scroll_top: base.scroll_top,
    ...overrides,
  };
}

function makeSnippetRow(overrides: Partial<SnippetRow> = {}): SnippetRow {
  const base = makeSnippetBase();
  return {
    id: base.id,
    reference: base.reference,
    due: base.due,
    interval: base.interval,
    dismissed: 0,
    deleted: false,
    priority: base.priority,
    parent: base.parent,
    start_offset: base.start_offset,
    end_offset: base.end_offset,
    scroll_top: base.scroll_top,
    ...overrides,
  };
}

function makeCardRow(overrides: Partial<SRSCardRow> = {}): SRSCardRow {
  return {
    id: 'card-1',
    reference: 'cards/test.md',
    due: Date.now() + 86_400_000,
    created_at: Date.now(),
    last_review: null,
    dismissed: 0,
    deleted: false,
    stability: 1,
    difficulty: 5,
    elapsed_days: 0,
    scheduled_days: 1,
    reps: 0,
    lapses: 0,
    state: 0,
    ...overrides,
  } as unknown as SRSCardRow;
}

function makeReviewArticleItem(due: number): ReviewArticle {
  return {
    data: makeArticleBase({ id: `article-${due}`, due }),
    file: FAKE_FILE,
  };
}

/** Build a ReviewItem from the given type for use in dismiss/undismiss tests */
function makeReviewItem(type: NoteType, id = 'item-1'): ReviewItem {
  if (type === 'article') {
    return {
      data: makeArticleBase({ id }),
      file: {
        ...FAKE_FILE,
        path: `${DATA_DIRECTORY}/articles/${id}.md`,
      } as TFile,
    } satisfies ReviewArticle;
  } else if (type === 'snippet') {
    return {
      data: makeSnippetBase({ id }),
      file: {
        ...FAKE_FILE,
        path: `${DATA_DIRECTORY}/snippets/${id}.md`,
      } as TFile,
    } satisfies ReviewSnippet;
  } else {
    return {
      data: CardManager.rowToDisplay(makeCardRow({ id })),
      file: { ...FAKE_FILE, path: `${DATA_DIRECTORY}/cards/${id}.md` } as TFile,
    } satisfies ReviewCard;
  }
}

function makeReviewArticle(due: number): ReviewArticle {
  return {
    data: {
      id: `article-${due}`,
      type: 'article',
      reference: 'articles/test.md',
      due,
      interval: 86_400_000,
      dismissed: false,
      deleted: false,
      priority: 30,
      fixed_interval_days: null,
      scroll_top: 0,
    },
    file: FAKE_FILE,
  };
}

function makeReviewSnippet(due: number): ReviewSnippet {
  return {
    data: {
      id: `snippet-${due}`,
      type: 'snippet',
      reference: 'snippets/test.md',
      due,
      interval: 86_400_000,
      dismissed: false,
      deleted: false,
      priority: 30,
      parent: null,
      start_offset: null,
      end_offset: null,
      scroll_top: 0,
    },
    file: FAKE_FILE,
  };
}

function makeReviewCard(due: number): ReviewCard {
  return {
    data: {
      id: `card-${due}`,
      type: 'card',
      reference: 'cards/test.md',
      due: new Date(due),
      created_at: new Date(due - 86_400_000),
      last_review: undefined,
      dismissed: false,
      deleted: false,
      stability: 1,
      difficulty: 5,
      elapsed_days: 0,
      scheduled_days: 1,
      reps: 0,
      lapses: 0,
      state: 'New',
    },
    file: FAKE_FILE,
  };
}

// #endregion

describe('ReviewManager.getDue', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns only items that are due and belong to the specified typesToInclude', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a "current time" between year 2000 and 2100 at day granularity.
        // Using day offsets (not milliseconds) shrinks the search space from ~3 trillion
        // to ~36 500 values, keeping shrinking fast without losing meaningful coverage.
        fc.integer({ min: 0, max: Math.floor((YEAR_2100_MS - YEAR_2000_MS) / MS_PER_DAY) })
          .map((days) => YEAR_2000_MS + days * MS_PER_DAY),
        // Generate a non-empty subset of note types to include
        fc.subarray(['article', 'snippet', 'card'] as const, { minLength: 1 }),
        async (nowMs, includedTypes) => {
          vi.setSystemTime(nowMs);

          const typesToInclude = Object.fromEntries(
            includedTypes.map((t) => [t, true as const])
          ) as Partial<Record<NoteType, true>>;

          // For each type: one item due at nowMs (due), one item due after nowMs (not due)
          const dueArticle = makeReviewArticle(nowMs);
          const notDueArticle = makeReviewArticle(nowMs + MS_PER_DAY);
          const dueSnippet = makeReviewSnippet(nowMs);
          const notDueSnippet = makeReviewSnippet(nowMs + MS_PER_DAY);
          const dueCard = makeReviewCard(nowMs);
          const notDueCard = makeReviewCard(nowMs + MS_PER_DAY);

          const repo = makeRepo();
          const plugin = makePlugin();
          const manager = new ReviewManager(plugin, repo);

          // Direct assignment avoids registering Vitest spies on every iteration
          // (50 000 spies × 3 sub-managers would exhaust heap before afterEach fires).
          // We don't assert call counts here, so a tracked spy isn't needed.
          manager.articles.getDue = async (dueBy) => {
            const cutoff = dueBy ?? nowMs;
            return [dueArticle, notDueArticle].filter(
              (r) => r.data.due !== null && r.data.due <= cutoff
            );
          };
          manager.snippets.getDue = async (dueBy) => {
            const cutoff = dueBy ?? nowMs;
            return [dueSnippet, notDueSnippet].filter(
              (r) => r.data.due !== null && r.data.due <= cutoff
            );
          };
          manager.cards.getDue = async (dueBy) => {
            const cutoff = dueBy ?? nowMs;
            return [dueCard, notDueCard].filter(
              (r) => r.data.due.getTime() <= cutoff
            );
          };

          const result = await manager.getDue({ typesToInclude });

          // Only included types should appear in the results
          const allIds = result.all.map((r) => r.data.id);

          for (const type of ['article', 'snippet', 'card'] as const) {
            const dueItem =
              type === 'article'
                ? dueArticle
                : type === 'snippet'
                  ? dueSnippet
                  : dueCard;
            const notDueItem =
              type === 'article'
                ? notDueArticle
                : type === 'snippet'
                  ? notDueSnippet
                  : notDueCard;

            if (type in typesToInclude) {
              expect(allIds, `due ${type} should be included`).toContain(
                dueItem.data.id
              );
              expect(
                allIds,
                `not-due ${type} should be excluded`
              ).not.toContain(notDueItem.data.id);
            } else {
              expect(
                allIds,
                `${type} not in typesToInclude should be absent`
              ).not.toContain(dueItem.data.id);
              expect(
                allIds,
                `${type} not in typesToInclude should be absent`
              ).not.toContain(notDueItem.data.id);
            }
          }

          // Typed sub-arrays should match the same filtering
          if ('article' in typesToInclude) {
            expect(result.articles.map((r) => r.data.id)).toContain(
              dueArticle.data.id
            );
            expect(result.articles.map((r) => r.data.id)).not.toContain(
              notDueArticle.data.id
            );
          } else {
            expect(result.articles).toHaveLength(0);
          }

          if ('snippet' in typesToInclude) {
            expect(result.snippets.map((r) => r.data.id)).toContain(
              dueSnippet.data.id
            );
            expect(result.snippets.map((r) => r.data.id)).not.toContain(
              notDueSnippet.data.id
            );
          } else {
            expect(result.snippets).toHaveLength(0);
          }

          if ('card' in typesToInclude) {
            expect(result.cards.map((r) => r.data.id)).toContain(
              dueCard.data.id
            );
            expect(result.cards.map((r) => r.data.id)).not.toContain(
              notDueCard.data.id
            );
          } else {
            expect(result.cards).toHaveLength(0);
          }
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Delegation tests — simple passthrough methods
// ---------------------------------------------------------------------------

describe('ReviewManager delegation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parseCloze delegates to cards.parseCloze', () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const fakeResult = { start: 'before', answer: 'cloze', end: 'after' };
    const spy = vi
      .spyOn(manager.cards, 'parseCloze')
      .mockReturnValue(fakeResult);
    const result = manager.parseCloze('text (}cloze{)', ['(}', '{)']);
    expect(spy).toHaveBeenCalledWith('text (}cloze{)', ['(}', '{)']);
    expect(result).toEqual(fakeResult);
  });

  it('reviewCard delegates to cards.review', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const card = CardManager.rowToDisplay(makeCardRow());
    const spy = vi
      .spyOn(manager.cards, 'review')
      .mockResolvedValue(undefined as never);
    await manager.reviewCard(card, 3 as never);
    expect(spy).toHaveBeenCalledWith(card, 3, undefined);
  });

  it('reviewCard passes optional reviewTime to cards.review', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const card = CardManager.rowToDisplay(makeCardRow());
    const spy = vi
      .spyOn(manager.cards, 'review')
      .mockResolvedValue(undefined as never);
    const t = new Date();
    await manager.reviewCard(card, 1 as never, t);
    expect(spy).toHaveBeenCalledWith(card, 1, t);
  });

  it('getSnippetHighlights delegates to snippets.getHighlights', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const spy = vi
      .spyOn(manager.snippets, 'getHighlights')
      .mockResolvedValue([]);
    await manager.getSnippetHighlights(FAKE_FILE);
    expect(spy).toHaveBeenCalledWith(FAKE_FILE);
  });

  it('updateSnippetOffsets delegates to snippets.updateOffsets', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const spy = vi
      .spyOn(manager.snippets, 'updateOffsets')
      .mockResolvedValue(undefined as never);
    await manager.updateSnippetOffsets('snip-1', 10, 20);
    expect(spy).toHaveBeenCalledWith('snip-1', 10, 20);
  });

  it('reviewSnippet delegates to snippets.review', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const snippet = makeSnippetBase();
    const spy = vi
      .spyOn(manager.snippets, 'review')
      .mockResolvedValue(undefined as never);
    await manager.reviewSnippet(snippet, 1000, 86400000);
    expect(spy).toHaveBeenCalledWith(snippet, 1000, 86400000);
  });

  it('importArticle delegates to articles.import', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const spy = vi
      .spyOn(manager.articles, 'import')
      .mockResolvedValue(undefined as never);
    await manager.importArticle(FAKE_FILE, 30, null);
    expect(spy).toHaveBeenCalledWith(FAKE_FILE, 30, null);
  });

  it('createEmptyArticle delegates to articles.create', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const spy = vi
      .spyOn(manager.articles, 'create')
      .mockResolvedValue(undefined as never);
    await manager.createEmptyArticle(25);
    expect(spy).toHaveBeenCalledWith(25);
  });

  it('reviewArticle delegates to articles.review', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const article = makeArticleBase();
    const spy = vi
      .spyOn(manager.articles, 'review')
      .mockResolvedValue(undefined as never);
    await manager.reviewArticle(article, 1000, 86400000);
    expect(spy).toHaveBeenCalledWith(article, 1000, 86400000);
  });

  it('renameArticle delegates to articles.rename', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const reviewArticle: ReviewArticle = {
      data: makeArticleBase(),
      file: FAKE_FILE,
    };
    const spy = vi
      .spyOn(manager.articles, 'rename')
      .mockResolvedValue(undefined as never);
    await manager.renameArticle(reviewArticle, 'new-name');
    expect(spy).toHaveBeenCalledWith(reviewArticle, 'new-name');
  });
});

// ---------------------------------------------------------------------------
// reprioritize — branches on isArticle
// ---------------------------------------------------------------------------

describe('ReviewManager.reprioritize', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls articles.reprioritize for an article item', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 10, max: 50 }), async (priority) => {
        const repo = makeRepo();
        const manager = new ReviewManager(makePlugin(), repo);
        const article = makeArticleBase();
        // vi.fn() assigned directly: tracked per-iteration object, not added to
        // Vitest's global restore list (unlike vi.spyOn), so it won't accumulate.
        const articleMock = vi.fn().mockResolvedValue(undefined);
        const snippetMock = vi.fn().mockResolvedValue(undefined);
        manager.articles.reprioritize = articleMock;
        manager.snippets.reprioritize = snippetMock;
        await manager.reprioritize(article, priority);
        expect(articleMock).toHaveBeenCalledWith(article, priority);
        expect(snippetMock).not.toHaveBeenCalled();
      })
    );
  });

  it('calls snippets.reprioritize for a snippet item', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 10, max: 50 }), async (priority) => {
        const repo = makeRepo();
        const manager = new ReviewManager(makePlugin(), repo);
        const snippet = makeSnippetBase();
        const articleMock = vi.fn().mockResolvedValue(undefined);
        const snippetMock = vi.fn().mockResolvedValue(undefined);
        manager.articles.reprioritize = articleMock;
        manager.snippets.reprioritize = snippetMock;
        await manager.reprioritize(snippet, priority);
        expect(snippetMock).toHaveBeenCalledWith(snippet, priority);
        expect(articleMock).not.toHaveBeenCalled();
      })
    );
  });
});

// ---------------------------------------------------------------------------
// manageFixedInterval — branches on key presence
// ---------------------------------------------------------------------------

describe('ReviewManager.manageFixedInterval', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls articles.setFixedInterval when changes has newIntervalDays', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 30 }),
        async (newIntervalDays) => {
          const repo = makeRepo();
          const manager = new ReviewManager(makePlugin(), repo);
          const article = makeArticleBase();
          const setMock = vi.fn().mockResolvedValue(undefined);
          const disableMock = vi.fn().mockResolvedValue(undefined);
          manager.articles.setFixedInterval = setMock;
          manager.articles.disableFixedInterval = disableMock;
          await manager.manageFixedInterval(article, { newIntervalDays });
          expect(setMock).toHaveBeenCalledWith(article, newIntervalDays);
          expect(disableMock).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('calls articles.disableFixedInterval when changes has newPriority', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 10, max: 50 }),
        async (newPriority) => {
          const repo = makeRepo();
          const manager = new ReviewManager(makePlugin(), repo);
          const article = makeArticleBase();
          const setMock = vi.fn().mockResolvedValue(undefined);
          const disableMock = vi.fn().mockResolvedValue(undefined);
          manager.articles.setFixedInterval = setMock;
          manager.articles.disableFixedInterval = disableMock;
          await manager.manageFixedInterval(article, { newPriority });
          expect(disableMock).toHaveBeenCalledWith(article, newPriority);
          expect(setMock).not.toHaveBeenCalled();
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// getDue — error path
// ---------------------------------------------------------------------------

describe('ReviewManager.getDue error handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty arrays when a sub-manager throws', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(manager.articles, 'getDue').mockRejectedValue(
      new Error('db error')
    );
    vi.spyOn(manager.snippets, 'getDue').mockResolvedValue([]);
    vi.spyOn(manager.cards, 'getDue').mockResolvedValue([]);
    const result = await manager.getDue({
      typesToInclude: { article: true, snippet: true, card: true },
    });
    expect(result).toEqual({ all: [], cards: [], snippets: [], articles: [] });
  });
});

// ---------------------------------------------------------------------------
// getReviewItemFromFile
// ---------------------------------------------------------------------------

describe('ReviewManager.getReviewItemFromFile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when getNoteType returns null', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue(null);
    const result = await manager.getReviewItemFromFile(FAKE_FILE);
    expect(result).toBeNull();
  });

  it('returns null when article row not found', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('article');
    vi.spyOn(manager.articles, 'findArticle').mockResolvedValue(null);
    const result = await manager.getReviewItemFromFile(FAKE_FILE);
    expect(result).toBeNull();
  });

  it('returns ReviewArticle when article row is found', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const row = makeArticleRow();
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('article');
    vi.spyOn(manager.articles, 'findArticle').mockResolvedValue(row as never);
    const result = await manager.getReviewItemFromFile(FAKE_FILE);
    expect(result).not.toBeNull();
    expect(result!.data.type).toBe('article');
    expect(result!.data.id).toBe(row.id);
    expect(result!.file).toBe(FAKE_FILE);
  });

  it('returns null when snippet row not found', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('snippet');
    vi.spyOn(manager.snippets, 'findSnippet').mockResolvedValue(null);
    const result = await manager.getReviewItemFromFile(FAKE_FILE);
    expect(result).toBeNull();
  });

  it('returns ReviewSnippet when snippet row is found', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const row = makeSnippetRow();
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('snippet');
    vi.spyOn(manager.snippets, 'findSnippet').mockResolvedValue(row as never);
    const result = await manager.getReviewItemFromFile(FAKE_FILE);
    expect(result).not.toBeNull();
    expect(result!.data.type).toBe('snippet');
    expect(result!.data.id).toBe(row.id);
  });

  it('returns null when card row not found', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('card');
    vi.spyOn(manager.cards, 'findCard').mockResolvedValue(null);
    const result = await manager.getReviewItemFromFile(FAKE_FILE);
    expect(result).toBeNull();
  });

  it('returns ReviewCard when card row is found', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const row = makeCardRow();
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('card');
    vi.spyOn(manager.cards, 'findCard').mockResolvedValue(row as never);
    const result = await manager.getReviewItemFromFile(FAKE_FILE);
    expect(result).not.toBeNull();
    expect(result!.data.type).toBe('card');
    expect(result!.data.id).toBe(row.id);
  });
});

// ---------------------------------------------------------------------------
// getReviewItemFromId — tries each sub-manager in order
// ---------------------------------------------------------------------------

describe('ReviewManager.getReviewItemFromId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the article when articles.fetch finds it', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const expected: ReviewArticle = {
      data: makeArticleBase(),
      file: FAKE_FILE,
    };
    vi.spyOn(manager.articles, 'fetch').mockResolvedValue(expected);
    const snippetSpy = vi.spyOn(manager.snippets, 'fetch');
    const cardSpy = vi.spyOn(manager.cards, 'fetch');
    const result = await manager.getReviewItemFromId('article-1');
    expect(result).toBe(expected);
    expect(snippetSpy).not.toHaveBeenCalled();
    expect(cardSpy).not.toHaveBeenCalled();
  });

  it('falls through to snippets.fetch when articles.fetch returns null', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const expected: ReviewSnippet = {
      data: makeSnippetBase(),
      file: FAKE_FILE,
    };
    vi.spyOn(manager.articles, 'fetch').mockResolvedValue(null);
    vi.spyOn(manager.snippets, 'fetch').mockResolvedValue(expected);
    const cardSpy = vi.spyOn(manager.cards, 'fetch');
    const result = await manager.getReviewItemFromId('snippet-1');
    expect(result).toBe(expected);
    expect(cardSpy).not.toHaveBeenCalled();
  });

  it('falls through to cards.fetch when both articles and snippets return null', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const expected: ReviewCard = {
      data: CardManager.rowToDisplay(makeCardRow()),
      file: FAKE_FILE,
    };
    vi.spyOn(manager.articles, 'fetch').mockResolvedValue(null);
    vi.spyOn(manager.snippets, 'fetch').mockResolvedValue(null);
    vi.spyOn(manager.cards, 'fetch').mockResolvedValue(expected);
    const result = await manager.getReviewItemFromId('card-1');
    expect(result).toBe(expected);
  });

  it('returns null when no sub-manager finds the item', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(manager.articles, 'fetch').mockResolvedValue(null);
    vi.spyOn(manager.snippets, 'fetch').mockResolvedValue(null);
    vi.spyOn(manager.cards, 'fetch').mockResolvedValue(null);
    const result = await manager.getReviewItemFromId('missing-id');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// dismissItem / unDismissItem — table routing and SQL args
// ---------------------------------------------------------------------------

describe('ReviewManager.dismissItem and unDismissItem', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['article', 'article'],
    ['snippet', 'snippet'],
    ['card', 'srs_card'],
  ] as const)(
    'dismissItem uses table "%s" for %s type',
    async (type, expectedTable) => {
      const repo = makeRepo();
      const manager = new ReviewManager(makePlugin(), repo);
      const item = makeReviewItem(type);
      vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue(type);
      await manager.dismissItem(item);
      const [sql, params] = (repo.mutate as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, unknown[]];
      expect(sql).toContain(`UPDATE ${expectedTable}`);
      expect(sql).toContain('dismissed = 1');
      expect(params).toEqual([item.data.id]);
    }
  );

  it.each([
    ['article', 'article'],
    ['snippet', 'snippet'],
    ['card', 'srs_card'],
  ] as const)(
    'unDismissItem uses table "%s" for %s type',
    async (type, expectedTable) => {
      const repo = makeRepo();
      const manager = new ReviewManager(makePlugin(), repo);
      const item = makeReviewItem(type);
      vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue(type);
      await manager.unDismissItem(item);
      const [sql, params] = (repo.mutate as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, unknown[]];
      expect(sql).toContain(`UPDATE ${expectedTable}`);
      expect(sql).toContain('dismissed = 0');
      expect(params).toEqual([item.data.id]);
    }
  );
});

// ---------------------------------------------------------------------------
// handleExternalRename
// ---------------------------------------------------------------------------

describe('ReviewManager.handleExternalRename', () => {
  const IR_DIR = DATA_DIRECTORY; // 'incremental-reading'

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeApp(fileExists: boolean, noteType: NoteType | null = 'article', filePath?: string) {
    const resolvedPath = filePath ?? `${IR_DIR}/articles/renamed.md`;
    const file = fileExists
      ? ({ path: resolvedPath } as TFile)
      : null;
    const tagMap: Record<NonNullable<NoteType>, string> = {
      article: 'ir-article',
      snippet: 'ir-text-snippet',
      card: 'ir-card',
    };
    const tags = noteType ? [tagMap[noteType]] : undefined;
    const frontmatterContent = noteType
      ? `---\ntags: [${tagMap[noteType]}]\n---\n`
      : 'no frontmatter here';
    return {
      vault: {
        getFileByPath: vi.fn().mockReturnValue(file),
        cachedRead: vi.fn().mockResolvedValue(frontmatterContent),
      },
      fileManager: {
        processFrontMatter: vi.fn().mockImplementation(
          async (_f: unknown, cb: (fm: Record<string, unknown>) => void) => {
            cb(tags !== undefined ? { tags } : {});
          }
        ),
      },
      metadataCache: {
        getFileCache: vi.fn(),
        on: vi.fn().mockImplementation((_event: string, cb: (f: TFile) => void) => {
          if (file) cb(file);
          return Symbol('ref');
        }),
        offref: vi.fn(),
      },
    };
  }

  it('throws when the file cannot be found at newPath', async () => {
    const repo = makeRepo();
    const app = makeApp(false);
    const manager = new ReviewManager(makePlugin(app as never), repo);
    manager.app = app as never;
    const abstractFile = {
      path: `${IR_DIR}/articles/renamed.md`,
    } as TAbstractFile;
    await expect(
      manager.handleExternalRename(abstractFile, `${IR_DIR}/articles/old.md`)
    ).rejects.toThrow('Failed to find a file');
  });

  it('returns early (no mutate) when file has no IR note type', async () => {
    const repo = makeRepo();
    const app = makeApp(true, null);
    const manager = new ReviewManager(makePlugin(app as never), repo);
    manager.app = app as never;
    vi.spyOn(manager.snippets.offsetTracker, 'renameFile').mockReturnValue(
      undefined
    );
    const abstractFile = {
      path: `${IR_DIR}/articles/renamed.md`,
    } as TAbstractFile;
    await manager.handleExternalRename(
      abstractFile,
      `${IR_DIR}/articles/old.md`
    );
    expect(repo.mutate).not.toHaveBeenCalled();
  });

  it('updates reference when item moves from external folder into IR directory', async () => {
    const repo = makeRepo();
    const newPath = `${IR_DIR}/articles/renamed.md`;
    const oldPath = 'some-other-folder/old.md';
    const app = makeApp(true, 'article');
    const manager = new ReviewManager(makePlugin(app as never), repo);
    manager.app = app as never;
    vi.spyOn(manager.snippets.offsetTracker, 'renameFile').mockReturnValue(
      undefined
    );
    const abstractFile = { path: newPath } as TAbstractFile;
    await manager.handleExternalRename(abstractFile, oldPath);
    expect(repo.mutate).toHaveBeenCalled();
    const [sql, params] = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];
    expect(sql).toContain('UPDATE article');
    expect(params[0]).toBe(newPath);
    expect(params[1]).toBe(oldPath);
  });

  it('updates reference when item moves out of IR directory to external folder', async () => {
    const repo = makeRepo();
    const newPath = 'some-other-folder/renamed.md';
    const oldPath = `${IR_DIR}/articles/old.md`;
    const app = makeApp(true, 'article', newPath);
    const manager = new ReviewManager(makePlugin(app as never), repo);
    manager.app = app as never;
    vi.spyOn(manager.snippets.offsetTracker, 'renameFile').mockReturnValue(
      undefined
    );
    const abstractFile = { path: newPath } as TAbstractFile;
    await manager.handleExternalRename(abstractFile, oldPath);
    expect(repo.mutate).toHaveBeenCalled();
    const [sql, params] = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];
    expect(sql).toContain('UPDATE article');
    expect(params[0]).toBe(newPath);
    expect(params[1]).toBe(oldPath);
  });

  it('updates reference when item moves between two non-IR folders', async () => {
    const repo = makeRepo();
    const newPath = 'folder-b/new-name.md';
    const oldPath = 'folder-a/old-name.md';
    const app = makeApp(true, 'article', newPath);
    const manager = new ReviewManager(makePlugin(app as never), repo);
    manager.app = app as never;
    vi.spyOn(manager.snippets.offsetTracker, 'renameFile').mockReturnValue(
      undefined
    );
    const abstractFile = { path: newPath } as TAbstractFile;
    await manager.handleExternalRename(abstractFile, oldPath);
    expect(repo.mutate).toHaveBeenCalled();
    const [sql, params] = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];
    expect(sql).toContain('UPDATE article');
    expect(params[0]).toBe(newPath);
    expect(params[1]).toBe(oldPath);
  });

  it('returns early (no mutate) when old and new reference are identical', async () => {
    const repo = makeRepo();
    // same basename in same subfolder → same reference
    const sameFile = { path: `${IR_DIR}/articles/same.md` } as TFile;
    const appObj = {
      vault: {
        getFileByPath: vi.fn().mockReturnValue(sameFile),
        cachedRead: vi.fn().mockResolvedValue('---\ntags: [ir-article]\n---\n'),
      },
      fileManager: {
        processFrontMatter: vi.fn().mockImplementation(
          async (_f: unknown, cb: (fm: Record<string, unknown>) => void) => {
            cb({ tags: ['ir-article'] });
          }
        ),
      },
      metadataCache: { getFileCache: vi.fn(), on: vi.fn().mockReturnValue(Symbol()), offref: vi.fn() },
    };
    const manager = new ReviewManager(makePlugin(appObj as never), repo);
    manager.app = appObj as never;
    vi.spyOn(manager.snippets.offsetTracker, 'renameFile').mockReturnValue(
      undefined
    );
    const abstractFile = {
      path: `${IR_DIR}/articles/same.md`,
    } as TAbstractFile;
    await manager.handleExternalRename(
      abstractFile,
      `${IR_DIR}/articles/same.md`
    );
    expect(repo.mutate).not.toHaveBeenCalled();
  });

  it.each([
    ['article', 'article'],
    ['snippet', 'snippet'],
    ['card', 'srs_card'],
  ] as const)(
    'updates reference in table "%s" for note type %s',
    async (noteType, expectedTable) => {
      const repo = makeRepo();
      const tagMap: Record<string, string> = {
        article: 'ir-article',
        snippet: 'ir-text-snippet',
        card: 'ir-card',
      };
      const newPath = `${IR_DIR}/articles/new-name.md`;
      const oldPath = `${IR_DIR}/articles/old-name.md`;
      const file = { path: newPath } as TFile;
      const appObj = {
        vault: {
          getFileByPath: vi.fn().mockReturnValue(file),
          cachedRead: vi.fn().mockResolvedValue(`---\ntags: [${tagMap[noteType]}]\n---\n`),
        },
        fileManager: {
          processFrontMatter: vi.fn().mockImplementation(
            async (_f: unknown, cb: (fm: Record<string, unknown>) => void) => {
              cb({ tags: [tagMap[noteType]] });
            }
          ),
        },
        metadataCache: { getFileCache: vi.fn(), on: vi.fn().mockReturnValue(Symbol()), offref: vi.fn() },
      };
      const manager = new ReviewManager(makePlugin(appObj as never), repo);
      manager.app = appObj as never;
      vi.spyOn(manager.snippets.offsetTracker, 'renameFile').mockReturnValue(
        undefined
      );
      const abstractFile = { path: newPath } as TAbstractFile;
      await manager.handleExternalRename(abstractFile, oldPath);
      const [sql, params] = (repo.mutate as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, unknown[]];
      expect(sql).toContain(`UPDATE ${expectedTable}`);
      expect(sql).toContain('SET reference');
      expect(params[0]).toBe(`${IR_DIR}/articles/new-name.md`);
      expect(params[1]).toBe(`${IR_DIR}/articles/old-name.md`);
    }
  );
});

// ---------------------------------------------------------------------------
// saveScrollPosition
// ---------------------------------------------------------------------------

describe('ReviewManager.saveScrollPosition', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing when noteType is null', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue(null);
    await manager.saveScrollPosition(FAKE_FILE, { top: 100, left: 0 });
    expect(repo.mutate).not.toHaveBeenCalled();
  });

  it('does nothing when noteType is card', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('card');
    await manager.saveScrollPosition(FAKE_FILE, { top: 100, left: 0 });
    expect(repo.mutate).not.toHaveBeenCalled();
  });

  it.each(['article', 'snippet'] as const)(
    'mutates %s table with rounded scroll_top',
    async (noteType) => {
      await fc.assert(
        fc.asyncProperty(
          fc.float({ min: 0, max: 10000, noNaN: true }),
          async (top) => {
            vi.restoreAllMocks();
            const repo = makeRepo();
            const manager = new ReviewManager(makePlugin(), repo);
            vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue(noteType);
            await manager.saveScrollPosition(FAKE_FILE, { top, left: 0 });
            const [sql, params] = (repo.mutate as ReturnType<typeof vi.fn>).mock
              .calls[0] as [string, unknown[]];
            expect(sql).toContain(`UPDATE ${noteType}`);
            expect(sql).toContain('scroll_top');
            expect(params[0]).toBe(Math.round(top));
          }
        )
      );
    }
  );
});

// ---------------------------------------------------------------------------
// loadScrollPosition
// ---------------------------------------------------------------------------

describe('ReviewManager.loadScrollPosition', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when noteType is null', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue(null);
    const result = await manager.loadScrollPosition(FAKE_FILE);
    expect(result).toBeNull();
  });

  it('returns null when noteType is card', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('card');
    const result = await manager.loadScrollPosition(FAKE_FILE);
    expect(result).toBeNull();
  });

  it('returns null when article row not found', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('article');
    vi.spyOn(manager.articles, 'findArticle').mockResolvedValue(null);
    const result = await manager.loadScrollPosition(FAKE_FILE);
    expect(result).toBeNull();
  });

  it('returns null when article row scroll_top is 0', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('article');
    vi.spyOn(manager.articles, 'findArticle').mockResolvedValue(
      makeArticleRow({ scroll_top: 0 }) as never
    );
    const result = await manager.loadScrollPosition(FAKE_FILE);
    expect(result).toBeNull();
  });

  it('returns {top, left:0} when article row has scroll_top > 0', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 100000 }),
        async (scrollTop) => {
          vi.restoreAllMocks();
          const repo = makeRepo();
          const manager = new ReviewManager(makePlugin(), repo);
          vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('article');
          vi.spyOn(manager.articles, 'findArticle').mockResolvedValue(
            makeArticleRow({ scroll_top: scrollTop }) as never
          );
          const result = await manager.loadScrollPosition(FAKE_FILE);
          expect(result).toEqual({ top: scrollTop, left: 0 });
        }
      )
    );
  });

  it('returns null when snippet row not found', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('snippet');
    vi.spyOn(manager.snippets, 'findSnippet').mockResolvedValue(null);
    const result = await manager.loadScrollPosition(FAKE_FILE);
    expect(result).toBeNull();
  });

  it('returns null when snippet row scroll_top is 0', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('snippet');
    vi.spyOn(manager.snippets, 'findSnippet').mockResolvedValue(
      makeSnippetRow({ scroll_top: 0 }) as never
    );
    const result = await manager.loadScrollPosition(FAKE_FILE);
    expect(result).toBeNull();
  });

  it('returns {top, left:0} when snippet row has scroll_top > 0', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 100000 }),
        async (scrollTop) => {
          vi.restoreAllMocks();
          const repo = makeRepo();
          const manager = new ReviewManager(makePlugin(), repo);
          vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('snippet');
          vi.spyOn(manager.snippets, 'findSnippet').mockResolvedValue(
            makeSnippetRow({ scroll_top: scrollTop }) as never
          );
          const result = await manager.loadScrollPosition(FAKE_FILE);
          expect(result).toEqual({ top: scrollTop, left: 0 });
        }
      )
    );
  });

  it('card noteType does not call findArticle or findSnippet', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('card');
    const articleSpy = vi.spyOn(manager.articles, 'findArticle');
    const snippetSpy = vi.spyOn(manager.snippets, 'findSnippet');
    const result = await manager.loadScrollPosition(FAKE_FILE);
    expect(result).toBeNull();
    expect(articleSpy).not.toHaveBeenCalled();
    expect(snippetSpy).not.toHaveBeenCalled();
  });

  it('article noteType calls findArticle but not findSnippet', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('article');
    const articleSpy = vi
      .spyOn(manager.articles, 'findArticle')
      .mockResolvedValue(null);
    const snippetSpy = vi.spyOn(manager.snippets, 'findSnippet');
    await manager.loadScrollPosition(FAKE_FILE);
    expect(articleSpy).toHaveBeenCalled();
    expect(snippetSpy).not.toHaveBeenCalled();
  });

  it('snippet noteType calls findSnippet but not findArticle', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('snippet');
    const articleSpy = vi.spyOn(manager.articles, 'findArticle');
    const snippetSpy = vi
      .spyOn(manager.snippets, 'findSnippet')
      .mockResolvedValue(null);
    await manager.loadScrollPosition(FAKE_FILE);
    expect(snippetSpy).toHaveBeenCalled();
    expect(articleSpy).not.toHaveBeenCalled();
  });

  it('returns null when scroll_top is not a number', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('article');
    // scroll_top is undefined — exercises the typeof check
    vi.spyOn(manager.articles, 'findArticle').mockResolvedValue(
      makeArticleRow({ scroll_top: undefined as unknown as number }) as never
    );
    const result = await manager.loadScrollPosition(FAKE_FILE);
    expect(result).toBeNull();
  });

  it('snippet: returns null when scroll_top is not a number', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('snippet');
    vi.spyOn(manager.snippets, 'findSnippet').mockResolvedValue(
      makeSnippetRow({ scroll_top: undefined as unknown as number }) as never
    );
    const result = await manager.loadScrollPosition(FAKE_FILE);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Additional targeted tests to kill surviving mutants
// ---------------------------------------------------------------------------

describe('ReviewManager.getDue sort order', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('all array is sorted by due date ascending across types', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const t1 = 1000;
    const t2 = 2000;
    const t3 = 3000;
    // Return items out of order from each sub-manager
    const article = makeReviewArticleItem(t3);
    const snippet: ReviewSnippet = {
      data: makeSnippetBase({ id: 'snip', due: t1 }),
      file: FAKE_FILE,
    };
    const card: ReviewCard = {
      data: CardManager.rowToDisplay(makeCardRow({ id: 'card', due: t2 })),
      file: FAKE_FILE,
    };
    vi.spyOn(manager.articles, 'getDue').mockResolvedValue([article]);
    vi.spyOn(manager.snippets, 'getDue').mockResolvedValue([snippet]);
    vi.spyOn(manager.cards, 'getDue').mockResolvedValue([card]);
    const result = await manager.getDue({
      typesToInclude: { article: true, snippet: true, card: true },
    });
    const ids = result.all.map((r) => r.data.id);
    expect(ids).toEqual(['snip', 'card', `article-${t3}`]);
  });
});

describe('ReviewManager.getReviewItemFromFile card branch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not call findCard when noteType is snippet (card branch not taken)', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('snippet');
    vi.spyOn(manager.snippets, 'findSnippet').mockResolvedValue(
      makeSnippetRow() as never
    );
    const cardSpy = vi.spyOn(manager.cards, 'findCard');
    await manager.getReviewItemFromFile(FAKE_FILE);
    expect(cardSpy).not.toHaveBeenCalled();
  });
});

describe('ReviewManager.handleExternalRename console.warn mutant', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns (does not mutate) when old and new reference are identical', async () => {
    const repo = makeRepo();
    const samePath = `${DATA_DIRECTORY}/articles/same.md`;
    const file = { path: samePath } as TFile;
    const appObj = {
      vault: {
        getFileByPath: vi.fn().mockReturnValue(file),
        cachedRead: vi.fn().mockResolvedValue('---\ntags: [ir-article]\n---\n'),
      },
      fileManager: {
        processFrontMatter: vi.fn().mockImplementation(
          async (_f: unknown, cb: (fm: Record<string, unknown>) => void) => {
            cb({ tags: ['ir-article'] });
          }
        ),
      },
      metadataCache: { getFileCache: vi.fn(), on: vi.fn().mockReturnValue(Symbol()), offref: vi.fn() },
    };
    const manager = new ReviewManager(makePlugin(appObj as never), repo);
    manager.app = appObj as never;
    vi.spyOn(manager.snippets.offsetTracker, 'renameFile').mockReturnValue(
      undefined
    );
    const warnSpy = vi.spyOn(console, 'warn').mockReturnValue(undefined);
    const abstractFile = { path: samePath } as TAbstractFile;
    await manager.handleExternalRename(abstractFile, samePath);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('did not change')
    );
    expect(repo.mutate).not.toHaveBeenCalled();
  });
});
