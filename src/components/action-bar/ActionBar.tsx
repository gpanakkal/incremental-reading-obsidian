import { CardCogPlus } from '#/components/icons/CardCog';
import { FilesPlus } from '#/components/icons/FilesPlus';
import { ScissorsPlus } from '#/components/icons/ScissorsPlus';
import { useAppSelector } from '#/hooks/useAppSelector';
import {
  GRADE_GHOST_CLASS,
  useGradePlacement,
} from '#/hooks/useGradePlacement';
import { useLeafHistory } from '#/hooks/useLeafHistory';
import { usePacked } from '#/hooks/usePacked';
import { useCurrentItem, useQueue } from '#/hooks/useReactQuery';
import { actionCooldownFor } from '#/lib/action-cooldown';
import type { ActionStackEntry } from '#/lib/Actions';
import {
  DISMISS_ICON_STROKE,
  QUEUE_TABLE_DEFAULT_ENTRIES_PER_PAGE,
} from '#/lib/constants';
import { goToReviewPlace } from '#/lib/review-history';
import {
  type IRPluginState,
  type SelectionKind,
  setPage,
  setShowAnswer,
} from '#/lib/store';
import {
  isMissingItem,
  isReviewArticle,
  isReviewCard,
  isReviewSnippet,
  type MaybeMissingItem,
  type MissingItem,
  type ReviewArticle,
  type ReviewCard,
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
  FileQuestionMark,
  House,
  Play,
  SkipForward,
  Undo2,
  X,
} from 'lucide-react';
import { Platform } from 'obsidian';
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useDispatch, useStore } from 'react-redux';
import { useReviewContext } from '../ReviewContext';
import { ButtonWithIcon, Separator, TextButton } from './BarButtons';
import { GradeGroup } from './GradeGroup';
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
 * item in it — the tab's history, home, the type filter, undo — with bulk
 * import and the notes not found in the database in place of home and undo on
 * the home screen. Middle: the item's own
 * actions. Trailing: the ⋮, which belongs to the view.
 *
 * A card's grades lead the middle zone while they fit there, and take a row of
 * their own after the bar where they don't (see {@link useGradePlacement}),
 * which styles.css puts between the bar and the card wherever the bar is.
 */
export function ActionBar() {
  const page = useAppSelector((state) => state.page);
  const { data: currentItem } = useCurrentItem();
  const selectionMode = useAppSelector((state) => state.selectionMode);
  const showAnswer = useAppSelector((state) => state.showAnswer);
  const dispatch = useDispatch();
  const itemActions = page !== 'home' && currentItem;
  const gradedCard =
    itemActions &&
    selectionMode === null &&
    !isMissingItem(currentItem) &&
    isReviewCard(currentItem) &&
    showAnswer
      ? currentItem
      : null;
  const barRef = useRef<HTMLDivElement>(null);
  const gradePlacement = useGradePlacement(barRef);
  const leadRef = useRef<HTMLDivElement>(null);
  const leadPacked = usePacked(leadRef);
  // Toggled on the element rather than rendered into `className`: a changed
  // className is written over whole, and would wipe `node-insert-event`, the
  // class Obsidian puts on the zone to hear of the tab moving windows
  // (undocumented; see usePacked)
  useLayoutEffect(() => {
    leadRef.current?.classList.toggle(PACKED_CLASS, leadPacked);
  }, [leadPacked]);
  const ignoreDuringCooldown = useCooldownGuard(
    itemActions ? `${currentItem.data.id}:${showAnswer}` : null
  );

  return (
    <>
      <div
        ref={barRef}
        className="ir-action-bar"
        tabIndex={-1}
        onClickCapture={ignoreDuringCooldown}
      >
        {/* setting a tabIndex makes the action bar focusable */}
        <div ref={leadRef} className="ir-bar-lead">
          <GlobalActions />
          {page === 'home' ? (
            <BulkImportAction />
          ) : (
            <ButtonWithIcon
              tooltip="Go to home screen"
              handleClick={() => {
                dispatch(setPage('home'));
              }}
            >
              <House />
            </ButtonWithIcon>
          )}
          {/* On both pages, in the same slot: it filters the queue on home
              and what review draws from, which are one setting */}
          <ReviewTypeFilter />
          {page === 'home' ? (
            <LeftoverAction />
          ) : (
            <>
              <UndoAction />
              {itemActions && <Separator className={JOINT_SEPARATOR_CLASS} />}
            </>
          )}
        </div>
        <div
          className={
            itemActions
              ? `ir-bar-center ${COOLDOWN_GUARD_CLASS}`
              : 'ir-bar-center'
          }
        >
          {page === 'home' && <HomeActions />}
          {itemActions && selectionMode !== null && (
            <SelectionActions kind={selectionMode} />
          )}
          {itemActions &&
            selectionMode === null &&
            isMissingItem(currentItem) && <MissingActions item={currentItem} />}
          {itemActions &&
            selectionMode === null &&
            !isMissingItem(currentItem) && (
              <>
                {isReviewArticle(currentItem) && (
                  <ArticleActions article={currentItem} />
                )}
                {isReviewSnippet(currentItem) && (
                  <SnippetActions snippet={currentItem} />
                )}
                {isReviewCard(currentItem) && (
                  <CardActions
                    card={currentItem}
                    gradesInline={gradePlacement === 'inline'}
                  />
                )}
              </>
            )}
        </div>
        <div className="ir-bar-trail">
          {itemActions && <MoreOptionsAction />}
        </div>
        {gradedCard && (
          <div className={GRADE_GHOST_CLASS}>
            <GradeGroup card={gradedCard} ghost />
          </div>
        )}
      </div>
      {gradedCard && gradePlacement === 'row' && (
        <div
          className={`ir-grade-row ${COOLDOWN_GUARD_CLASS}`}
          onClickCapture={ignoreDuringCooldown}
        >
          <GradeGroup card={gradedCard} />
        </div>
      )}
    </>
  );
}

