import { CardCog } from '#/components/icons/CardCog';
import { useAppSelector } from '#/hooks/useAppSelector';
import { useLeafHistory } from '#/hooks/useLeafHistory';
import { useCurrentItem, useQueue } from '#/hooks/useReactQuery';
import type { ActionStackEntry } from '#/lib/Actions';
import { QUEUE_TABLE_DEFAULT_ENTRIES_PER_PAGE } from '#/lib/constants';
import { setPage, setShowAnswer } from '#/lib/store';
import {
  isReviewArticle,
  isReviewCard,
  isReviewSnippet,
  type ReviewArticle,
  type ReviewCard,
  type ReviewItem,
  type ReviewSnippet,
  type ReviewText,
} from '#/lib/types';
import {
  ArchiveRestore,
  ArrowLeft,
  ArrowRight,
  Ban,
  Check,
  EllipsisVertical,
  Eye,
  House,
  Scissors,
  SkipForward,
  Undo2,
} from 'lucide-react';
import { useSyncExternalStore } from 'react';
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
      <GlobalActions />
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
          <UndoAction />
          {currentItem && (
            <>
              {isReviewArticle(currentItem) && (
                <ArticleActions article={currentItem} />
              )}
              {isReviewSnippet(currentItem) && (
                <SnippetActions snippet={currentItem} />
              )}
              {isReviewCard(currentItem) && <CardActions card={currentItem} />}
            </>
          )}
        </>
      )}
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
 * Actions that belong to the tab rather than to the item inside it: back and
 * forward through the tab's history.
 *
 * Desktop only. They stand in for the arrows Obsidian draws at the start of the
 * view header, which `ReviewView` hides on desktop — so they lead the bar, as
 * the ⋮ standing in for the header's closes it. Mobile keeps its header, and the
 * navbar's own buttons besides.
 *
 * Like the header's arrows, they hold the bar's start edge while the rest of it
 * centers. `ir-bar-nav` is what exempts them from the centering in styles.css.
 */
function GlobalActions() {
  const { plugin, reviewView } = useReviewContext();
  const { leaf } = reviewView;
  const { canGoBack, canGoForward } = useLeafHistory(leaf);
  if (plugin.app.isMobile) return null;

  return (
    <>
      <ButtonWithIcon
        tooltip="Navigate back"
        id="navigate-back-button"
        className="ir-bar-nav"
        disabled={!canGoBack}
        handleClick={async () => {
          await leaf.history.back();
        }}
      >
        <ArrowLeft />
      </ButtonWithIcon>
      <ButtonWithIcon
        tooltip="Navigate forward"
        id="navigate-forward-button"
        className="ir-bar-nav"
        disabled={!canGoForward}
        handleClick={async () => {
          await leaf.history.forward();
        }}
      >
        <ArrowRight />
      </ButtonWithIcon>
      <Separator className="ir-bar-nav" />
    </>
  );
}

/**
 * Reverses the most recent undoable action.
 *
 * The stack lives on the `Actions` instance rather than in the store, since its
 * entries hold closures, so it announces its own changes and this subscribes.
 * Rendering off the store instead would miss the actions that change no store
 * state — creating a snippet, notably.
 */
function UndoAction() {
  const { actions } = useReviewContext();
  // The top entry, not the stack: `push`/`pop` mutate the array in place, so
  // its reference never changes and every snapshot would compare equal. The
  // entry is a fresh object per action and is all this button renders, so its
  // identity changes exactly when the button's appearance should.
  const lastAction: ActionStackEntry | undefined = useSyncExternalStore(
    actions.subscribe,
    () => actions.undoStack[actions.undoStack.length - 1]
  );

  return (
    <ButtonWithIcon
      tooltip={
        lastAction ? `Undo ${lastAction.description}` : 'Nothing to undo'
      }
      id="undo-button"
      disabled={lastAction === undefined}
      handleClick={async () => {
        await actions.undo();
      }}
    >
      <Undo2 />
    </ButtonWithIcon>
  );
}

function ArticleActions({ article }: { article: ReviewArticle }) {
  return (
    <>
      <MarkReviewedAction text={article} />
      <SkipAction item={article} />
      <ExtractSnippetAction />
      <CreateCardAction />
      <Separator />
      <TextScheduler text={article} />
      <Separator />
      <DismissAction item={article} />
      <MoreOptionsAction />
    </>
  );
}

