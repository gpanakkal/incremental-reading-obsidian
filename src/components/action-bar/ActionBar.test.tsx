// @vitest-environment jsdom
import { ReviewContextProvider } from '#/components/ReviewContext';
import type { QueuePage } from '#/components/types';
import * as ReactQuery from '#/hooks/useReactQuery';
import type { ActionStackEntry } from '#/lib/Actions';
import { setPage, setShowAnswer } from '#/lib/store';
import type { NoteType, ReviewItem } from '#/lib/types';
import { type ComponentChild, render } from 'preact';
import { Rating } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionBar } from './ActionBar';

// #region HELPERS

/** Render a component into a detached jsdom container and return it. */
function mount(node: ComponentChild): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(node as never, container);
  return container;
}

/**
 * Stub the queue query behind the begin-review button. `totalRows` is what the
 * button reads; the rows themselves are irrelevant to it, so they stay empty.
 */
function wireQueue({
  totalRows = 1,
  isLoading = false,
  hasData = true,
}: {
  totalRows?: number;
  isLoading?: boolean;
  hasData?: boolean;
} = {}) {
  const page: QueuePage = {
    rows: [],
    totalRows,
    firstDue: null,
    lastDue: null,
  };
  vi.spyOn(ReactQuery, 'useQueue').mockReturnValue({
    data: hasData ? page : undefined,
    isLoading,
  } as never);
  vi.spyOn(ReactQuery, 'useCurrentItem').mockReturnValue({
    data: undefined,
  } as never);
}

/**
 * Put an item on screen, which is the state the ⋮ button renders in. A card is the cheapest of the four: the other
 * types drag in the scheduler alongside.
 */
function wireCurrentItem(): void {
  reduxState.page = 'review';
  vi.spyOn(ReactQuery, 'useCurrentItem').mockReturnValue({
    data: { data: { type: 'card', dismissed: false } },
  } as never);
}

/**
 * Mount the bar inside the context it has in the app. Every page of it past the
 * home screen reads the context — the ⋮ button takes the platform off the
 * plugin and hands the view the button to anchor its menu to — so the bar is
 * not mounted bare here.
 */
function mountBar({
  isMobile = false,
  showMoreOptionsMenu = vi.fn(),
  actions = makeActions(),
}: {
  isMobile?: boolean;
  showMoreOptionsMenu?: () => void;
  actions?: ReturnType<typeof makeActions>;
} = {}): HTMLElement {
  return mount(
    <ReviewContextProvider
      plugin={{ actions, app: { isMobile } } as never}
      reviewView={{ showMoreOptionsMenu } as never}
      reviewManager={{} as never}
    >
      <ActionBar />
    </ReviewContextProvider>
  );
}

function moreOptionsButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('#more-options-button');
}

function beginReviewButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    '#begin-review-button'
  );
  if (!button) throw new Error('begin review button not rendered');
  return button;
}

function undoButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('#undo-button');
  if (!button) throw new Error('undo button not rendered');
  return button;
}

/**
 * Stand-in for `Actions` covering what the undo button touches: an array
 * mutated in place, and an emit after each mutation. `listeners` is exposed so
 * a test can check the button lets go of its subscription.
 */
function makeActions() {
  const undoStack: ActionStackEntry[] = [];
  const listeners = new Set<() => void>();
  const emit = () => {
    listeners.forEach((fn) => fn());
  };
  return {
    undoStack,
    listeners,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    setCardsOnly: vi.fn(),
    createSnippet: vi.fn(),
    createCard: vi.fn(),
    dismissItem: vi.fn(),
    unDismissItem: vi.fn(),
    review: vi.fn(),
    skipItem: vi.fn(),
    gradeCard: vi.fn(),
    undo: vi.fn(() => {
      undoStack.pop();
      emit();
    }),
    push: (description: string) => {
      undoStack.push({ description } as ActionStackEntry);
      emit();
    },
  };
}