/**
 * On what the double-click guard holds: the item's own actions (the bar's
 * center while an item is up, and the grade row) and undo. Navigation — the
 * history arrows, home, the type filter, ⋮ — stays live: a second click there
 * lands on the same button, doing what the first asked for again rather than
 * acting on an item the user hasn't seen.
 */
const COOLDOWN_GUARD_CLASS = 'ir-cooldown-guard';

/**
 * Arms the review tab's double-click guard whenever `shown` — what the bar's
 * buttons act on — changes, and returns the capture-phase click handler that
 * swallows clicks on {@link COOLDOWN_GUARD_CLASS} while it is armed (see
 * `ActionCooldown`).
 *
 * `shown` names the item and whether a card's answer is up: revealing the
 * answer puts the grades where the show-answer button was, so a double click
 * on it would grade the card unread. Home and a bar without an item are both
 * null, so leaving for home or arriving from it arms the guard too.
 *
 * Armed in a layout effect, which runs once the new buttons are in the DOM and
 * before they are painted: the guard runs from when the item can be seen, not
 * from the click that asked for it, since grading and fetching the next item
 * take a while of their own.
 *
 * Nothing changes on screen while it is armed. Dimming the bar for a fraction
 * of a second after every review would flicker, and `pointer-events: none`
 * would drop the hover state and tooltip of a button under the pointer.
 * Swallowing the click alone leaves every button looking and hovering as
 * before. Keyboard activation (Enter or Space on a focused button) and taps
 * arrive as clicks too, so they are covered.
 */
function useCooldownGuard(
  shown: string | null
): (e: {
  target: EventTarget | null;
  stopPropagation(): void;
  preventDefault(): void;
}) => void {
  const { plugin, reviewView } = useReviewContext();
  const cooldown = actionCooldownFor(reviewView);
  useLayoutEffect(() => {
    cooldown.show(shown, performance.now());
  }, [cooldown, shown]);

  return (e) => {
    // Duck-typed: a popout window's elements fail `instanceof Element` here
    const target = e.target as Partial<Element> | null;
    if (!target?.closest?.(`.${COOLDOWN_GUARD_CLASS}`)) return;
    if (
      cooldown.isCoolingDown(
        performance.now(),
        plugin.settings.actionCooldownSeconds
      )
    ) {
      // Capture phase on an ancestor: stopping here keeps the click from ever
      // reaching the button's own handler.
      e.stopPropagation();
      e.preventDefault();
    }
  };
}

