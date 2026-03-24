import { useEffect, useState } from 'preact/hooks';
import { useDispatch } from 'react-redux';
import { Rating } from 'ts-fsrs';
import { useAppSelector } from '#/hooks/useAppSelector';
import { useCurrentItem } from '#/hooks/useReactQuery';
import { setShowAnswer } from '#/lib/store';
import type { ReviewItem } from '#/lib/types';
import {
  isReviewCard,
  type ReviewCard,
  type ReviewSnippet,
  type ReviewArticle,
  isReviewArticle,
  isReviewSnippet,
} from '#/lib/types';
import { transformPriority } from '#/lib/utils';
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
  const { dismissItem, unDismissItem, skipItem } = useReviewContext();
  const isDismissed = reviewItem.data.dismissed;

  return (
    <>
      {isDismissed ? (
        <Button
          label="Un-dismiss"
          tooltip="Restore item to queue"
          handleClick={async () => await unDismissItem(reviewItem)}
        />
      ) : (
        <Button
          label="Dismiss"
          tooltip="Stop scheduling this item for review"
          handleClick={async () => await dismissItem(reviewItem)}
        />
      )}
      <Button
        label={'Skip'}
        tooltip="Skip for current review session"
        handleClick={() => {
          skipItem(reviewItem);
        }}
      />
    </>
  );
}

/**
 * TODO:
 * - manual scheduling
 */
function ArticleActions({ article: article }: { article: ReviewArticle }) {
  const [display, setDisplay] = useState({
    priority: article.data.priority / 10,
  });
  const { reviewArticle, reprioritize } = useReviewContext();

  const updateDisplay = (updates: Partial<typeof display>) => {
    setDisplay((prev) => ({ ...prev, ...updates }));
  };

  useEffect(() => {
    setDisplay({ priority: article.data.priority / 10 });
  }, [article]);

  return (
    <>
      <Button
        label="Continue"
        tooltip="Mark article as reviewed and go to the next"
        handleClick={async () => await reviewArticle(article)}
      />
      <label className={'ir-priority-label'}>
        Priority
        <input
          id={'ir-priority-input'}
          value={display.priority}
          className={'ir-priority-input'}
          type="text"
          inputMode="decimal"
          onChange={(e) => {
            const transformed = transformPriority(e.currentTarget.value);
            updateDisplay({ priority: transformed / 10 });
          }}
          onBlur={() => {
            void reprioritize(article, display.priority);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              void reprioritize(article, display.priority);
            } else if (e.key === 'Escape') {
              updateDisplay({ priority: article.data.priority });
              e.currentTarget.select();
            }
          }}
          onFocus={(e) => e.currentTarget.select()}
        />
      </label>
    </>
  );
}

/**
 * TODO:
 * - manual scheduling
 */
function SnippetActions({ snippet }: { snippet: ReviewSnippet }) {
  const [display, setDisplay] = useState({
    priority: snippet.data.priority / 10,
  });
  const { reviewSnippet, reprioritize } = useReviewContext();

  const updateDisplay = (updates: Partial<typeof display>) => {
    setDisplay((prev) => ({ ...prev, ...updates }));
  };

  useEffect(() => {
    setDisplay({ priority: snippet.data.priority / 10 });
  }, [snippet]);

  return (
    <>
      <Button
        label="Continue"
        tooltip="Mark snippet as reviewed and go to the next"
        handleClick={async () => await reviewSnippet(snippet)}
      />
      <div className="ir-priority-container">
        <label className={'ir-priority-label'}>
          Priority
          <input
            id={'ir-priority-input'}
            value={display.priority}
            className={'ir-priority-input'}
            type="text"
            inputMode="decimal"
            onChange={(e) => {
              const transformed = transformPriority(e.currentTarget.value);
              updateDisplay({ priority: transformed / 10 });
            }}
            onBlur={() => void reprioritize(snippet, display.priority)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void reprioritize(snippet, display.priority);
              } else if (e.key === 'Escape') {
                updateDisplay({ priority: snippet.data.priority });
                e.currentTarget.select();
              }
            }}
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
      </div>
    </>
  );
}

function CardActions({ card }: { card: ReviewCard }) {
  const dispatch = useDispatch();
  const showAnswer = useAppSelector((state) => state.showAnswer);
  const { gradeCard } = useReviewContext();

  return (
    <>
      {showAnswer ? (
        <>
          <Button
            label="🔁 Again"
            handleClick={async () => await gradeCard(card, Rating.Again)}
          />
          <Button
            label="👎 Hard"
            handleClick={async () => await gradeCard(card, Rating.Hard)}
          />
          <Button
            label="👍 Good"
            handleClick={async () => await gradeCard(card, Rating.Good)}
          />
          <Button
            label="✅ Easy"
            handleClick={async () => await gradeCard(card, Rating.Easy)}
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
