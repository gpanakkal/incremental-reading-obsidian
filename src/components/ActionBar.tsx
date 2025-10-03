import type { ReviewItem } from '#/db/types';
import { isReviewCard, type ReviewCard, type ReviewSnippet } from '#/db/types';
import { Rating } from 'ts-fsrs';
import { useReviewContext } from './ReviewContext';
import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  ERROR_NOTICE_DURATION_MS,
  SUCCESS_NOTICE_DURATION_MS,
} from '#/lib/constants';

export function ActionBar() {
  const { currentItem } = useReviewContext();
  return (
    <div className="ir-review-button-container">
      {currentItem && (
        <>
          {isReviewCard(currentItem) ? (
            <CardActions card={currentItem} />
          ) : (
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
  const { currentItem, reviewQueue, getNext } = useReviewContext();
  return (
    <>
      <Button
        label={currentItem ? 'Skip' : 'Begin Review'}
        handleClick={() => {
          getNext();
        }}
        disabled={!reviewQueue}
      />
    </>
  );
}

/**
 * TODO:
 * - go to parent
 */
function ItemActions({ reviewItem }: { reviewItem: ReviewItem }) {
  const { dismissItem } = useReviewContext();
  return (
    <>
      <Button
        label="Dismiss"
        handleClick={async () => await dismissItem(reviewItem)}
      />
    </>
  );
}

/** Clamp display value and convert to integer */
const transformPriority = (rawPriority: string | number) => {
  const priorityNum = Number(rawPriority);
  if (Number.isNaN(priorityNum)) {
    throw new TypeError(`Priority cannot be NaN`);
  }

  let withDecimal = Number(priorityNum.toString().slice(0, 3));
  while (withDecimal >= 10) {
    withDecimal = withDecimal / 10;
  }
  const clamped = Math.min(5, Math.max(1, withDecimal));
  const rounded = Math.round(clamped * 10);
  return rounded;
};

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