/**
 * On the leading zone while it has shrunk to its contents (see
 * {@link usePacked}), which is when undo, its last button, sits right against
 * the middle zone's first.
 */
const PACKED_CLASS = 'is-packed';

/**
 * The separator that closes the leading zone. It parts undo from the item's
 * first action — mark reviewed, show answer — so it is there only while an
 * item is, and styles.css shows it only where the two meet: on a packed bar,
 * and on mobile, where the bar is packed or close to it.
 *
 * It takes its width whether shown or not (`visibility`, never `display`), so
 * showing it moves nothing: were it to widen the zone, the zone would read as
 * packed for having grown and the bar could flicker across the threshold.
 */
const JOINT_SEPARATOR_CLASS = 'ir-bar-joint';

function HomeActions() {
  const store = useStore<IRPluginState>();
  const typesToReview = useAppSelector((state) => state.typesToReview);
  // The same slice the queue table asks for, so both read one cache entry
  // under the ['queue', subset] key rather than each fetching the queue.
  // React Query compares keys structurally, so the matching shape is enough.
  // Filtered as review is, so the button is off when nothing of the types
  // review would draw from is queued.
  const { data, isLoading, isError } = useQueue({
    slice: {
      pageNumber: 0,
      entriesPerPage: QUEUE_TABLE_DEFAULT_ENTRIES_PER_PAGE,
    },
    typesToInclude: typesToReview,
  });

  // An empty queue is an empty *due* queue (getQueue returns only due items),
  // so this is the same condition that puts "Nothing due for review" on the
  // screen below, and the two cannot disagree. Held disabled while loading as
  // well, since a button that starts a review of an unknown queue is worse
  // than one that is briefly inert.
  // A queue that failed to load is unknown rather than empty, and is told
  // apart from one, as the table below it does.
  const nothingDue = isLoading || !data || data.totalRows === 0;

  // Labelled through the button's aria-label (ButtonWithIcon), never the SVG:
  // Obsidian's tooltip handler crashes on an aria-labelled SVG.
  return (
    <ButtonWithIcon
      tooltip={
        isError
          ? "Couldn't load the queue"
          : nothingDue
            ? 'Nothing due for review'
            : 'Learn'
      }
      id="begin-review-button"
      disabled={isError || nothingDue}
      handleClick={() => {
        // The top of the queue, not the item the store kept while home was up
        goToReviewPlace(store, null);
      }}
    >
      <Play />
    </ButtonWithIcon>
  );
}

/**
 * Opens the bulk-import modal. Shown whatever is due: importing is how an
 * empty queue fills.
 *
 * In the leading zone, ahead of the leftover button, so the begin-review
 * button keeps the bar's midpoint to itself.
 */
function BulkImportAction() {
  const { plugin } = useReviewContext();
  return (
    <ButtonWithIcon
      tooltip="Bulk import from vault"
      id="bulk-import-button"
      handleClick={() => {
        plugin.openBulkImport();
      }}
    >
      <FilesPlus />
    </ButtonWithIcon>
  );
}

/** What the bar reads before the plugin has a leftover watch: none. */
const NO_LEFTOVERS: readonly unknown[] = [];
const subscribeToNothing = () => () => {};

/** The most leftovers the leftover button's count shows as a number. */
const MAX_SHOWN_LEFTOVERS = 99;

/**
 * Opens the notes left without review data by a crash to choose what to do
 * with (see `LeftoverWatch`), there only while there are some. It looks for
 * them again first, so a note dealt with by hand since is not listed. Their
 * count sits on its bottom-right corner, capped at "99+", and is read out
 * through its label instead.
 *
 * In the leading zone, which grows as wide as the trailing one whatever it
 * holds, so the begin-review button stays on the bar's midpoint.
 */
