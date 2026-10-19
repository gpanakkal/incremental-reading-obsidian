// @vitest-environment jsdom
import { ReviewContextProvider } from '#/components/ReviewContext';
import type { QueuePage } from '#/components/types';
import * as ReactQuery from '#/hooks/useReactQuery';
import type { ActionStackEntry } from '#/lib/Actions';
import { QUEUE_TABLE_DEFAULT_ENTRIES_PER_PAGE } from '#/lib/constants';
import { currentItemQueryFn } from '#/lib/query-client';
import {
  resetSession,
  type SelectionKind,
  setCurrentItemId,
  setPage,
  setShowAnswer,
  store,
} from '#/lib/store';
import type { MaybeMissingItem, NoteType, ReviewItem } from '#/lib/types';
import fc from 'fast-check';
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
 * The plugin's half the grades read: "Show intervals on grade buttons" on, and
 * nothing to hear of it changing.
 */
const GRADE_INTERVALS_ON = {
  settings: { showGradeIntervals: true },
  onSettingsChange: () => () => {},
};

/**
 * Stub the queue query behind the begin-review button. `totalRows` is what the
 * button reads; the rows themselves are irrelevant to it, so they stay empty.
 */
function wireQueue({
  totalRows = 1,
  isLoading = false,
  hasData = true,
  isError = false,
}: {
  totalRows?: number;
  isLoading?: boolean;
  hasData?: boolean;
  /** Whether the last fetch failed; any page given is from before it. */
  isError?: boolean;
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
    isError,
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
 * Mount the bar inside the context it has in the app. Every page of it reads
 * the context — the arrows read the leaf's history, and the ⋮ button hands the
 * view the button to anchor its menu to — so the bar is not mounted bare here.
 */
function mountBar({
  showMoreOptionsMenu = vi.fn(),
  actions = makeActions(),
  leaf = makeLeaf(),
  reviewView = { showMoreOptionsMenu, leaf },
  leftovers,
  openBulkImport = vi.fn(),
}: {
  showMoreOptionsMenu?: () => void;
  actions?: ReturnType<typeof makeActions>;
  leaf?: ReturnType<typeof makeLeaf>;
  reviewView?: object;
  /** The plugin's watch over notes left without review data, once it has one. */
  leftovers?: ReturnType<typeof makeLeftoverWatch>;
  /** Opens the bulk import dialog with its filter bar. */
  openBulkImport?: () => void;
} = {}): HTMLElement {
  return mount(
    <ReviewContextProvider
      plugin={
        {
          actions,
          app: {},
          leftovers,
          openBulkImport,
          ...GRADE_INTERVALS_ON,
        } as never
      }
      reviewView={reviewView as never}
      reviewManager={REVIEW_MANAGER as never}
    >
      <ActionBar />
    </ReviewContextProvider>
  );
}

/**
 * Stand-in for the review manager covering what the grades read: a preview
 * of when each would put the card, here all ten minutes out.
 */
const REVIEW_MANAGER = {
  cards: {
    gradePreview: () => {
      const grades = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];
      return {
        approximate: Object.fromEntries(grades.map((grade) => [grade, false])),
        inMs: Object.fromEntries(grades.map((grade) => [grade, 10 * 60_000])),
      };
    },
  },
};

function moreOptionsButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('#more-options-button');
}

function bulkImportButton(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>('#bulk-import-button');
}

function beginReviewButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    '#begin-review-button'
  );
  if (!button) throw new Error('begin review button not rendered');
  return button;
}

/** The begin review button's tooltip over a queue in the given state. */
function beginReviewLabel(queue: Parameters<typeof wireQueue>[0]): string {
  wireQueue(queue);
  const container = mountBar();
  const label = beginReviewButton(container).getAttribute('aria-label');
  render(null, container);
  container.remove();
  return label ?? '';
}

type Direction = 'back' | 'forward';

function queryNavigateButton(
  container: HTMLElement,
  direction: Direction
): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    `#navigate-${direction}-button`
  );
}

function navigateButton(
  container: HTMLElement,
  direction: Direction
): HTMLButtonElement {
  const button = queryNavigateButton(container, direction);
  if (!button) throw new Error(`navigate ${direction} button not rendered`);
  return button;
}

/** The bar's top-level children, in the order they are laid out. */
function barChildren(container: HTMLElement): Element[] {
  const bar = container.querySelector('.ir-action-bar');
  if (!bar) throw new Error('action bar not rendered');
  return Array.from(bar.children);
}

function undoButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('#undo-button');
  if (!button) throw new Error('undo button not rendered');
  return button;
}

function typeFilter(container: HTMLElement): HTMLElement {
  const filter = container.querySelector<HTMLElement>('.ir-type-filter');
  if (!filter) throw new Error('type filter not rendered');
  return filter;
}

type Zone = 'lead' | 'center' | 'trail';

/** One of the bar's three layout zones. */
function zone(container: HTMLElement, name: Zone): HTMLElement {
  const bar = container.querySelector('.ir-action-bar');
  if (!bar) throw new Error('action bar not rendered');
  const el = bar.querySelector<HTMLElement>(`:scope > .ir-bar-${name}`);
  if (!el) throw new Error(`${name} zone not rendered`);
  return el;
}

function zoneChildren(container: HTMLElement, name: Zone): Element[] {
  return Array.from(zone(container, name).children);
}

