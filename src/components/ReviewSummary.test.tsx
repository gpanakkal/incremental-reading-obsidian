// @vitest-environment jsdom
import * as ReactQuery from '#/hooks/useReactQuery';
import * as Store from '#/lib/store';
import type { NoteType, ReviewItem } from '#/lib/types';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ReviewContext from './ReviewContext';
import { ReviewSummary } from './ReviewSummary';

// #region HELPERS

/**
 * react-redux is mocked below; the selectors are stubbed individually, so the
 * state handed to them never needs any shape of its own.
 */
const reduxState = {};

const noteTypeArb = fc.constantFrom<NoteType>('article', 'snippet', 'card');

/** The row each kind of review gets, in display order. */
const COUNT_ORDER: readonly NoteType[] = ['article', 'snippet', 'card'];

/** Matches `count` as a whole number, beside `noun` pluralized for it. */
function countOf(count: number, noun: string): RegExp {
  return new RegExp(`\\b${count}\\b.*\\b${noun}${count === 1 ? '' : 's'}\\b`);
}

const skippedItemArb = fc.record({
  id: fc.string(),
  type: noteTypeArb,
  basename: fc.string(),
});

/**
 * One case: the reviews the store counted, the ids it holds as skipped, what
 * looking those ids up has produced so far — nothing while it is still
 * running, and otherwise any list at all, since the lookup drops ids whose
 * items are gone — how many cards the database says come due later today,
 * or nothing while it is still counting, and whether cards are among the
 * types this session reviews.
 */
const summaryArb = fc.record({
  // Empty often enough that a run reliably meets a tab opened onto an empty
  // queue, which needs both empty at once
  completed: fc.oneof(
    fc.constant<Record<string, NoteType>>({}),
    fc.dictionary(fc.string(), noteTypeArb)
  ),
  skippedIds: fc.oneof(fc.constant<string[]>([]), fc.uniqueArray(fc.string())),
  skippedItems: fc.option(fc.array(skippedItemArb), { nil: undefined }),
  // One, the singular, made as likely as none
  dueLaterToday: fc.option(fc.oneof(fc.constantFrom(0, 1), fc.nat()), {
    nil: undefined,
  }),
  reviewsCards: fc.boolean(),
});

type ValueOf<A> = A extends fc.Arbitrary<infer T> ? T : never;

type SummaryCase = ValueOf<typeof summaryArb>;

function makeItem({
  id,
  type,
  basename,
}: ValueOf<typeof skippedItemArb>): ReviewItem {
  return { data: { id, type }, file: { basename } as TFile } as ReviewItem;
}

/** Stub everything the summary reads, render it, and hand back the probes. */
function renderSummary({
  completed,
  skippedIds,
  skippedItems,
  dueLaterToday,
  reviewsCards,
}: SummaryCase) {
  // Per property case, not per `it`: see the matching note in
  // ReviewItem.test.tsx.
  vi.restoreAllMocks();
  document.body.innerHTML = '';

  // Built with own data properties so an id like "__proto__" is an id.
  const seenIds = Object.fromEntries(
    skippedIds.map((id) => [id, true as const])
  );
  vi.spyOn(Store, 'getCompletedReviews').mockReturnValue(completed);
  vi.spyOn(Store, 'getSeenIds').mockReturnValue(seenIds);
  vi.spyOn(Store, 'reviewsCards').mockReturnValue(reviewsCards);
  const useReviewItems = vi
    .spyOn(ReactQuery, 'useReviewItems')
    .mockReturnValue({ data: skippedItems?.map(makeItem) } as never);
  vi.spyOn(ReactQuery, 'useCardsDueLaterToday').mockReturnValue({
    data: dueLaterToday,
  } as never);
  const detach = vi.fn();
  vi.spyOn(ReviewContext, 'useReviewContext').mockReturnValue({
    reviewView: { leaf: { detach } },
  } as never);

  const container = document.createElement('div');
  document.body.appendChild(container);
  render(<ReviewSummary />, container);
  return { container, detach, useReviewItems, seenIds };
}

function text(el: Element | null | undefined): string | null {
  return el?.textContent ?? null;
}

function closeButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Close tab'
  );
  if (!button) throw new Error('no close button');
  return button;
}

// #endregion

