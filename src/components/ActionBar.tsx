import { useAppSelector } from '#/hooks/useAppSelector';
import { useCurrentItem } from '#/hooks/useReactQuery';
import { setShowAnswer } from '#/lib/store';
import type { ReviewItem } from '#/lib/types';
import {
  isReviewArticle,
  isReviewCard,
  isReviewSnippet,
  type ReviewArticle,
  type ReviewCard,
  type ReviewSnippet,
} from '#/lib/types';
import { useDispatch } from 'react-redux';
import { Rating } from 'ts-fsrs';
import { PriorityField } from './PriorityField';
import { useReviewContext } from './ReviewContext';

export function ActionBar() {
  const { data: currentItem } = useCurrentItem();

  return (
    <div className="ir-action-bar" tabIndex={-1}>
      {/* setting a tabIndex makes the action bar focusable */}
      {currentItem && (
        <>
          {isReviewCard(currentItem) && <CardActions card={currentItem} />}
          {isReviewArticle(currentItem) && (
            <ArticleActions article={currentItem} />
          )}
          {isReviewSnippet(currentItem) && (
            <SnippetActions snippet={currentItem} />
          )}
          <ItemActions reviewItem={currentItem} />
        </>
      )}
      <GlobalActions />
    </div>
  );
}

/**
 * TODO:
 * - always render ActionBar once a global action exists
 * - forward/back (or use the view header)
 * - view queue
 * - undo last review/dismissal
 */
function GlobalActions() {
  return <></>;
}

/**
 * Actions common to articles, snippets, and cards
 */
function ItemActions({ reviewItem }: { reviewItem: ReviewItem }) {
  const { actions } = useReviewContext();
  const isDismissed = reviewItem.data.dismissed;

  return (
    <>
      {isDismissed ? (
        <Button
          label="Un-dismiss"
          tooltip="Restore item to queue"
          handleClick={async () => await actions.unDismissItem(reviewItem)}
        />
      ) : (
        <Button
          label="Dismiss"
          tooltip="Stop scheduling this item for review"
          handleClick={async () => await actions.dismissItem(reviewItem)}
        />
      )}
      <Button
        label={'Skip'}
        tooltip="Skip for current review session"
        handleClick={() => {
          actions.skipItem(reviewItem);
        }}
      />
      <Button
        label={'Snip'}
        tooltip="Extract selected text to a new snippet"
        handleClick={async () => {
          await actions.createSnippet();
        }}
      />
      <Button
        label={'Create card'}
        // tooltip="Create card"
        handleClick={async () => {
          await actions.createCard();
        }}
      />
    </>
  );
}

/**
 * TODO:
 * - manual scheduling
 */
function ArticleActions({ article }: { article: ReviewArticle }) {
  const { actions } = useReviewContext();

  return (
    <>
      <Button
        label="Continue"
        tooltip="Mark article as reviewed and go to the next"
        handleClick={async () => await actions.reviewArticle(article)}
      />
      <PriorityField item={article} />
    </>
  );
}

/**
 * TODO:
 * - manual scheduling
 */
function SnippetActions({ snippet }: { snippet: ReviewSnippet }) {
  const { actions } = useReviewContext();

  return (
    <>
      <Button
        label="Continue"
        tooltip="Mark snippet as reviewed and go to the next"
        handleClick={async () => await actions.reviewSnippet(snippet)}
      />
      <PriorityField item={snippet} />
    </>
  );
}

function CardActions({ card }: { card: ReviewCard }) {
  const dispatch = useDispatch();
  const showAnswer = useAppSelector((state) => state.showAnswer);
  const { actions } = useReviewContext();

  return (
    <>
      {showAnswer ? (
        <>
          <Button
            label="🔁 Again"
            handleClick={async () =>
              await actions.gradeCard(card, Rating.Again)
            }
          />
          <Button
            label="👎 Hard"
            handleClick={async () => await actions.gradeCard(card, Rating.Hard)}
          />
          <Button
            label="👍 Good"
            handleClick={async () => await actions.gradeCard(card, Rating.Good)}
          />
          <Button
            label="✅ Easy"
            handleClick={async () => await actions.gradeCard(card, Rating.Easy)}
          />
        </>
      ) : (
        <>
          <Button
            label="Show Answer"
            handleClick={() => {
              dispatch(setShowAnswer(true));
            }}
          />
        </>
      )}
    </>
  );
}

function Button({
  label,
  handleClick,
  disabled,
  tooltip,
}: {
  label: string;
  handleClick: (e: MouseEvent) => Promise<void> | void;
  disabled?: boolean;
  tooltip?: string;
}) {
  return (
    <button
      className="ir-review-button"
      onClick={(e) => void handleClick(e)}
      title={tooltip}
      disabled={disabled}
    >
      {label}
    </button>
  );
}