/**
 * The separator closing the start edge, shown between undo and the item's
 * first action once the bar packs them together.
 */
function jointSeparator(container: HTMLElement): HTMLElement {
  const el = zone(container, 'lead').querySelector<HTMLElement>(
    ':scope > .ir-bar-joint'
  );
  if (!el) throw new Error('joint separator not rendered');
  return el;
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
    extract: vi.fn(),
    confirmSelection: vi.fn(),
    cancelSelection: vi.fn(),
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

/**
 * Stand-in for the tab's leaf covering what the navigation buttons touch: the
 * two history stacks, mutated in place as Obsidian's are, and `history-change`.
 * `listeners` is exposed so a test can check a subscription is let go of, and
 * `emitHistoryChange` raises the event the way a push or a move does.
 */
function makeLeaf({ back = 0, forward = 0 } = {}) {
  const listeners = new Set<() => void>();
  return {
    history: {
      backHistory: Array.from({ length: back }, () => ({})),
      forwardHistory: Array.from({ length: forward }, () => ({})),
      back: vi.fn(async () => {}),
      forward: vi.fn(async () => {}),
    },
    listeners,
    on: (name: string, fn: () => void) => {
      if (name === 'history-change') listeners.add(fn);
      return fn;
    },
    offref: (ref: () => void) => void listeners.delete(ref),
    emitHistoryChange: () => {
      listeners.forEach((fn) => fn());
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
      plugin={
        { actions, app: { isMobile: false }, ...GRADE_INTERVALS_ON } as never
      }
      reviewView={{ showMoreOptionsMenu: vi.fn(), leaf: makeLeaf() } as never}
      reviewManager={{} as never}
    >
      <ActionBar />
    </ReviewContextProvider>
  );
}

/** The two pages the bar renders, which it lays out differently. */
const PAGES = ['home', 'review'] as const;

/**
 * Stand-in for the plugin's `LeftoverWatch`, holding `count` leftovers;
 * `set` changes how many, telling its subscribers as the real one does.
 */
function makeLeftoverWatch(count: number) {
  const listeners = new Set<() => void>();
  const leftoversOf = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `left-${i}` }));
  let current = leftoversOf(count);
  return {
    get current() {
      return current;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    manage: vi.fn(async () => {}),
    set(n: number) {
      current = leftoversOf(n);
      listeners.forEach((listener) => listener());
    },
  };
}

function queryLeftoverButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('#manage-leftovers-button');
}

/** The leftover count shown on the leftover button, if any. */
function queryLeftoverCount(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    '#manage-leftovers-button .ir-leftover-count'
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
  item: MaybeMissingItem,
  {
    showAnswer = false,
    selectionMode = null,
    hasSelection = false,
    actions = makeActions(),
    reviewView = makeReviewView(),
  }: {
    showAnswer?: boolean;
    selectionMode?: SelectionKind | null;
    hasSelection?: boolean;
    actions?: ReturnType<typeof makeActions>;
    reviewView?: ReturnType<typeof makeReviewView>;
  } = {}
): HTMLElement {
  reduxState.page = 'review';
  reduxState.showAnswer = showAnswer;
  reduxState.selectionMode = selectionMode;
  reduxState.hasSelection = hasSelection;
  vi.spyOn(ReactQuery, 'useCurrentItem').mockReturnValue({
    data: item,
  } as never);
  return mountBar({ actions, reviewView });
}

/**
 * The view the bar hands to the actions that act on its editor, kept by the
 * test to check it is that view they are handed.
 */
function makeReviewView() {
  return { showMoreOptionsMenu: vi.fn(), leaf: makeLeaf() };
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

/**
 * A grade button, found by the word it shows, never the copy of the grades
 * laid out only for the bar to measure, which is hidden from everyone.
 */
function queryGradeButton(
  container: HTMLElement,
  grade: string
): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll('button')).find(
      (b) =>
        b.querySelector('.ir-grade-word')?.textContent === grade &&
        !b.closest('[aria-hidden="true"]')
    ) ?? null
  );
}

/** The real grade group, wherever it is, or null when there is none. */
function gradeGroup(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    '.ir-grade-group:not([aria-hidden="true"])'
  );
}

/**
 * Lay the bar out `width` px wide, everything in it 0px: room to spare for
 * the grades inline, at any width but none.
 */
function layOutBar(width: number) {
  const isBar = (el: HTMLElement) => el.classList.contains('ir-action-bar');
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(0, 0, isBar(this) ? width : 0, 30);
    }
  );
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(
    function (this: HTMLElement) {
      return [this.getBoundingClientRect()] as unknown as DOMRectList;
    }
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

/**
 * An item of `type` missing its file, carrying what the bar reads plus the
 * reference relinking names it by.
 */
function makeMissing(type: NoteType, dismissed = false): MaybeMissingItem {
  return {
    data: {
      id: `${type}-id`,
      type,
      dismissed,
      reference: `gone/${type}.md`,
    },
    file: null,
  } as never;
}

/**
 * Lay the start edge out `width` px wide, against no content: jsdom lays
 * nothing out, so everything else stays a 0px box with no client rects.
 */
function layOutLead(width: number) {
  const isLead = (el: HTMLElement) => el.classList.contains('ir-bar-lead');
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(0, 0, isLead(this) ? width : 0, isLead(this) ? 30 : 0);
    }
  );
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(
    function (this: HTMLElement) {
      return (isLead(this)
        ? [new DOMRect(0, 0, width, 30)]
        : []) as unknown as DOMRectList;
    }
  );
}

