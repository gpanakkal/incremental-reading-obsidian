import { useAppSelector } from '#/hooks/useAppSelector';
import { cardsOnly } from '#/lib/store';
import { useReviewContext } from '../ReviewContext';

export function ReviewTypeFilter() {
  const { actions } = useReviewContext();
  const typesToReview = useAppSelector((state) => state.typesToReview);
  const showCardsOnly = cardsOnly({ typesToReview });

  return (
    <div className="ir-toggle">
      <label className="ir-toggle-label">
        {showCardsOnly ? 'Cards only' : 'All items'}
        <div
          className={
            'checkbox-container' + (showCardsOnly ? ' is-enabled' : '')
          }
        >
          <input
            type="checkbox"
            title="Choose what to review"
            checked={showCardsOnly}
            onChange={(e) => void actions.setCardsOnly(e.currentTarget.checked)}
          />
        </div>
      </label>
    </div>
  );
}
