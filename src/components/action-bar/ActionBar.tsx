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
import {
  ArchiveRestore,
  Ban,
  BrainCog,
  CalendarSync,
  Check,
  Eye,
  Scissors,
  SkipForward,
  Trash2,
} from 'lucide-react';
import { useDispatch } from 'react-redux';
import { Rating } from 'ts-fsrs';
import { useReviewContext } from '../ReviewContext';
import { FixedIntervalField } from './FixedIntervalField';
import { PriorityField } from './PriorityField';
import { ReviewTypeFilter } from './ReviewTypeFilter';

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
  return (
    <>
      <ReviewTypeFilter />
    </>
  );
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
        <ButtonWithIcon
          tooltip="Restore item to queue"
          handleClick={async () => await actions.unDismissItem(reviewItem)}
        >
          <ArchiveRestore stroke="#b46000" />
        </ButtonWithIcon>
      ) : (
        <ButtonWithIcon
          tooltip="Stop scheduling this item for review"
          handleClick={async () => await actions.dismissItem(reviewItem)}
        >
          <Ban stroke="#b46000" />
        </ButtonWithIcon>
      )}
      <ButtonWithIcon
        tooltip="Delete this item and its note"
        handleClick={async () => {
          await actions.deleteItem(reviewItem);
        }}
      >
        <Trash2 stroke="#990000" />
      </ButtonWithIcon>
      <ButtonWithIcon
        tooltip="Extract selected text to a new snippet"
        handleClick={async () => {
          await actions.createSnippet();
        }}
      >
        <Scissors />
      </ButtonWithIcon>
      <ButtonWithIcon
        tooltip="Create card"
        handleClick={async () => {
          await actions.createCard();
        }}
      >
        <BrainCog />
      </ButtonWithIcon>
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
      <ButtonWithIcon
        tooltip="Mark as reviewed"
        handleClick={async () => await actions.review(text)}
      >
        <Check stroke="#00a700" />
      </ButtonWithIcon>
      <ButtonWithIcon
        tooltip="Skip for current review session"
        handleClick={() => {
          actions.skipItem(text);
        }}
      >
        <SkipForward />
      </ButtonWithIcon>
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
      <ButtonWithIcon
        tooltip="Change scheduling strategy"
        handleClick={() => {
          new SchedulingModal(plugin, text).open();
        }}
      >
        <CalendarSync />
      </ButtonWithIcon>
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
          <ButtonWithIcon
            handleClick={async () =>
              await actions.gradeCard(card, Rating.Again)
            }
          >
            🔁 Again
          </ButtonWithIcon>
          <ButtonWithIcon
            handleClick={async () => await actions.gradeCard(card, Rating.Hard)}
          >
            👎 Hard
          </ButtonWithIcon>
          <ButtonWithIcon
            handleClick={async () => await actions.gradeCard(card, Rating.Good)}
          >
            👍 Good
          </ButtonWithIcon>
          <ButtonWithIcon
            handleClick={async () => await actions.gradeCard(card, Rating.Easy)}
          >
            ✅ Easy
          </ButtonWithIcon>
        </>
      ) : (
        <>
          <ButtonWithIcon
            tooltip="Show answer"
            handleClick={() => {
              dispatch(setShowAnswer(true));
            }}
          >
            <Eye />
          </ButtonWithIcon>
          <ButtonWithIcon
            tooltip="Skip for current review session"
            handleClick={() => {
              actions.skipItem(card);
            }}
          >
            <SkipForward />
          </ButtonWithIcon>
        </>
      )}
    </>
  );
}

function ButtonWithIcon({
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
      className="ir-review-button clickable-icon"
      onClick={(e) => void handleClick(e)}
      title={tooltip}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function TextButton({
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
