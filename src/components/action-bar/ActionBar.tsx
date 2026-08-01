import { useAppSelector } from '#/hooks/useAppSelector';
import { useCurrentItem, useQueue } from '#/hooks/useReactQuery';
import { QUEUE_TABLE_DEFAULT_ENTRIES_PER_PAGE } from '#/lib/constants';
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
import { ButtonWithIcon, Separator, TextButton } from './BarButtons';
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
          <Separator />
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
  // The same slice the queue table asks for, so both read one cache entry
  // under the ['queue', subset] key rather than each fetching the queue.
  // React Query compares keys structurally, so the matching shape is enough.
  const { data, isLoading } = useQueue({
    slice: {
      pageNumber: 0,
      entriesPerPage: QUEUE_TABLE_DEFAULT_ENTRIES_PER_PAGE,
    },
  });

  // An empty queue is an empty *due* queue (getQueue returns only due items),
  // so this is the same condition that puts "Nothing due for review" on the
  // screen below, and the two cannot disagree. Held disabled while loading as
  // well, since a button that starts a review of an unknown queue is worse
  // than one that is briefly inert.
  const nothingDue = isLoading || !data || data.totalRows === 0;

  return (
    <TextButton
      tooltip={
        nothingDue ? 'Nothing due for review' : 'Start reviewing the queue'
      }
      id="begin-review-button"
      disabled={nothingDue}
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
      <Separator />
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
