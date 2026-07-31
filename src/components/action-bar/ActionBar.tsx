import { useAppSelector } from '#/hooks/useAppSelector';
import { useCurrentItem } from '#/hooks/useReactQuery';
import { setPage, setShowAnswer } from '#/lib/store';
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
import {
  ArchiveRestore,
  Ban,
  BrainCog,
  Check,
  Eye,
  House,
  Scissors,
  SkipForward,
  Trash2,
} from 'lucide-react';
import { useDispatch } from 'react-redux';
import { Rating } from 'ts-fsrs';
import { useReviewContext } from '../ReviewContext';
import { ButtonWithIcon, TextButton } from './BarButtons';
import { FixedIntervalField } from './FixedIntervalField';
import { PriorityField } from './PriorityField';
import { ReviewTypeFilter } from './ReviewTypeFilter';
import { TextScheduler } from './TextScheduler';

export function ActionBar() {
  const page = useAppSelector((state) => state.page);
  const { data: currentItem } = useCurrentItem();
  const dispatch = useDispatch();

  return (
    <div className="ir-action-bar" tabIndex={-1}>
      {/* setting a tabIndex makes the action bar focusable */}
      {page === 'home' ? (
        <HomeActions />
      ) : (
        <>
          <ButtonWithIcon
            tooltip="Go to home screen"
            handleClick={() => {
              dispatch(setPage('home'));
            }}
          >
            <House />
          </ButtonWithIcon>
          <ReviewTypeFilter />
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
        </>
      )}
      <GlobalActions />
    </div>
  );
}

function HomeActions() {
  const dispatch = useDispatch();

  return (
    <TextButton
      tooltip="Start reviewing the queue"
      id="begin-review-button"
      handleClick={() => {
        dispatch(setPage('review'));
      }}
    >
      Begin Review
    </TextButton>
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
        <ButtonWithIcon
          tooltip="Restore item to queue"
          handleClick={async () => await actions.unDismissItem(reviewItem)}
        >
          <ArchiveRestore stroke="#b4a200" />
        </ButtonWithIcon>
      ) : (
        <ButtonWithIcon
          tooltip="Stop scheduling this item for review"
          handleClick={async () => await actions.dismissItem(reviewItem)}
        >
          <Ban stroke="#b4a200" />
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
            🔁 Forgot
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
