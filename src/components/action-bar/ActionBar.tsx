import { CardCogPlus } from '#/components/icons/CardCog';
import { ScissorsPlus } from '#/components/icons/ScissorsPlus';
import { useAppSelector } from '#/hooks/useAppSelector';
import { useLeafHistory } from '#/hooks/useLeafHistory';
import { useCurrentItem, useQueue } from '#/hooks/useReactQuery';
import type { ActionStackEntry } from '#/lib/Actions';
import { QUEUE_TABLE_DEFAULT_ENTRIES_PER_PAGE } from '#/lib/constants';
import { type SelectionKind, setPage, setShowAnswer } from '#/lib/store';
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
  SkipForward,
  Undo2,
  X,
} from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { useDispatch } from 'react-redux';
import { Rating } from 'ts-fsrs';
import { useReviewContext } from '../ReviewContext';
import { ButtonWithIcon, Separator, TextButton } from './BarButtons';
import { ReviewTypeFilter } from './ReviewTypeFilter';
import { TextScheduler } from './TextScheduler';

/**
 * The bar holds three zones, and every one of them is rendered on every page,
 * empty or not: styles.css gives the two outer zones equal width, which is what
 * puts the middle one on the bar's own midpoint rather than on the midpoint of
 * whatever the leading group leaves over. A zone dropped when it has nothing in
 * it would take that guarantee with it.
 *
 * Leading zone: the actions that act on the review session rather than on the
 * item in it — the tab's history, home, the type filter, undo. Middle: the
 * item's own actions. Trailing: the ⋮, which belongs to the view.
 */
export function ActionBar() {
  const page = useAppSelector((state) => state.page);
  const { data: currentItem } = useCurrentItem();
  const selectionMode = useAppSelector((state) => state.selectionMode);
  const dispatch = useDispatch();
  const itemActions = page !== 'home' && currentItem;

  return (
    <div className="ir-action-bar" tabIndex={-1}>
      {/* setting a tabIndex makes the action bar focusable */}
      <div className="ir-bar-lead">
        <GlobalActions />
        {page !== 'home' && (
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
            <UndoAction />
          </>
        )}
      </div>
      <div className="ir-bar-center">
        {page === 'home' && <HomeActions />}
        {itemActions && selectionMode !== null && (
          <SelectionActions kind={selectionMode} />
        )}
        {itemActions && selectionMode === null && (
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
      </div>
      <div className="ir-bar-trail">{itemActions && <MoreOptionsAction />}</div>
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
 * Class for the controls that stand in for the view header's own, which
 * styles.css shows only while Obsidian hides the header: the "Show tab title bar"
 * setting turned off, on anything but a phone. The header is back the moment
 * the setting is, and a second set of the same buttons would only crowd the bar.
 *
 * Left to CSS rather than read from the vault config, so the bar follows the
 * setting from the same `body` class Obsidian's own rule keys on, with nothing
 * to subscribe to.
 */
const HEADER_STANDIN_CLASS = 'ir-header-standin';

/**
 * Actions that belong to the tab rather than to the item inside it: back and
 * forward through the tab's history.
 *
 * They stand in for the arrows Obsidian draws at the start of the view header
 * (see {@link HEADER_STANDIN_CLASS}) — so they lead the bar, as the ⋮ standing
 * in for the header's closes it.
 *
 * Like the header's arrows, they hold the bar's start edge, at the head of the
 * leading zone.
 */
function GlobalActions() {
  const { reviewView } = useReviewContext();
  const { leaf } = reviewView;
  const { canGoBack, canGoForward } = useLeafHistory(leaf);

  return (
    <>
      <ButtonWithIcon
        tooltip="Navigate back"
        id="navigate-back-button"
        className={HEADER_STANDIN_CLASS}
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
        className={HEADER_STANDIN_CLASS}
        disabled={!canGoForward}
        handleClick={async () => {
          await leaf.history.forward();
        }}
      >
        <ArrowRight />
      </ButtonWithIcon>
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
  const { actions, reviewView } = useReviewContext();

  return (
    <ButtonWithIcon
      tooltip="Create snippet"
      handleClick={async () => {
        await actions.extract('snippet', reviewView);
      }}
    >
      <ScissorsPlus />
    </ButtonWithIcon>
  );
}

function CreateCardAction() {
  const { actions, reviewView } = useReviewContext();

  return (
    <ButtonWithIcon
      tooltip="Create card"
      handleClick={async () => {
        await actions.extract('card', reviewView);
      }}
    >
      <CardCogPlus />
    </ButtonWithIcon>
  );
}

/**
 * Stand in for the item's actions while review waits for the user to select
 * text to extract. Everything outside the middle zone stays: it acts on the
 * session, and leaving the item by it ends the mode.
 */
function SelectionActions({ kind }: { kind: SelectionKind }) {
  const { actions, reviewView } = useReviewContext();

  // Still pressable so we can show a notice to select text
  const confirmTooltip =
    kind === 'snippet'
      ? 'Extract the selected text to a new snippet'
      : 'Make a card of the selected text';

  return (
    <>
      <TextButton
        id="confirm-selection-button"
        tooltip={confirmTooltip}
        handleClick={async () => {
          await actions.confirmSelection(reviewView);
        }}
      >
        <>
          <Check />
          Confirm
        </>
      </TextButton>
      <TextButton
        id="cancel-selection-button"
        tooltip={
          kind === 'snippet'
            ? 'Cancel extracting a snippet'
            : 'Cancel making a card'
        }
        handleClick={() => {
          actions.cancelSelection(reviewView);
        }}
      >
        <X />
        Cancel
      </TextButton>
    </>
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

/** Stands in for the view header's ⋮ — see {@link HEADER_STANDIN_CLASS}. */
function MoreOptionsAction() {
  const { reviewView } = useReviewContext();

  return (
    <ButtonWithIcon
      tooltip="More options"
      id="more-options-button"
      className={HEADER_STANDIN_CLASS}
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