/** Mount the bar on the review page, where the undo button lives. */
function mountReviewBar(actions: ReturnType<typeof makeActions>): HTMLElement {
  reduxState.page = 'review';
  vi.spyOn(ReactQuery, 'useCurrentItem').mockReturnValue({
    data: undefined,
  } as never);
  return mount(
    <ReviewContextProvider
      plugin={{ actions, app: { isMobile: false } } as never}
      reviewView={{ showMoreOptionsMenu: vi.fn() } as never}
      reviewManager={{} as never}
    >
      <ActionBar />
    </ReviewContextProvider>
  );
}

const ITEM_TYPES: NoteType[] = ['article', 'snippet', 'card'];
const TEXT_TYPES: NoteType[] = ['article', 'snippet'];
const GRADES = [
  ['Forgot', Rating.Again],
  ['Hard', Rating.Hard],
  ['Good', Rating.Good],
  ['Easy', Rating.Easy],
] as const;

/**
 * An item carrying only what the bar reads: `type` and `dismissed` pick the
 * buttons, and the scheduler reads `id` and `priority`. A null
 * `fixed_interval_days` keeps articles on the priority field, as snippets are.
 */
function makeItem(
  type: NoteType,
  { dismissed = false }: { dismissed?: boolean } = {}
): ReviewItem {
  return {
    data: {
      id: `${type}-id`,
      type,
      dismissed,
      priority: 50,
      fixed_interval_days: null,
    },
    file: {},
  } as never;
}

/** Mount the review page with `item` on screen. */
function mountItemBar(
  item: ReviewItem,
  {
    showAnswer = false,
    actions = makeActions(),
  }: { showAnswer?: boolean; actions?: ReturnType<typeof makeActions> } = {}
): HTMLElement {
  reduxState.page = 'review';
  reduxState.showAnswer = showAnswer;
  vi.spyOn(ReactQuery, 'useCurrentItem').mockReturnValue({
    data: item,
  } as never);
  return mountBar({ actions });
}

