import type { ReviewItem } from '#/lib/types';
import {
  isReviewCard,
  type ReviewCard,
  type ReviewSnippet,
  type ReviewArticle,
  isReviewArticle,
  isReviewSnippet,
} from '#/lib/types';
import { Rating } from 'ts-fsrs';
import { useReviewContext } from './ReviewContext';
import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  ERROR_NOTICE_DURATION_MS,
  SUCCESS_NOTICE_DURATION_MS,
} from '#/lib/constants';
import { transformPriority } from '#/lib/utils';

export function ActionBar() {
  const { currentItem } = useReviewContext();
  return (
    <div className="ir-action-bar">
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
 * - forward/back
 * - view queue
 * - undo last review
 */
function GlobalActions() {
  return <></>;
}

/**
 * TODO:
 * - go to parent
 */
function ItemActions({ reviewItem }: { reviewItem: ReviewItem }) {
  const { dismissItem, skipItem } = useReviewContext();
  return (
    <>
      <Button
        label="Dismiss"
        handleClick={async () => await dismissItem(reviewItem)}
      />
      <Button
        label={'Skip'}
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
  const { reviewArticle, reviewManager } = useReviewContext();

  const updateDisplay = (updates: Partial<typeof display>) => {
    setDisplay((prev) => ({ ...prev, ...updates }));
  };

  const updatePriority = useCallback(async () => {
    const priority = transformPriority(display.priority);
    try {
      await reviewManager.reprioritizeArticle(article.data, priority);
      new Notice(
        `Priority set to ${priority / 10}`,
        SUCCESS_NOTICE_DURATION_MS
      );
    } catch (error) {
      new Notice(
        `Failed to update priority for snippet ${article.data.id} at ${article.data.reference}`,
        ERROR_NOTICE_DURATION_MS
      );
    }
  }, [display]);

  return (
    <>
      <Button
        label="Continue"
        handleClick={async () => await reviewArticle(article.data)}
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
          onBlur={async (e) => await updatePriority()}
          onKeyDown={async (e) => {
            if (e.key === 'Enter') {
              await updatePriority();
            } else if (e.key === 'Escape') {
              updateDisplay({ priority: article.data.priority });
              e.currentTarget.select();
            }
          }}
          onFocusIn={(e) => e.currentTarget.select()}
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
  const { reviewSnippet, reviewManager } = useReviewContext();

  const updateDisplay = (updates: Partial<typeof display>) => {
    setDisplay((prev) => ({ ...prev, ...updates }));
  };

  const updatePriority = useCallback(async () => {
    const priority = transformPriority(display.priority);
    try {
      await reviewManager.reprioritizeSnippet(snippet.data, priority);
      new Notice(
        `Priority set to ${priority / 10}`,
        SUCCESS_NOTICE_DURATION_MS
      );
    } catch (error) {
      new Notice(
        `Failed to update priority for snippet ${snippet.data.id} at ${snippet.data.reference}`,
        ERROR_NOTICE_DURATION_MS
      );
    }
  }, [display]);

  return (
    <>
      <Button
        label="Continue"
        handleClick={async () => await reviewSnippet(snippet.data)}
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
            onBlur={async (e) => await updatePriority()}
            onKeyDown={async (e) => {
              if (e.key === 'Enter') {
                await updatePriority();
              } else if (e.key === 'Escape') {
                updateDisplay({ priority: snippet.data.priority });
                e.currentTarget.select();
              }
            }}
            onFocusIn={(e) => e.currentTarget.select()}
          />
        </label>
      </div>
    </>
  );
}

function CardActions({ card }: { card: ReviewCard }) {
  const { gradeCard, showAnswer, setShowAnswer } = useReviewContext();
  return (
    <>
      {showAnswer ? (
        <>
          <Button
            label="🔁 Again"
            handleClick={async () => await gradeCard(card.data, Rating.Again)}
          />
          <Button
            label="👎 Hard"
            handleClick={async () => await gradeCard(card.data, Rating.Hard)}
          />
          <Button
            label="👍 Good"
            handleClick={async () => await gradeCard(card.data, Rating.Good)}
          />
          <Button
            label="✅ Easy"
            handleClick={async () => await gradeCard(card.data, Rating.Easy)}
          />
        </>
      ) : (
        <>
          <Button
            label="Show Answer"
            handleClick={() => {
              setShowAnswer(true);
            }}
          />
        </>
      )}
      {/* <Button label="Edit" handleClick={() => setShowAnswer(true)} /> */}
    </>
  );
}

function Button({
  label,
  handleClick,
  disabled,
}: {
  label: string;
  handleClick: (e: MouseEvent) => Promise<void> | void;
  disabled?: boolean;
}) {
  return (
    <button
      className="ir-review-button"
      onClick={handleClick}
      disabled={disabled}
    >
      {label}
    </button>
  );
}