function LeftoverAction() {
  const { leftovers } = useReviewContext().plugin;
  const current = useSyncExternalStore(
    leftovers?.subscribe ?? subscribeToNothing,
    () => leftovers?.current ?? NO_LEFTOVERS
  );
  const count = current.length;
  if (count === 0) return null;

  return (
    <ButtonWithIcon
      tooltip={`Manage ${count} ${count === 1 ? 'note' : 'notes'} not found in the database`}
      id="manage-leftovers-button"
      className="ir-has-count"
      handleClick={() => leftovers?.manage()}
    >
      <FileQuestionMark />
      <span className="ir-leftover-count" aria-hidden="true">
        {count > MAX_SHOWN_LEFTOVERS ? `${MAX_SHOWN_LEFTOVERS}+` : count}
      </span>
    </ButtonWithIcon>
  );
}

/**
 * Class for the controls that stand in for the view header's own, which
 * styles.css shows only while the header is hidden: Obsidian's "Show tab title
 * bar" setting turned off, on anything but a phone, unless the plugin's "Show
 * review tab title bar" setting overrides it either way. The header is back the
 * moment either setting brings it back, and a second set of the same buttons
 * would only crowd the bar. A phone always shows the header, so none of
 * them show there.
 *
 * Left to CSS rather than read from the settings, so the bar follows them from
 * the same classes the header rules key on — Obsidian's on `body`, the
 * plugin's on the tab — with nothing to subscribe to.
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
      className={COOLDOWN_GUARD_CLASS}
      disabled={lastAction === undefined}
      handleClick={async () => {
        await actions.undo();
      }}
    >
      <Undo2 />
    </ButtonWithIcon>
  );
}

/**
 * An item with no file has nothing to read, extract from or grade: it can be
 * put off or dropped from review. Relinking it is left to the placeholder,
 * where the missing file is explained, and to the queue's row menu and the
 * command.
 */
function MissingActions({ item }: { item: MissingItem }) {
  return (
    <>
      <SkipAction item={item} />
      <Separator />
      <DismissAction item={item} />
    </>
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

/**
 * Once the answer is shown the grades lead, where they are inline; otherwise
 * the bar has put them in their own row.
 *
 * The snippet button stays, switched off: a card is an answer, not reading
 * material, and `SnippetManager.create` refuses its note.
 */
function CardActions({
  card,
  gradesInline,
}: {
  card: ReviewCard;
  gradesInline: boolean;
}) {
  const showAnswer = useAppSelector((state) => state.showAnswer);

  return (
    <>
      {showAnswer ? (
        gradesInline && <GradeGroup card={card} />
      ) : (
        <>
          <ShowAnswerAction />
          <SkipAction item={card} />
        </>
      )}
      <ExtractSnippetAction onCard />
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

function SkipAction({ item }: { item: MaybeMissingItem }) {
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

/**
 * On a card the button is shown switched off, labelled with why, rather than
 * left out (0224). Natively `disabled`, as the bar's other off buttons are:
 * the click never fires, while Obsidian's tooltip still shows, since it opens
 * on `pointerover` (obsidian.asar, undocumented), which Chromium dispatches to
 * a disabled button.
 *
 * On mobile that tooltip never shows: the handler bails on any `pointerType`
 * but "mouse" (obsidian.asar, undocumented) and there is no long-press path.
 * There the button is only `aria-disabled`, so a tap still reaches
 * `actions.extract`, whose card gate says why in a notice.
 */
function ExtractSnippetAction({ onCard = false }: { onCard?: boolean }) {
  const { actions, reviewView } = useReviewContext();

  return (
    <ButtonWithIcon
      tooltip={onCard ? "Can't make snippets from cards." : 'Create snippet'}
      className="ir-snippet-button"
      disabled={onCard && !Platform.isMobile}
      ariaDisabled={onCard && Platform.isMobile}
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
function DismissAction({ item }: { item: MaybeMissingItem }) {
  const { actions } = useReviewContext();

  return item.data.dismissed ? (
    <ButtonWithIcon
      tooltip="Restore item to queue"
      handleClick={async () => await actions.unDismissItem(item)}
    >
      <ArchiveRestore stroke={DISMISS_ICON_STROKE} />
    </ButtonWithIcon>
  ) : (
    <ButtonWithIcon
      tooltip="Stop scheduling this item for review"
      handleClick={async () => await actions.dismissItem(item)}
    >
      <Ban stroke={DISMISS_ICON_STROKE} />
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
