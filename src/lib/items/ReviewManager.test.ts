/* eslint-disable obsidianmd/no-tfile-tfolder-cast -- this is a test file */
import type {
  NoteType,
  ReviewArticle,
  ReviewCard,
  ReviewSnippet,
  SQLiteRepository,
} from '#/lib/types';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function makePlugin() {
  return {
    app: {},
    settings: { dayRolloverOffset: 4 },
    // ReviewManager reads plugin.app and constructs sub-managers via `new`
  } as never;
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
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns only items that are due and belong to the specified typesToInclude', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a "current time" between year 2000 and 2100
        fc.integer({ min: YEAR_2000_MS, max: YEAR_2100_MS }),
        // Generate a non-empty subset of note types to include
        fc.subarray(['article', 'snippet', 'card'] as const, { minLength: 1 }),
        async (nowMs, includedTypes) => {
          vi.setSystemTime(nowMs);

          const typesToInclude = Object.fromEntries(
            includedTypes.map((t) => [t, true as const])
          ) as Partial<Record<NoteType, true>>;

          // For each type: one item due at nowMs (due), one item due after nowMs (not due)
          const dueArticle = makeReviewArticle(nowMs);
          const notDueArticle = makeReviewArticle(nowMs + 1);
          const dueSnippet = makeReviewSnippet(nowMs);
          const notDueSnippet = makeReviewSnippet(nowMs + 1);
          const dueCard = makeReviewCard(nowMs);
          const notDueCard = makeReviewCard(nowMs + 1);

          const repo = makeRepo();
          const plugin = makePlugin();
          const manager = new ReviewManager(plugin, repo);

          // Mock each sub-manager's getDue to return [due, notDue], simulating the
          // SQL `due <= dueBy` filter: only return items whose due <= the passed dueBy.
          vi.spyOn(manager.articles, 'getDue').mockImplementation(
            async (dueBy) => {
              const cutoff = dueBy ?? nowMs;
              return [dueArticle, notDueArticle].filter(
                (r) => r.data.due !== null && r.data.due <= cutoff
              );
            }
          );
          vi.spyOn(manager.snippets, 'getDue').mockImplementation(
            async (dueBy) => {
              const cutoff = dueBy ?? nowMs;
              return [dueSnippet, notDueSnippet].filter(
                (r) => r.data.due !== null && r.data.due <= cutoff
              );
            }
          );
          vi.spyOn(manager.cards, 'getDue').mockImplementation(
            async (dueBy) => {
              const cutoff = dueBy ?? nowMs;
              return [dueCard, notDueCard].filter(
                (r) => r.data.due.getTime() <= cutoff
              );
            }
          );

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