vi.mock('react-redux', () => ({
  useSelector: (select: (state: typeof reduxState) => unknown) =>
    select(reduxState),
  useStore: () => ({ getState: () => reduxState }),
  useDispatch: () => vi.fn(),
}));

describe('ReviewSummary', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('calls the session complete once anything was reviewed or skipped, and the queue empty otherwise', () => {
    fc.assert(
      fc.property(summaryArb, (c) => {
        const headingFor = (summary: SummaryCase) =>
          text(renderSummary(summary).container.querySelector('h2'));
        const empty = { ...c, completed: {}, skippedIds: [] };
        const emptyHeading = headingFor(empty);
        const completeHeading = headingFor({ ...empty, skippedIds: ['x'] });

        const hadSession =
          Object.keys(c.completed).length > 0 || c.skippedIds.length > 0;
        expect(emptyHeading).toBeTruthy();
        expect(completeHeading).toBeTruthy();
        expect(completeHeading).not.toBe(emptyHeading);
        expect(headingFor(c)).toBe(hadSession ? completeHeading : emptyHeading);
      })
    );
  });

  it('counts the reviews completed, in total and by type, for a session that had any', () => {
    fc.assert(
      fc.property(summaryArb, (c) => {
        const { container } = renderSummary(c);

        const types = Object.values(c.completed);
        const hadSession = types.length > 0 || c.skippedIds.length > 0;
        const total = container.querySelector('.ir-review-summary-total');
        const counts = [
          ...container.querySelectorAll('.ir-review-summary-count'),
        ].map((el) => [
          text(el.querySelector('dt')),
          text(el.querySelector('dd')),
        ]);

        if (!hadSession) {
          // An empty queue opened onto has nothing to count.
          expect(total).toBeNull();
          expect(counts).toEqual([]);
          return;
        }
        expect(text(total)).toMatch(countOf(types.length, 'item'));
        expect(counts).toHaveLength(COUNT_ORDER.length);
        COUNT_ORDER.forEach((type, i) => {
          const countOfType = types.filter((t) => t === type).length;
          const [label, count] = counts[i];
          expect(label).toMatch(
            new RegExp(`^${type}${countOfType === 1 ? '' : 's'}$`, 'i')
          );
          expect(count).toBe(String(countOfType));
        });
      })
    );
  });

  it('lists the skipped items found, by name and type, in the order found', () => {
    fc.assert(
      fc.property(summaryArb, (c) => {
        const { container } = renderSummary(c);

        const section = container.querySelector('.ir-review-summary-skipped');
        const found = c.skippedItems ?? [];
        if (found.length === 0) {
          // Still looking, or nothing left to name.
          expect(section).toBeNull();
          return;
        }
        expect(text(section?.querySelector('h3'))).toMatch(
          new RegExp(`\\b${found.length}\\b`)
        );
        const rows = [...(section?.querySelectorAll('li') ?? [])].map((li) => [
          text(li.querySelector('.ir-review-summary-skipped-name')),
          text(li.querySelector('.ir-review-summary-skipped-type')),
        ]);
        expect(rows).toEqual(
          found.map(({ basename, type }) => [basename, type])
        );
      })
    );
  });

  it('looks the skipped items up by the ids the store holds as skipped', () => {
    fc.assert(
      fc.property(summaryArb, (c) => {
        const { useReviewItems, seenIds } = renderSummary(c);

        expect(useReviewItems).toHaveBeenCalled();
        for (const [ids] of useReviewItems.mock.calls) {
          expect(ids).toEqual(Object.keys(seenIds));
        }
      })
    );
  });

  it('says how many cards come due later today once there are any, whether or not anything was reviewed', () => {
    fc.assert(
      fc.property(summaryArb, (c) => {
        const { container } = renderSummary(c);

        const line = container.querySelector('.ir-review-summary-due-later');
        const count = c.dueLaterToday ?? 0;
        // None, still counting, or a session that leaves cards out, where
        // they would never come back
        if (count === 0 || !c.reviewsCards) {
          expect(line).toBeNull();
          return;
        }
        expect(text(line)).toMatch(countOf(count, 'card'));
      })
    );
  });

  it('closes the review tab when asked, and not before', () => {
    fc.assert(
      fc.property(summaryArb, (c) => {
        const { container, detach } = renderSummary(c);

        expect(detach).not.toHaveBeenCalled();
        closeButton(container).click();
        expect(detach).toHaveBeenCalledTimes(1);
      })
    );
  });
});
