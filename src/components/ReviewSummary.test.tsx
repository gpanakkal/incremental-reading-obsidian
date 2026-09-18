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

/**
 * The row each kind of review gets, in display order, labelled for a count of
 * one and for any other count.
 */
const COUNT_LABELS: ReadonlyArray<[NoteType, string, string]> = [
  ['article', 'Article', 'Articles'],
  ['snippet', 'Snippet', 'Snippets'],
  ['card', 'Card', 'Cards'],
];

const skippedItemArb = fc.record({
  id: fc.string(),
  type: noteTypeArb,
  basename: fc.string(),
});

/**
 * One case: the reviews the store counted, the ids it holds as skipped, and
 * what looking those ids up has produced so far — nothing while it is still
 * running, and otherwise any list at all, since the lookup drops ids whose
 * items are gone.
 */
const summaryArb = fc.record({
  completed: fc.dictionary(fc.string(), noteTypeArb),
  skippedIds: fc.uniqueArray(fc.string()),
  skippedItems: fc.option(fc.array(skippedItemArb), { nil: undefined }),
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
function renderSummary({ completed, skippedIds, skippedItems }: SummaryCase) {
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
  const useReviewItems = vi
    .spyOn(ReactQuery, 'useReviewItems')
    .mockReturnValue({ data: skippedItems?.map(makeItem) } as never);
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
        const { container } = renderSummary(c);

        const hadSession =
          Object.keys(c.completed).length > 0 || c.skippedIds.length > 0;
        expect(text(container.querySelector('h2'))).toBe(
          hadSession ? 'Review complete' : 'Nothing due for review.'
        );
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
        expect(text(total)).toBe(
          types.length === 1
            ? '1 item reviewed'
            : `${types.length} items reviewed`
        );
        expect(counts).toEqual(
          COUNT_LABELS.map(([type, singular, plural]) => {
            const countOfType = types.filter((t) => t === type).length;
            return [countOfType === 1 ? singular : plural, String(countOfType)];
          })
        );
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
        expect(text(section?.querySelector('h3'))).toBe(
          `Skipped (${found.length})`
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
