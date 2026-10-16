import { useAppSelector } from '#/hooks/useAppSelector';
import { useCardsDueLaterToday, useReviewItems } from '#/hooks/useReactQuery';
import { getCompletedReviews, getSeenIds, reviewsCards } from '#/lib/store';
import type { NoteType } from '#/lib/types';
import { useReviewContext } from './ReviewContext';

/** Display order and label for each kind of review counted. */
const REVIEW_TYPES: ReadonlyArray<{ type: NoteType; label: string }> = [
  { type: 'article', label: 'Article' },
  { type: 'snippet', label: 'Snippet' },
  { type: 'card', label: 'Card' },
];

/**
 * What review shows once the queue has nothing left for it: a summary of the
 * session that emptied it, and a way out of the tab.
 *
 * "Nothing due" and "session complete" are the same screen, told apart only by
 * whether anything happened first. A tab opened onto an already-empty queue has
 * no session to sum up, so it keeps the plain empty-queue message rather than a
 * row of zeroes.
 *
 * Skipped items are listed by name, read back from the database: the store only
 * holds their ids. One deleted since it was skipped has nothing to name and is
 * left off.
 *
 * Cards in a learning step can come back before the review day is out, and the
 * screen says how many will, whether or not this session reviewed any. Not in a
 * session that leaves cards out, though: none would come back to it.
 */
export function ReviewSummary() {
  const { reviewView } = useReviewContext();
  const completedReviews = useAppSelector(getCompletedReviews);
  const skippedIds = Object.keys(useAppSelector(getSeenIds));
  const { data: skippedItems = [] } = useReviewItems(skippedIds);
  const { data: dueLaterToday = 0 } = useCardsDueLaterToday();
  const showDueLater = useAppSelector(reviewsCards) && dueLaterToday > 0;

  const reviewTypes = Object.values(completedReviews);
  const hasActivity = reviewTypes.length > 0 || skippedIds.length > 0;

  return (
    <div className="ir-review-summary">
      <h2 className="ir-review-summary-heading">
        {hasActivity ? 'Review complete' : 'Nothing due for review.'}
      </h2>
      {hasActivity && (
        <>
          <p className="ir-review-summary-total">
            {reviewTypes.length === 1
              ? '1 item reviewed'
              : `${reviewTypes.length} items reviewed`}
          </p>
          <dl className="ir-review-summary-counts">
            {REVIEW_TYPES.map(({ type, label }) => {
              const countOfType = reviewTypes.filter((t) => t === type).length;
              return (
                <div className="ir-review-summary-count" key={type}>
                  <dd>{countOfType}</dd>
                  <dt>{label + (countOfType === 1 ? '' : 's')}</dt>
                </div>
              );
            })}
          </dl>
        </>
      )}
      {showDueLater && (
        <p className="ir-review-summary-due-later">
          {dueLaterToday === 1
            ? '1 more card comes due later today.'
            : `${dueLaterToday} more cards come due later today.`}
        </p>
      )}
      {skippedItems.length > 0 && (
        <section className="ir-review-summary-skipped">
          <h3>Skipped ({skippedItems.length})</h3>
          <ul>
            {skippedItems.map((item) => (
              <li key={item.data.id}>
                <span className="ir-review-summary-skipped-name">
                  {item.file.basename}
                </span>
                <span className="ir-review-summary-skipped-type">
                  {item.data.type}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <button
        className="mod-cta"
        onClick={() => {
          reviewView.leaf.detach();
        }}
      >
        Close tab
      </button>
    </div>
  );
}