function SnippetActions({ snippet }: { snippet: ReviewSnippet }) {
  return (
    <>
      <MarkReviewedAction text={snippet} />
      <SkipAction item={snippet} />
      <ExtractSnippetAction />
      <CreateCardAction />
      <Separator />
      <TextScheduler text={snippet} />
      <Separator />
      <DismissAction item={snippet} />
      <MoreOptionsAction />
    </>
  );
}

function CardActions({ card }: { card: ReviewCard }) {
  const showAnswer = useAppSelector((state) => state.showAnswer);

  return (
    <>
      {showAnswer ? (
        <GradeActions card={card} />
      ) : (
        <>
          <ShowAnswerAction />
          <SkipAction item={card} />
        </>
      )}
      <ExtractSnippetAction />
      <CreateCardAction />
      <Separator />
      <DismissAction item={card} />
      <MoreOptionsAction />
    </>
  );
}

function MarkReviewedAction({ text }: { text: ReviewText }) {
  const { actions } = useReviewContext();

  return (
    <ButtonWithIcon
      tooltip="Mark reviewed"
      handleClick={async () => await actions.review(text)}
    >
      <Check stroke="#00a700" />
    </ButtonWithIcon>
  );
}

function SkipAction({ item }: { item: ReviewItem }) {
  const { actions } = useReviewContext();

  return (
    <ButtonWithIcon
      tooltip="Skip for current review session"
      handleClick={() => {
        actions.skipItem(item);
      }}
    >
      <SkipForward />
    </ButtonWithIcon>
  );
}

function ShowAnswerAction() {
  const dispatch = useDispatch();

  return (
    <ButtonWithIcon
      tooltip="Show answer"
      handleClick={() => {
        dispatch(setShowAnswer(true));
      }}
    >
      <Eye stroke="#00a700" />
    </ButtonWithIcon>
  );
}

function GradeActions({ card }: { card: ReviewCard }) {
  const { actions } = useReviewContext();

  return (
    <>
      <ButtonWithIcon
        handleClick={async () => await actions.gradeCard(card, Rating.Again)}
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
  );
}

function ExtractSnippetAction() {
  const { actions } = useReviewContext();

  return (
    <ButtonWithIcon
      tooltip="Extract selected text to a new snippet"
      handleClick={async () => {
        await actions.createSnippet();
      }}
    >
      <Scissors />
    </ButtonWithIcon>
  );
}

function CreateCardAction() {
  const { actions } = useReviewContext();

  return (
    <ButtonWithIcon
      tooltip="Create card"
      handleClick={async () => {
        await actions.createCard();
      }}
    >
      <CardCog />
    </ButtonWithIcon>
  );
}

/**
 * Dismisses the item, or restores it to the queue if it's already dismissed.
 */
function DismissAction({ item }: { item: ReviewItem }) {
  const { actions } = useReviewContext();

  return item.data.dismissed ? (
    <ButtonWithIcon
      tooltip="Restore item to queue"
      handleClick={async () => await actions.unDismissItem(item)}
    >
      <ArchiveRestore stroke="#f7b500" />
    </ButtonWithIcon>
  ) : (
    <ButtonWithIcon
      tooltip="Stop scheduling this item for review"
      handleClick={async () => await actions.dismissItem(item)}
    >
      <Ban stroke="#f7b500" />
    </ButtonWithIcon>
  );
}

function MoreOptionsAction() {
  const { plugin, reviewView } = useReviewContext();

  // Obsidian draws its own ⋮ in the view header, which ReviewView hides on
  // desktop, but not mobile.
  if (plugin.app.isMobile) return null;

  return (
    <ButtonWithIcon
      tooltip="More options"
      id="more-options-button"
      handleClick={(e) => {
        // Anchors the menu under the button, the way Obsidian's own header
        // button anchors it. Read synchronously: `currentTarget` is null once
        // the event finishes dispatching.
        const button = e.currentTarget;
        if (button instanceof HTMLElement) {
          reviewView.showMoreOptionsMenu(button);
        }
      }}
    >
      <EllipsisVertical />
    </ButtonWithIcon>
  );
}