// #endregion

// lucide-react resolves `useContext` against its own preact copy, which is not
// the instance rendering here (see the react→preact aliasing TODO in
// vitest.config.ts). The icons are incidental to this component's behavior.
vi.mock('lucide-react', () => ({
  ArchiveRestore: () => null,
  ArrowLeft: () => null,
  ArrowRight: () => null,
  Ban: () => null,
  FileQuestionMark: () => null,
  CalendarSync: () => null,
  Check: () => null,
  EllipsisVertical: () => null,
  Eye: () => null,
  FileText: () => null,
  House: () => null,
  Scissors: () => null,
  SkipForward: () => null,
  TextSelect: () => null,
  Trash2: () => null,
  Undo2: () => null,
  X: () => null,
}));

// react-redux is mocked rather than spied on because its exports are
// non-configurable: `vi.spyOn(ReactRedux, 'useDispatch')` throws
// "Cannot redefine property". This is the documented cannot-be-spied case.
const dispatch = vi.fn();
// The bar branches on `state.page`, so tests set it before mounting. Read
// through the selector at render time, which is after this initializes.
const defaultReduxState = {
  page: 'home' as 'home' | 'review',
  currentItemId: null as string | null,
  showAnswer: false,
  typesToReview: { article: true, snippet: true, card: true },
  selectionMode: null as SelectionKind | null,
  hasSelection: false,
};
const reduxState = { ...defaultReduxState };
vi.mock('react-redux', () => ({
  useDispatch: () => dispatch,
  useSelector: (selector: (state: unknown) => unknown) => selector(reduxState),
  useStore: () => ({ getState: () => reduxState, dispatch }),
}));

