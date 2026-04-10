import { useAppSelector } from '#/hooks/useAppSelector';
import { useCurrentItem } from '#/hooks/useReactQuery';
import { setShowAnswer } from '#/lib/store';
import type { ReviewItem, ReviewText } from '#/lib/types';
import {
  isReviewArticle,
  isReviewCard,
  isReviewSnippet,
  isReviewText,
  type ReviewArticle,
  type ReviewCard,
  type ReviewSnippet,
} from '#/lib/types';
import { SchedulingModal } from '#/views/SchedulingModal';
import { CalendarSync } from 'lucide-react';
import { useDispatch } from 'react-redux';
import { Rating } from 'ts-fsrs';
import { useReviewContext } from '../ReviewContext';
import { FixedIntervalField } from './FixedIntervalField';
import { PriorityField } from './PriorityField';

export function ActionBar() {
  const { data: currentItem } = useCurrentItem();

  return (
    <div className="ir-action-bar" tabIndex={-1}>
      {/* setting a tabIndex makes the action bar focusable */}
      {currentItem && (
        <>
          {isReviewCard(currentItem) && <CardActions card={currentItem} />}
          {isReviewText(currentItem) && <TextActions text={currentItem} />}
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
          tooltip="Restore item to queue"
          handleClick={async () => await actions.unDismissItem(reviewItem)}
        >
          Un-dismis
        </Button>
      ) : (
        <Button
          tooltip="Stop scheduling this item for review"
          handleClick={async () => await actions.dismissItem(reviewItem)}
        >
          Dismiss
        </Button>
      )}
      <Button
        tooltip="Extract selected text to a new snippet"
        handleClick={async () => {
          await actions.createSnippet();
        }}
      >
        Snip
      </Button>
      <Button
        // tooltip="Create card"
        handleClick={async () => {
          await actions.createCard();
        }}
      >
        Create card
      </Button>
    </>
  );
}

/**
 * Actions shared by articles and snippets.
 * TODO:
 * - overflow menu
 */
function TextActions({ text }: { text: ReviewText }) {
  const { actions } = useReviewContext();

  return (
    <>
      <Button
        tooltip="Mark as reviewed and go to the next"
        handleClick={async () => await actions.review(text)}
      >
        Continue
      </Button>
      <Button
        tooltip="Skip for current review session"
        handleClick={() => {
          actions.skipItem(text);
        }}
      >
        Skip
      </Button>
      <TextScheduler text={text} />
    </>
  );
}

/**
 * Field to set the priority or fixed interval plus a button to open a
 * SchedulingModal
 */
function TextScheduler({ text }: { text: ReviewText }) {
  const { plugin, actions } = useReviewContext();
  const strategy =
    text.data.type === 'article' && text.data.fixed_interval_days !== null
      ? 'fixed'
      : 'priority';

  return (
    <>
      {strategy === 'priority' && (
        <PriorityField
          key={text.data.id}
          onBlur={async (priority: number) => {
            await actions.reprioritize(text, priority);
          }}
          initialPriority={text.data.priority}
        />
      )}
      {strategy === 'fixed' && (
        <FixedIntervalField
          key={text.data.id}
          onBlur={async (intervalDays: number) => {
            await actions.manageFixedInterval(text as ReviewArticle, {
              newIntervalDays: intervalDays,
            });
          }}
          initialInterval={(text as ReviewArticle).data.fixed_interval_days}
        />
      )}
      <Button
        tooltip="Change scheduling strategy"
        handleClick={() => {
          new SchedulingModal(plugin, text).open();
        }}
      >
        <CalendarSync />
      </Button>
    </>
  );
}

/**
 * TODO:
 * - manual scheduling
 */
function ArticleActions({ article: _article }: { article: ReviewArticle }) {
  return <></>;
}

function SnippetActions({ snippet: _snippet }: { snippet: ReviewSnippet }) {
  return <></>;
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
            handleClick={async () =>
              await actions.gradeCard(card, Rating.Again)
            }
          >
            🔁 Again
          </Button>
          <Button
            handleClick={async () => await actions.gradeCard(card, Rating.Hard)}
          >
            👎 Hard
          </Button>
          <Button
            handleClick={async () => await actions.gradeCard(card, Rating.Good)}
          >
            👍 Good
          </Button>
          <Button
            handleClick={async () => await actions.gradeCard(card, Rating.Easy)}
          >
            ✅ Easy
          </Button>
        </>
      ) : (
        <>
          <Button
            handleClick={() => {
              dispatch(setShowAnswer(true));
            }}
          >
            Show Answer
          </Button>
          <Button
            tooltip="Skip for current review session"
            handleClick={() => {
              actions.skipItem(card);
            }}
          >
            Skip
          </Button>
        </>
      )}
    </>
  );
}

function Button({
  children,
  handleClick,
  disabled,
  tooltip,
}: React.PropsWithChildren<{
  handleClick: (e: MouseEvent) => Promise<void> | void;
  disabled?: boolean;
  tooltip?: string;
}>) {
  return (
    <button
      className="ir-review-button"
      onClick={(e) => void handleClick(e)}
      title={tooltip}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