/** The button carrying `label` as its tooltip, or null when there is none. */
function queryButton(
  container: HTMLElement,
  label: string
): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`
  );
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const found = queryButton(container, label);
  if (!found) throw new Error(`"${label}" button not rendered`);
  return found;
}

/** Grade buttons carry no tooltip, so they are found by their text. */
function queryGradeButton(
  container: HTMLElement,
  grade: string
): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes(grade)
    ) ?? null
  );
}

/**
 * Let preact catch up. Long enough to cover the deferred effect that subscribes
 * (preact falls back to a 100ms timeout when no frame is painted), and awaited
 * so the re-render an emit schedules lands before the next assertion.
 */
async function settle() {
  await vi.advanceTimersByTimeAsync(200);
}

// #endregion

// lucide-react resolves `useContext` against its own preact copy, which is not
// the instance rendering here (see the react→preact aliasing TODO in
// vitest.config.ts). The icons are incidental to this component's behavior.
vi.mock('lucide-react', () => ({
  ArchiveRestore: () => null,
  Ban: () => null,
  CalendarSync: () => null,
  Check: () => null,
  EllipsisVertical: () => null,
  Eye: () => null,
  House: () => null,
  Scissors: () => null,
  SkipForward: () => null,
  Trash2: () => null,
  Undo2: () => null,
}));

// react-redux is mocked rather than spied on because its exports are
// non-configurable: `vi.spyOn(ReactRedux, 'useDispatch')` throws
// "Cannot redefine property". This is the documented cannot-be-spied case.
const dispatch = vi.fn();
// The bar branches on `state.page`, so tests set it before mounting. Read
// through the selector at render time, which is after this initializes.
const defaultReduxState = {
  page: 'home' as 'home' | 'review',
  showAnswer: false,
  typesToReview: { article: true, snippet: true, card: true },
};
const reduxState = { ...defaultReduxState };
vi.mock('react-redux', () => ({
  useDispatch: () => dispatch,
  useSelector: (selector: (state: unknown) => unknown) => selector(reduxState),
  useStore: () => ({ getState: () => reduxState }),
}));

describe('ActionBar', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    dispatch.mockClear();
    Object.assign(reduxState, defaultReduxState);
    vi.restoreAllMocks();
  });

  describe('begin review button', () => {
    it('is enabled when the queue holds due items', () => {
      wireQueue({ totalRows: 3 });

      const container = mountBar();

      expect(beginReviewButton(container).disabled).toBe(false);
    });

    it('is disabled when nothing is due', () => {
      wireQueue({ totalRows: 0 });

      const container = mountBar();

      expect(beginReviewButton(container).disabled).toBe(true);
    });

    it('is disabled while the queue is still loading', () => {
      // Starting a review of a queue whose size is not yet known could land on
      // the empty-review placeholder, so the button waits for the count.
      wireQueue({ isLoading: true, hasData: false });

      const container = mountBar();

      expect(beginReviewButton(container).disabled).toBe(true);
    });

    it('does not navigate to the review page when nothing is due', () => {
      wireQueue({ totalRows: 0 });

      const container = mountBar();
      beginReviewButton(container).click();

      expect(dispatch).not.toHaveBeenCalled();
    });

    it('navigates to the review page when items are due', () => {
      wireQueue({ totalRows: 3 });

      const container = mountBar();
      beginReviewButton(container).click();

      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ payload: 'review' })
      );
    });

    it('explains why it is unavailable when nothing is due', () => {
      wireQueue({ totalRows: 0 });

      const container = mountBar();

      expect(beginReviewButton(container).getAttribute('aria-label')).toBe(
        'Nothing due for review'
      );
    });
  });

  describe('home button', () => {
    it('returns to the home screen', () => {
      reduxState.page = 'review';
      vi.spyOn(ReactQuery, 'useCurrentItem').mockReturnValue({
        data: undefined,
      } as never);
      const container = mountBar();

      getButton(container, 'Go to home screen').click();

      expect(dispatch).toHaveBeenCalledWith(setPage('home'));
    });
  });

  describe('undo button', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('is disabled when no action has been taken', async () => {
      const container = mountReviewBar(makeActions());
      await settle();

      expect(undoButton(container).disabled).toBe(true);
    });

    it('explains why it is unavailable when there is nothing to undo', async () => {
      const container = mountReviewBar(makeActions());
      await settle();

      expect(undoButton(container).getAttribute('aria-label')).toBe(
        'Nothing to undo'
      );
    });

    it('enables itself when an action is recorded, with no other re-render', async () => {
      // Regression: creating a snippet pushes onto the undo stack without
      // touching the store, so nothing else re-renders the bar. The button
      // stayed disabled until an unrelated render (leaving and re-entering
      // review) happened to pick the new entry up.
      const actions = makeActions();
      const container = mountReviewBar(actions);
      await settle();
      expect(undoButton(container).disabled).toBe(true);

      actions.push('creating snippet "excerpt"');
      await settle();

      expect(undoButton(container).disabled).toBe(false);
    });

    it('names the recorded action once it appears', async () => {
      const actions = makeActions();
      const container = mountReviewBar(actions);
      await settle();

      actions.push('creating snippet "excerpt"');
      await settle();

      expect(undoButton(container).getAttribute('aria-label')).toBe(
        'Undo creating snippet "excerpt"'
      );
    });

    it('follows the top of the stack rather than the first entry', async () => {
      const actions = makeActions();
      const container = mountReviewBar(actions);
      actions.push('skipping "first"');
      await settle();

      actions.push('creating snippet "second"');
      await settle();

      expect(undoButton(container).getAttribute('aria-label')).toBe(
        'Undo creating snippet "second"'
      );
    });

    it('disables itself again once the stack is emptied', async () => {
      const actions = makeActions();
      const container = mountReviewBar(actions);
      actions.push('creating snippet "excerpt"');
      await settle();
      expect(undoButton(container).disabled).toBe(false);

      undoButton(container).click();
      await settle();

      expect(undoButton(container).disabled).toBe(true);
    });

    it('reverses the recorded action when clicked', async () => {
      const actions = makeActions();
      const container = mountReviewBar(actions);
      actions.push('creating snippet "excerpt"');
      await settle();

      undoButton(container).click();

      expect(actions.undo).toHaveBeenCalledTimes(1);
    });

    it('drops its subscription when unmounted', async () => {
      const actions = makeActions();
      const container = mountReviewBar(actions);
      await settle();
      expect(actions.listeners.size).toBe(1);

      render(null, container);
      await settle();

      expect(actions.listeners.size).toBe(0);
    });

    it('subscribes once across re-renders', async () => {
      // The subscription is torn down and rebuilt whenever `subscribe` changes
      // identity, so an unstable one would churn on every render.
      const actions = makeActions();
      const container = mountReviewBar(actions);
      await settle();

      actions.push('skipping "first"');
      await settle();
      actions.push('skipping "second"');
      await settle();

      expect(undoButton(container).disabled).toBe(false);
      expect(actions.listeners.size).toBe(1);
    });
  });

  describe('more options button', () => {
    it('opens the file menu anchored to itself', () => {
      // The view positions the menu under the element it is handed, the way
      // Obsidian's own header button does, so the button has to pass itself.
      const showMoreOptionsMenu = vi.fn();
      wireCurrentItem();
      const container = mountBar({ showMoreOptionsMenu });
      const button = moreOptionsButton(container);

      button?.click();

      expect(showMoreOptionsMenu).toHaveBeenCalledWith(button);
    });

    it('stays hidden until an item is on screen', () => {
      // Every item type offers it: everything the menu offers is about the note
      // being reviewed, so there is nothing for it to act on before one is up —
      // on the home screen or on the review page between items.
      wireQueue();

      expect(moreOptionsButton(mountBar())).toBeNull();

      document.body.innerHTML = '';
      reduxState.page = 'review';

      expect(moreOptionsButton(mountBar())).toBeNull();
    });

    it('stays out of the way on mobile, where Obsidian draws its own', () => {
      // ReviewView only hides `headerEl` on desktop; on mobile the real ⋮ is
      // still in the view header, and a second one would duplicate it.
      wireCurrentItem();

      const container = mountBar({ isMobile: true });

      expect(moreOptionsButton(container)).toBeNull();
    });
  });

  describe('actions on any item', () => {
    // Every type gets these whatever the card's reveal state, so the matrix
    // includes a revealed answer for texts too, which the store can hold for
    // an instant between items.
    const screens = ITEM_TYPES.flatMap((type) =>
      [false, true].map((showAnswer) => ({ type, showAnswer }))
    );

    describe.each(screens)(
      'on a $type (answer shown: $showAnswer)',
      (screen) => {
        it('extracts the selection to a new snippet', () => {
          const actions = makeActions();
          const container = mountItemBar(makeItem(screen.type), {
            ...screen,
            actions,
          });

          getButton(
            container,
            'Extract selected text to a new snippet'
          ).click();

          expect(actions.createSnippet).toHaveBeenCalledTimes(1);
        });

        it('creates a card', () => {
          const actions = makeActions();
          const container = mountItemBar(makeItem(screen.type), {
            ...screen,
            actions,
          });

          getButton(container, 'Create card').click();

          expect(actions.createCard).toHaveBeenCalledTimes(1);
        });

        it('stops scheduling an item that is still scheduled', () => {
          const actions = makeActions();
          const item = makeItem(screen.type);
          const container = mountItemBar(item, { ...screen, actions });

          expect(queryButton(container, 'Restore item to queue')).toBeNull();
          getButton(container, 'Stop scheduling this item for review').click();

          expect(actions.dismissItem).toHaveBeenCalledWith(item);
        });

        it('restores a dismissed item to the queue', () => {
          const actions = makeActions();
          const item = makeItem(screen.type, { dismissed: true });
          const container = mountItemBar(item, { ...screen, actions });

          expect(
            queryButton(container, 'Stop scheduling this item for review')
          ).toBeNull();
          getButton(container, 'Restore item to queue').click();

          expect(actions.unDismissItem).toHaveBeenCalledWith(item);
        });

        it('offers the more options menu', () => {
          const container = mountItemBar(makeItem(screen.type), screen);

          expect(moreOptionsButton(container)).not.toBeNull();
        });
      }
    );
  });

  describe.each(TEXT_TYPES)('actions on a %s', (type) => {
    it('marks it as reviewed', () => {
      const actions = makeActions();
      const item = makeItem(type);
      const container = mountItemBar(item, { actions });

      getButton(container, 'Mark reviewed').click();

      expect(actions.review).toHaveBeenCalledWith(item);
    });

    it('skips it for the session', () => {
      const actions = makeActions();
      const item = makeItem(type);
      const container = mountItemBar(item, { actions });

      getButton(container, 'Skip for current review session').click();

      expect(actions.skipItem).toHaveBeenCalledWith(item);
    });

    it('offers to change its scheduling strategy', () => {
      const container = mountItemBar(makeItem(type));

      expect(
        queryButton(container, 'Change scheduling strategy')
      ).not.toBeNull();
    });

    it('offers nothing that only makes sense for a card', () => {
      // Checked with the answer shown as well, so grades can't slip in on a
      // text through a reveal state it has no use for.
      for (const showAnswer of [false, true]) {
        const container = mountItemBar(makeItem(type), { showAnswer });

        expect(queryButton(container, 'Show answer')).toBeNull();
        for (const [grade] of GRADES) {
          expect(queryGradeButton(container, grade)).toBeNull();
        }
        document.body.innerHTML = '';
      }
    });
  });

  describe('actions on a card', () => {
    it('offers nothing that only makes sense for a text', () => {
      for (const showAnswer of [false, true]) {
        const container = mountItemBar(makeItem('card'), { showAnswer });

        expect(queryButton(container, 'Mark reviewed')).toBeNull();
        expect(queryButton(container, 'Change scheduling strategy')).toBeNull();
        document.body.innerHTML = '';
      }
    });

    describe('before the answer is shown', () => {
      it('reveals the answer', () => {
        const container = mountItemBar(makeItem('card'));

        getButton(container, 'Show answer').click();

        expect(dispatch).toHaveBeenCalledWith(setShowAnswer(true));
      });

      it('skips the card for the session', () => {
        const actions = makeActions();
        const card = makeItem('card');
        const container = mountItemBar(card, { actions });

        getButton(container, 'Skip for current review session').click();

        expect(actions.skipItem).toHaveBeenCalledWith(card);
      });

      it('holds back the grades', () => {
        const container = mountItemBar(makeItem('card'));

        for (const [grade] of GRADES) {
          expect(queryGradeButton(container, grade)).toBeNull();
        }
      });
    });

    describe('once the answer is shown', () => {
      it.each(GRADES)('grades the card %s', (grade, rating) => {
        const actions = makeActions();
        const card = makeItem('card');
        const container = mountItemBar(card, { showAnswer: true, actions });

        queryGradeButton(container, grade)?.click();

        expect(actions.gradeCard).toHaveBeenCalledWith(card, rating);
      });

      it('stops offering to reveal or skip', () => {
        const container = mountItemBar(makeItem('card'), { showAnswer: true });

        expect(queryButton(container, 'Show answer')).toBeNull();
        expect(
          queryButton(container, 'Skip for current review session')
        ).toBeNull();
      });
    });
  });
});
