// @vitest-environment jsdom
import type { QueuePage } from '#/components/types';
import * as ReactQuery from '#/hooks/useReactQuery';
import type { ComponentChild } from 'preact';
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
}));

// react-redux is mocked rather than spied on because its exports are
// non-configurable: `vi.spyOn(ReactRedux, 'useDispatch')` throws
// "Cannot redefine property". This is the documented cannot-be-spied case.
const dispatch = vi.fn();
vi.mock('react-redux', () => ({
  useDispatch: () => dispatch,
  // The bar branches on `state.page`; 'home' is the screen the begin-review
  // button lives on, and the only one these tests are about.
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({ page: 'home', showAnswer: false }),
  useStore: () => ({ getState: () => ({ page: 'home' }) }),
}));

describe('ActionBar', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    dispatch.mockClear();
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
});
