// @vitest-environment jsdom
import { ReviewContextProvider } from '#/components/ReviewContext';
import type { QueuePage } from '#/components/types';
import * as ReactQuery from '#/hooks/useReactQuery';
import type { ActionStackEntry } from '#/lib/Actions';
import type { ComponentChild } from 'preact';
import { render } from 'preact';
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
      plugin={{ actions } as never}
      reviewView={{} as never}
      reviewManager={{} as never}
    >
      <ActionBar />
    </ReviewContextProvider>
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
  BrainCog: () => null,
  Check: () => null,
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

      const container = mount(<ActionBar />);

      expect(beginReviewButton(container).disabled).toBe(false);
    });

    it('is disabled when nothing is due', () => {
      wireQueue({ totalRows: 0 });

      const container = mount(<ActionBar />);

      expect(beginReviewButton(container).disabled).toBe(true);
    });

    it('is disabled while the queue is still loading', () => {
      // Starting a review of a queue whose size is not yet known could land on
      // the empty-review placeholder, so the button waits for the count.
      wireQueue({ isLoading: true, hasData: false });

      const container = mount(<ActionBar />);

      expect(beginReviewButton(container).disabled).toBe(true);
    });

    it('does not navigate to the review page when nothing is due', () => {
      wireQueue({ totalRows: 0 });

      const container = mount(<ActionBar />);
      beginReviewButton(container).click();

      expect(dispatch).not.toHaveBeenCalled();
    });

    it('navigates to the review page when items are due', () => {
      wireQueue({ totalRows: 3 });

      const container = mount(<ActionBar />);
      beginReviewButton(container).click();

      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ payload: 'review' })
      );
    });

    it('explains why it is unavailable when nothing is due', () => {
      wireQueue({ totalRows: 0 });

      const container = mount(<ActionBar />);

      expect(beginReviewButton(container).getAttribute('aria-label')).toBe(
        'Nothing due for review'
      );
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
});