describe('ActionBar', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    dispatch.mockClear();
    Object.assign(reduxState, defaultReduxState);
    store.dispatch(resetSession());
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

    it('starts at the top of the queue, not at the item left open', async () => {
      // The store keeps the last item while the home screen is up. Landing on
      // it would resume wherever the user last was; the queue picks the first
      // due item once review holds none.
      wireQueue({ totalRows: 3 });
      reduxState.currentItemId = 'left-open';
      store.dispatch(setCurrentItemId('left-open'));
      const [first, second] = [makeItem('article'), makeItem('snippet')];
      const getDue = vi.fn().mockResolvedValue({ all: [first, second] });

      const container = mountBar();
      beginReviewButton(container).click();
      for (const [action] of dispatch.mock.calls) store.dispatch(action);

      expect(store.getState().currentItemId).toBeNull();
      expect(store.getState().page).toBe('review');
      // What the review pane shows for that: the queue's first due item.
      const shown = await currentItemQueryFn(
        { getDue } as never,
        store.getState().currentItemId
      );
      expect(shown).toBe(first);
      expect(store.getState().currentItemId).toBe(first.data.id);
    });

    it('explains why it is unavailable when nothing is due', () => {
      const due = beginReviewLabel({ totalRows: 3 });
      const empty = beginReviewLabel({ totalRows: 0 });

      expect(due).not.toBe('');
      expect(empty).not.toBe('');
      expect(empty).not.toBe(due);
    });
  });

  describe('begin review button, beyond whether it is enabled', () => {
    // A contract on the cache key rather than on what renders: the button and
    // the table must ask for the same page, or the two read separate cache
    // entries that can disagree about whether anything is due
    it('reads the queue page the table shows, so both share one fetch', () => {
      wireQueue({ totalRows: 3 });

      mountBar();

      expect(ReactQuery.useQueue).toHaveBeenCalledWith({
        slice: {
          pageNumber: 0,
          entriesPerPage: QUEUE_TABLE_DEFAULT_ENTRIES_PER_PAGE,
        },
      });
    });
  });

  describe('begin review button over a queue that cannot be read', () => {
    it('property: is disabled, and says the queue could not be loaded', () => {
      fc.assert(
        fc.property(
          fc.boolean(),
          fc.nat({ max: 500 }),
          (hasData, totalRows) => {
            try {
              const others = [
                beginReviewLabel({ totalRows: 3 }),
                beginReviewLabel({ totalRows: 0 }),
              ];
              wireQueue({ isError: true, hasData, totalRows });
              const container = mountBar();
              const button = beginReviewButton(container);
              button.click();

              expect(button.disabled).toBe(true);
              const label = button.getAttribute('aria-label');
              expect(label).toBeTruthy();
              expect(others).not.toContain(label);
              expect(dispatch).not.toHaveBeenCalled();
            } finally {
              document.body.innerHTML = '';
              dispatch.mockClear();
              vi.restoreAllMocks();
            }
          }
        )
      );
    });
  });

  describe('bulk import button', () => {
    it('shows on the home screen alone', () => {
      fc.assert(
        fc.property(fc.constantFrom(...PAGES), (page) => {
          wireQueue();
          if (page === 'home') reduxState.page = 'home';
          else wireCurrentItem();

          const container = mountBar();

          expect(bulkImportButton(container) !== null).toBe(page === 'home');
          render(null, container);
          Object.assign(reduxState, defaultReduxState);
        })
      );
    });

    it('sits in the leading zone, ahead of the leftover button', () => {
      // The user asked for it on the left, before "manage leftover notes".
      wireQueue();
      const container = mountBar({ leftovers: makeLeftoverWatch(2) });

      const bulk = bulkImportButton(container)!;
      const leftover = queryLeftoverButton(container)!;
      expect(bulk.parentElement).toBe(zone(container, 'lead'));
      expect(
        bulk.compareDocumentPosition(leftover) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });

    it('opens the bulk import dialog, whether or not anything is due', () => {
      fc.assert(
        fc.property(
          fc.record({
            totalRows: fc.nat(3),
            isLoading: fc.boolean(),
            isError: fc.boolean(),
          }),
          (queue) => {
            wireQueue(queue);
            const openBulkImport = vi.fn();
            const container = mountBar({ openBulkImport });

            const button = bulkImportButton(container)!;
            expect(button.disabled).toBe(false);
            expect(openBulkImport).not.toHaveBeenCalled();
            button.click();

            expect(openBulkImport).toHaveBeenCalledOnce();
            expect(dispatch).not.toHaveBeenCalled();
            render(null, container);
          }
        )
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

  describe('button for notes not found in the database', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      wireQueue();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it.each(
      PAGES.flatMap((page) => [null, 0, 1, 3].map((count) => ({ page, count })))
    )(
      'shows on the $page page with $count leftovers only on the home page while there are some',
      async ({ page, count }) => {
        reduxState.page = page;
        if (page === 'review') wireCurrentItem();
        const container = mountBar({
          leftovers: count === null ? undefined : makeLeftoverWatch(count),
        });
        await settle();

        expect(queryLeftoverButton(container) !== null).toBe(
          page === 'home' && count !== null && count > 0
        );
      }
    );

    it('leads the start edge, after the arrows and bulk import, leaving the middle zone to the begin-review button', async () => {
      const container = mountBar({ leftovers: makeLeftoverWatch(1) });
      await settle();

      expect(zoneChildren(container, 'lead')).toEqual([
        navigateButton(container, 'back'),
        navigateButton(container, 'forward'),
        bulkImportButton(container),
        queryLeftoverButton(container),
      ]);
      expect(zoneChildren(container, 'center')).toEqual([
        beginReviewButton(container),
      ]);
      expect(barChildren(container).map((el) => el.className)).toEqual([
        'ir-bar-lead',
        'ir-bar-center',
        'ir-bar-trail',
      ]);
    });

    it.each([
      [1, '1', /\b1 note\b/],
      [7, '7', /\b7 notes\b/],
      [150, '99+', /\b150 notes\b/],
    ])(
      'shows %i leftovers as "%s" on the button, its label counting them for its tooltip',
      async (count, shown, label) => {
        const container = mountBar({ leftovers: makeLeftoverWatch(count) });
        await settle();

        const badge = queryLeftoverCount(container)!;
        expect(badge.textContent).toBe(shown);
        // Read out through the button's label, not twice
        expect(badge.getAttribute('aria-hidden')).toBe('true');
        expect(
          queryLeftoverButton(container)!.getAttribute('aria-label')
        ).toMatch(label);
      }
    );

    it('asks the plugin to look again and manage them when clicked', async () => {
      const leftovers = makeLeftoverWatch(2);
      const container = mountBar({ leftovers });
      await settle();

      queryLeftoverButton(container)!.click();

      expect(leftovers.manage).toHaveBeenCalledOnce();
    });

    it('comes and goes as leftovers are found and resolved, with no other re-render', async () => {
      const leftovers = makeLeftoverWatch(0);
      const container = mountBar({ leftovers });
      await settle();
      expect(queryLeftoverButton(container)).toBeNull();

      leftovers.set(1);
      await settle();
      expect(queryLeftoverButton(container)).not.toBeNull();
      expect(queryLeftoverCount(container)!.textContent).toBe('1');

      leftovers.set(4);
      await settle();
      expect(queryLeftoverCount(container)!.textContent).toBe('4');
      expect(
        queryLeftoverButton(container)!.getAttribute('aria-label')
      ).toMatch(/\b4 notes\b/);

      leftovers.set(0);
      await settle();
      expect(queryLeftoverButton(container)).toBeNull();
      expect(container.querySelector('.ir-leftover-count')).toBeNull();
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

      expect(undoButton(container).getAttribute('aria-label')).toBeTruthy();
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

      expect(undoButton(container).getAttribute('aria-label')).toContain(
        'creating snippet "excerpt"'
      );
    });

    it('follows the top of the stack rather than the first entry', async () => {
      const actions = makeActions();
      const container = mountReviewBar(actions);
      actions.push('skipping "first"');
      await settle();

      actions.push('creating snippet "second"');
      await settle();

      const label = undoButton(container).getAttribute('aria-label');
      expect(label).toContain('creating snippet "second"');
      expect(label).not.toContain('first');
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

  describe('navigation buttons', () => {
    const pageArb = fc.constantFrom(...PAGES);
    const lengthArb = fc.nat({ max: 3 });

    beforeEach(() => {
      vi.useFakeTimers();
      wireQueue();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('lead the bar, on the home screen and in review', async () => {
      // They stand in for the arrows at the start of the view header, so they
      // come before anything else.
      for (const page of PAGES) {
        reduxState.page = page;
        const container = mountBar();
        await settle();

        const [back, forward, next] = zoneChildren(container, 'lead');
        expect(back.id).toBe('navigate-back-button');
        expect(forward.id).toBe('navigate-forward-button');
        // In review the session's own actions follow them in the same zone. On
        // the home screen bulk import does, and begin-review has the middle.
        if (page === 'home') {
          expect(next).toBe(bulkImportButton(container));
          expect(zoneChildren(container, 'center')).toEqual([
            beginReviewButton(container),
          ]);
        } else {
          expect(next.getAttribute('aria-label')).toBe('Go to home screen');
        }
        render(null, container);
      }
    });

    it('are marked as stand-ins for the header arrows, and are the only session actions that are', async () => {
      // styles.css shows the marked controls only while Obsidian hides the view
      // header, which draws its own arrows. Home, the type filter and undo have
      // no counterpart there, so they stay whatever the header does.
      for (const page of PAGES) {
        reduxState.page = page;
        const container = mountBar();
        await settle();

        const standIns = zoneChildren(container, 'lead').filter((el) =>
          el.classList.contains('ir-header-standin')
        );
        expect(standIns).toEqual([
          navigateButton(container, 'back'),
          navigateButton(container, 'forward'),
        ]);
        render(null, container);
      }
    });

    it('are enabled exactly when the tab has history that way', async () => {
      await fc.assert(
        fc.asyncProperty(
          pageArb,
          lengthArb,
          lengthArb,
          async (page, back, forward) => {
            reduxState.page = page;
            const leaf = makeLeaf({ back, forward });
            const container = mountBar({ leaf });
            try {
              await settle();

              expect(navigateButton(container, 'back').disabled).toBe(
                back === 0
              );
              expect(navigateButton(container, 'forward').disabled).toBe(
                forward === 0
              );
            } finally {
              render(null, container);
              container.remove();
            }
          }
        ),
        { numRuns: 30 }
      );
    });

    it('say where they go, whether or not they can', async () => {
      const labels = [];
      for (const length of [0, 1]) {
        const container = mountBar({
          leaf: makeLeaf({ back: length, forward: length }),
        });
        await settle();

        labels.push(
          (['back', 'forward'] as const).map((direction) =>
            navigateButton(container, direction).getAttribute('aria-label')
          )
        );
        render(null, container);
      }

      const [[back, forward], whenAble] = labels;
      expect(back).toBeTruthy();
      expect(forward).toBeTruthy();
      expect(back).not.toBe(forward);
      expect(whenAble).toEqual([back, forward]);
    });

    it('move through the tab history once per click', async () => {
      const leaf = makeLeaf({ back: 1, forward: 1 });
      const container = mountBar({ leaf });
      await settle();

      navigateButton(container, 'back').click();

      expect(leaf.history.back).toHaveBeenCalledTimes(1);
      expect(leaf.history.forward).not.toHaveBeenCalled();

      navigateButton(container, 'forward').click();

      expect(leaf.history.forward).toHaveBeenCalledTimes(1);
      expect(leaf.history.back).toHaveBeenCalledTimes(1);
    });

    it('do nothing when clicked with nowhere to go', async () => {
      const leaf = makeLeaf({ back: 0, forward: 0 });
      const container = mountBar({ leaf });
      await settle();

      navigateButton(container, 'back').click();
      navigateButton(container, 'forward').click();

      expect(leaf.history.back).not.toHaveBeenCalled();
      expect(leaf.history.forward).not.toHaveBeenCalled();
    });

    it('follow the tab history as it changes, with no other re-render', async () => {
      // Recording a place pushes onto the leaf's stacks without touching the
      // store, so only history-change can bring the buttons up to date.
      const leaf = makeLeaf();
      const container = mountBar({ leaf });
      await settle();
      expect(navigateButton(container, 'back').disabled).toBe(true);
      expect(navigateButton(container, 'forward').disabled).toBe(true);

      leaf.history.backHistory.push({});
      leaf.emitHistoryChange();
      await settle();

      expect(navigateButton(container, 'back').disabled).toBe(false);
      expect(navigateButton(container, 'forward').disabled).toBe(true);

      leaf.history.forwardHistory.push({});
      leaf.history.backHistory.pop();
      leaf.emitHistoryChange();
      await settle();

      expect(navigateButton(container, 'back').disabled).toBe(true);
      expect(navigateButton(container, 'forward').disabled).toBe(false);
    });
  });

  describe('layout zones', () => {
    // The bar is three zones wide: the actions that act on the review session
    // at the start edge, the item's own actions in the middle, the ⋮ at the end
    // edge. styles.css centers the middle zone on the bar by giving the outer
    // two equal width, which holds only while all three are in the DOM — so the
    // zones are asserted present even on the pages that leave them empty.
    beforeEach(() => {
      vi.useFakeTimers();
      wireQueue();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('are all three there, in order, on every page', async () => {
      for (const page of PAGES) {
        reduxState.page = page;
        const container = mountBar();
        await settle();

        expect(barChildren(container).map((el) => el.className)).toEqual([
          'ir-bar-lead',
          'ir-bar-center',
          'ir-bar-trail',
        ]);
        render(null, container);
      }
    });

    it('put the session actions at the start edge in review', async () => {
      wireCurrentItem();
      const container = mountBar();
      await settle();

      expect(zoneChildren(container, 'lead')).toEqual([
        navigateButton(container, 'back'),
        navigateButton(container, 'forward'),
        getButton(container, 'Go to home screen'),
        typeFilter(container),
        undoButton(container),
        jointSeparator(container),
      ]);
    });

    it('are followed by bulk import alone at the start edge on the home screen', async () => {
      // Nothing there acts on a review session, and the begin-review button is
      // the middle zone's whole contents.
      reduxState.page = 'home';
      const container = mountBar();
      await settle();

      expect(zoneChildren(container, 'lead')).toEqual([
        navigateButton(container, 'back'),
        navigateButton(container, 'forward'),
        bulkImportButton(container),
      ]);
      expect(zoneChildren(container, 'center')).toEqual([
        beginReviewButton(container),
      ]);
    });

    it('give the end edge the ⋮ and nothing else', async () => {
      wireCurrentItem();
      const container = mountBar();
      await settle();

      expect(zoneChildren(container, 'trail')).toEqual([
        moreOptionsButton(container),
      ]);
    });

    it('keep the ⋮ out of the middle zone it used to trail', async () => {
      // It belongs to the view rather than to the item, and the item actions
      // are what the middle zone centers — a ⋮ left among them would drag that
      // center off by half its width.
      wireCurrentItem();
      const container = mountBar();
      await settle();

      const center = zone(container, 'center');
      expect(center.querySelector('#more-options-button')).toBeNull();
      expect(zoneChildren(container, 'center')[0]).toBe(
        getButton(container, 'Show answer')
      );
    });

    it('close the start edge with a separator after undo, whatever the item', async () => {
      // Whatever leads the middle zone — mark reviewed, show answer, a grade,
      // skip, confirm — sits right after undo once the bar packs.
      const screens = [
        ...ITEM_TYPES.map((type) => ({ item: makeItem(type) })),
        { item: makeItem('card'), showAnswer: true },
        { item: makeMissing('article') },
        { item: makeItem('article'), selectionMode: 'snippet' as const },
      ];
      for (const { item, ...state } of screens) {
        const container = mountItemBar(item, state);
        await settle();

        const lead = zoneChildren(container, 'lead');
        expect(lead.slice(-2)).toEqual([
          undoButton(container),
          jointSeparator(container),
        ]);
        // Drawn as the bar's other separators are
        expect(jointSeparator(container).getAttribute('role')).toBe(
          'separator'
        );
        expect(jointSeparator(container).classList).toContain(
          'ir-bar-separator'
        );
        render(null, container);
      }
    });

    it('leave the separator out while there is no item for it to part undo from', async () => {
      // Review before the first item arrives, and the summary once the queue
      // runs out: the middle zone is empty
      reduxState.page = 'review';
      const container = mountBar();
      await settle();

      expect(zoneChildren(container, 'center')).toEqual([]);
      expect(zoneChildren(container, 'lead')).toEqual([
        navigateButton(container, 'back'),
        navigateButton(container, 'forward'),
        getButton(container, 'Go to home screen'),
        typeFilter(container),
        undoButton(container),
      ]);
    });

    it('leave the end edge empty wherever there is no ⋮', async () => {
      // The home screen has no item behind one, and neither does review
      // before the first item arrives.
      for (const page of PAGES) {
        reduxState.page = page;
        const container = mountBar();
        await settle();

        expect(zoneChildren(container, 'trail')).toEqual([]);
        render(null, container);
      }
    });
  });

  describe('start edge packing', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          disconnect() {}
        }
      );
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('marks the start edge packed once it has no room to spare', async () => {
      layOutLead(0);
      const container = mountItemBar(makeItem('article'));
      await settle();

      expect(zone(container, 'lead').classList).toContain('is-packed');
    });

    it('leaves it unmarked while it has room', async () => {
      layOutLead(500);
      const container = mountItemBar(makeItem('article'));
      await settle();

      expect(zone(container, 'lead').classList).not.toContain('is-packed');
      expect(zone(container, 'lead').classList).toContain('ir-bar-lead');
    });

    it('keeps the classes others put on the start edge as it packs', async () => {
      // Obsidian hears of a tab moving windows (`onWindowMigrated`) by a
      // class on the element it is asked to watch
      Object.defineProperty(HTMLElement.prototype, 'onWindowMigrated', {
        configurable: true,
        value(this: HTMLElement) {
          this.classList.add('node-insert-event');
          return () => {};
        },
      });
      try {
        layOutLead(0);
        const container = mountItemBar(makeItem('article'));
        await settle();

        expect([...zone(container, 'lead').classList]).toEqual(
          expect.arrayContaining([
            'ir-bar-lead',
            'node-insert-event',
            'is-packed',
          ])
        );
      } finally {
        Reflect.deleteProperty(HTMLElement.prototype, 'onWindowMigrated');
      }
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

    it('is marked as a stand-in for the header ⋮', () => {
      // styles.css shows it only while Obsidian hides the view header, whose
      // own ⋮ opens the same menu.
      wireCurrentItem();

      const container = mountBar();

      expect(moreOptionsButton(container)?.classList).toContain(
        'ir-header-standin'
      );
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
        it('extracts a snippet from what this tab shows', () => {
          const actions = makeActions();
          const reviewView = makeReviewView();
          const container = mountItemBar(makeItem(screen.type), {
            ...screen,
            actions,
            reviewView,
          });

          getButton(container, 'Create snippet').click();

          expect(actions.extract).toHaveBeenCalledExactlyOnceWith(
            'snippet',
            reviewView
          );
        });

        it('makes a card from what this tab shows', () => {
          const actions = makeActions();
          const reviewView = makeReviewView();
          const container = mountItemBar(makeItem(screen.type), {
            ...screen,
            actions,
            reviewView,
          });

          getButton(container, 'Create card').click();

          expect(actions.extract).toHaveBeenCalledExactlyOnceWith(
            'card',
            reviewView
          );
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

  describe.each(ITEM_TYPES)('actions on a missing %s', (type) => {
    it('skips it, dismisses it, or restores it, whatever the answer state', () => {
      for (const showAnswer of [false, true]) {
        const actions = makeActions();
        const item = makeMissing(type);
        const container = mountItemBar(item, { actions, showAnswer });

        getButton(container, 'Skip for current review session').click();
        getButton(container, 'Stop scheduling this item for review').click();

        expect(actions.skipItem).toHaveBeenCalledWith(item);
        expect(actions.dismissItem).toHaveBeenCalledWith(item);
        expect(queryButton(container, 'Restore item to queue')).toBeNull();
        document.body.innerHTML = '';
      }

      const actions = makeActions();
      const dismissed = makeMissing(type, true);
      const container = mountItemBar(dismissed, { actions });
      getButton(container, 'Restore item to queue').click();
      expect(actions.unDismissItem).toHaveBeenCalledWith(dismissed);
    });

    it('leaves relinking to the placeholder, the queue and the command', () => {
      const container = mountItemBar(makeMissing(type));

      expect(queryButton(container, 'Relink file…')).toBeNull();
      expect(
        Array.from(zone(container, 'center').querySelectorAll('button')).map(
          (button) => button.getAttribute('aria-label')
        )
      ).toEqual([
        'Skip for current review session',
        'Stop scheduling this item for review',
      ]);
    });

    it('gives way to the selection controls in selection mode', () => {
      const container = mountItemBar(makeMissing(type), {
        selectionMode: 'snippet',
      });

      expect(
        queryButton(container, 'Skip for current review session')
      ).toBeNull();
      expect(queryButton(container, 'Relink file…')).toBeNull();
      expect(
        container.querySelector('#confirm-selection-button')
      ).not.toBeNull();
    });

    it('offers nothing that needs its file', () => {
      for (const showAnswer of [false, true]) {
        const container = mountItemBar(makeMissing(type), { showAnswer });

        for (const label of [
          'Mark reviewed',
          'Create snippet',
          'Create card',
          'Change scheduling strategy',
          'Show answer',
        ]) {
          expect(queryButton(container, label)).toBeNull();
        }
        for (const [grade] of GRADES) {
          expect(queryGradeButton(container, grade)).toBeNull();
        }
        expect(moreOptionsButton(container)).not.toBeNull();
        document.body.innerHTML = '';
      }
    });
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
        expect(container.querySelector('.ir-grade-group')).toBeNull();
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

      it('puts the grades in a row of their own after the bar until they are measured', () => {
        // jsdom has no ResizeObserver to measure with
        const container = mountItemBar(makeItem('card'), { showAnswer: true });

        const row = container.querySelector('.ir-action-bar')
          ?.nextElementSibling as HTMLElement | null;
        expect(row?.className).toBe('ir-grade-row');
        expect(Array.from(row?.children ?? [])).toEqual([
          gradeGroup(container),
        ]);
      });

      describe('where the grades do not fit inline', () => {
        beforeEach(() => {
          vi.useFakeTimers();
          vi.stubGlobal(
            'ResizeObserver',
            class {
              observe() {}
              disconnect() {}
            }
          );
          // No room at all
          layOutBar(0);
        });

        afterEach(() => {
          vi.useRealTimers();
          vi.unstubAllGlobals();
        });

        it('puts them in a row of their own after the bar, and the middle zone goes on without them', async () => {
          const container = mountItemBar(makeItem('card'), {
            showAnswer: true,
          });
          await settle();

          const row = container.querySelector('.ir-action-bar')
            ?.nextElementSibling as HTMLElement | null;
          expect(row?.className).toBe('ir-grade-row');
          expect(Array.from(row?.children ?? [])).toEqual([
            gradeGroup(container),
          ]);
          expect(
            zone(container, 'center').querySelector('.ir-grade-group')
          ).toBeNull();
          expect(zoneChildren(container, 'center')[0]).toBe(
            getButton(container, 'Create snippet')
          );
        });
      });

      describe('where the grades fit inline', () => {
        beforeEach(() => {
          vi.useFakeTimers();
          vi.stubGlobal(
            'ResizeObserver',
            class {
              observe() {}
              disconnect() {}
            }
          );
          layOutBar(1000);
        });

        afterEach(() => {
          vi.useRealTimers();
          vi.unstubAllGlobals();
        });

        it('puts them first in the middle zone, and has no row', async () => {
          const container = mountItemBar(makeItem('card'), {
            showAnswer: true,
          });
          await settle();

          expect(zoneChildren(container, 'center')[0]).toBe(
            gradeGroup(container)
          );
          expect(container.querySelector('.ir-grade-row')).toBeNull();
        });

        it.each(GRADES)(
          'grades the card %s from there',
          async (grade, rating) => {
            const actions = makeActions();
            const card = makeItem('card');
            const container = mountItemBar(card, { showAnswer: true, actions });
            await settle();
            expect(
              zone(container, 'center').contains(gradeGroup(container))
            ).toBe(true);

            queryGradeButton(container, grade)?.click();

            expect(actions.gradeCard).toHaveBeenCalledExactlyOnceWith(
              card,
              rating
            );
          }
        );
      });

      it('gives way to the selection controls in selection mode', () => {
        const container = mountItemBar(makeItem('card'), {
          showAnswer: true,
          selectionMode: 'snippet',
        });

        expect(container.querySelector('.ir-grade-group')).toBeNull();
        expect(container.querySelector('.ir-grade-row')).toBeNull();
      });

      it('shows no grades on the home screen, though the store keeps the card', () => {
        reduxState.showAnswer = true;
        reduxState.page = 'home';
        wireQueue();
        vi.spyOn(ReactQuery, 'useCurrentItem').mockReturnValue({
          data: makeItem('card'),
        } as never);

        const container = mountBar();

        expect(container.querySelector('.ir-grade-group')).toBeNull();
        expect(container.querySelector('.ir-grade-row')).toBeNull();
      });

      it('lays a hidden copy of the grades out last in the bar, for it to measure', () => {
        const container = mountItemBar(makeItem('card'), { showAnswer: true });

        const ghost = barChildren(container).at(-1);
        expect(ghost?.className).toBe('ir-grade-ghost');
        expect(
          ghost?.querySelector('.ir-grade-group')?.getAttribute('aria-hidden')
        ).toBe('true');
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

  describe('in selection mode', () => {
    const KINDS: SelectionKind[] = ['snippet', 'card'];
    const screens = ITEM_TYPES.flatMap((type) =>
      KINDS.map((kind) => ({ type, kind }))
    );

    function confirmButton(container: HTMLElement) {
      return container.querySelector<HTMLButtonElement>(
        '#confirm-selection-button'
      );
    }

    function cancelButton(container: HTMLElement) {
      return container.querySelector<HTMLButtonElement>(
        '#cancel-selection-button'
      );
    }

    describe.each(screens)('making a $kind from a $type', ({ type, kind }) => {
      it('offers confirm and cancel in place of the item actions', () => {
        const container = mountItemBar(makeItem(type), { selectionMode: kind });

        expect(zoneChildren(container, 'center')).toEqual([
          confirmButton(container),
          cancelButton(container),
        ]);
      });

      it('leaves the session actions and the ⋮ where they are', () => {
        const container = mountItemBar(makeItem(type), { selectionMode: kind });

        expect(zoneChildren(container, 'lead')).toContain(
          getButton(container, 'Go to home screen')
        );
        expect(zoneChildren(container, 'trail')).toEqual([
          moreOptionsButton(container),
        ]);
      });

      // With nothing selected too: confirming then says what is missing and
      // stays in the mode, which is `confirmSelection`'s to do.
      it.each([false, true])(
        'confirms the selection in this tab (text selected: %s)',
        (hasSelection) => {
          const actions = makeActions();
          const reviewView = makeReviewView();
          const container = mountItemBar(makeItem(type), {
            selectionMode: kind,
            hasSelection,
            actions,
            reviewView,
          });

          confirmButton(container)?.click();

          expect(actions.confirmSelection).toHaveBeenCalledExactlyOnceWith(
            reviewView
          );
          expect(actions.cancelSelection).not.toHaveBeenCalled();
        }
      );

      // A button that read "Select text" until something was selected proved
      // confusing, so it reads the same either way.
      it('looks the same whether or not text is selected', () => {
        const confirmLook = (hasSelection: boolean) => {
          const container = mountItemBar(makeItem(type), {
            selectionMode: kind,
            hasSelection,
          });
          const button = confirmButton(container);
          const look = {
            text: button?.textContent,
            label: button?.getAttribute('aria-label'),
          };
          render(null, container);
          return look;
        };

        const unselected = confirmLook(false);

        expect(unselected.text).toBeTruthy();
        expect(unselected).toEqual(confirmLook(true));
      });

      it('cancels the selection in this tab', () => {
        const actions = makeActions();
        const reviewView = makeReviewView();
        const container = mountItemBar(makeItem(type), {
          selectionMode: kind,
          actions,
          reviewView,
        });

        cancelButton(container)?.click();

        expect(actions.cancelSelection).toHaveBeenCalledExactlyOnceWith(
          reviewView
        );
        expect(actions.confirmSelection).not.toHaveBeenCalled();
      });

      it.each([false, true])(
        'names what confirming and cancelling are for (text selected: %s)',
        (hasSelection) => {
          const container = mountItemBar(makeItem(type), {
            selectionMode: kind,
            hasSelection,
          });
          const noun = kind === 'snippet' ? /snippet/ : /card/;

          expect(confirmButton(container)?.getAttribute('aria-label')).toMatch(
            noun
          );
          expect(cancelButton(container)?.getAttribute('aria-label')).toMatch(
            noun
          );
        }
      );
    });

    it('offers neither outside the mode', () => {
      for (const type of ITEM_TYPES) {
        const container = mountItemBar(makeItem(type));

        expect(confirmButton(container)).toBeNull();
        expect(cancelButton(container)).toBeNull();
        render(null, container);
      }
    });
  });
});
