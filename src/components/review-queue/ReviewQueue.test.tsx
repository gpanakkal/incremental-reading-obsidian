// @vitest-environment jsdom
import * as ReviewContext from '#/components/ReviewContext';
import type { QueuePage, QueueRow } from '#/components/types';
import * as ReactQuery from '#/hooks/useReactQuery';
import { QUEUE_TABLE_DEFAULT_ENTRIES_PER_PAGE } from '#/lib/constants';
import type ReviewManager from '#/lib/items/ReviewManager';
import type { TFile } from 'obsidian';
import type { ComponentChild } from 'preact';
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewQueue } from './ReviewQueue';

// #region HELPERS

/** Render a component into a detached jsdom container and return it. */
function mount(node: ComponentChild): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(node as never, container);
  return container;
}

function makeQueueRow(overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    id: 'a1',
    type: 'article',
    file: { path: 'articles/a1.md' } as TFile,
    due: new Date(2026, 6, 10),
    reference: 'articles/a1.md',
    parent: null,
    scheduling: { kind: 'priority', value: '30' },
    ...overrides,
  };
}

/**
 * Stub the queue's three collaborators: the plugin context, the paged query,
 * and the redux dispatch the row click uses.
 */
function wireQueue({
  rows = [makeQueueRow()],
  totalRows = 1,
  isLoading = false,
  /**
   * The dated span of the whole queue, which bounds the date field. Left open
   * by default: most tests hand over one page of a queue they declare much
   * larger via `totalRows`, so deriving the span from those rows would bound
   * the field to the page and clamp dates the test means to be reachable.
   * Tests about bounds set these explicitly.
   */
  firstDue = null,
  lastDue = null,
  /**
   * What the query holds while loading. Undefined models the very first load;
   * a page object models a later page change, where the previous page's data
   * is still cached.
   */
  dataWhileLoading,
  findPageForDate = vi.fn().mockResolvedValue(0),
}: {
  rows?: QueueRow[];
  totalRows?: number;
  isLoading?: boolean;
  firstDue?: Date | null;
  lastDue?: Date | null;
  dataWhileLoading?: Partial<QueuePage>;
  findPageForDate?: ReturnType<typeof vi.fn>;
} = {}) {
  const page: QueuePage = { rows, totalRows, firstDue, lastDue };
  const reviewManager = { findPageForDate } as unknown as ReviewManager;
  vi.spyOn(ReviewContext, 'useReviewContext').mockReturnValue({
    plugin: { app: { isMobile: false }, settings: { dayRolloverOffset: 4 } },
    reviewManager,
  } as never);
  vi.spyOn(ReactQuery, 'useQueue').mockReturnValue({
    data: isLoading ? dataWhileLoading && { ...page, ...dataWhileLoading } : page,
    isLoading,
  } as never);
  return { findPageForDate };
}

function dateInput(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector('input[type="date"]');
}

/** Set the date input's value and commit it, as picking a date does. */
function enterDate(container: HTMLElement, value: string) {
  const input = dateInput(container);
  if (!input) throw new Error('no date input rendered');
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The visible-range label's text, or null when it is not rendered. */
function rangeLabel(container: HTMLElement): string | null {
  return (
    container.querySelector('.ir-queue-visible-range')?.textContent ?? null
  );
}

/** Press a key in the date input. */
function pressKey(container: HTMLElement, key: string) {
  const input = dateInput(container);
  if (!input) throw new Error('no date input rendered');
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

/**
 * Drain the microtask queue so the findPageForDate promise resolves and the
 * resulting Preact state update renders. No wall-clock timer is involved.
 */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

// #endregion

// lucide-react resolves `useContext` against its own preact copy, which is not
// the instance rendering here (see the react→preact aliasing TODO in
// vitest.config.ts). The icons are incidental to this component's behavior.
vi.mock('lucide-react', () => ({
  BrainCog: () => null,
  FileText: () => null,
  Scissors: () => null,
}));

// react-redux is mocked rather than spied on because its exports are
// non-configurable: `vi.spyOn(ReactRedux, 'useDispatch')` throws
// "Cannot redefine property". This is the documented cannot-be-spied case.
vi.mock('react-redux', () => ({
  useDispatch: () => vi.fn(),
  useSelector: () => undefined,
  useStore: () => ({ getState: () => ({}) }),
}));

describe('ReviewQueue', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('shows a loading spinner while the queue query is pending', () => {
    wireQueue({ isLoading: true });

    const container = mount(<ReviewQueue />);

    expect(container.querySelector('.ir-queue-loading')).not.toBeNull();
  });

  it('does not show the spinner once the queue has loaded', () => {
    wireQueue({ isLoading: false });

    const container = mount(<ReviewQueue />);

    expect(container.querySelector('.ir-queue-loading')).toBeNull();
  });

  it('keeps the date field and pagination mounted while a later page loads', () => {
    // Page changes are cache misses (pageNumber is part of the query key), so
    // isLoading goes true again mid-navigation. The controls must survive it,
    // or the field the user just typed into disappears under them.
    wireQueue({
      isLoading: true,
      dataWhileLoading: { rows: [makeQueueRow()], totalRows: 41 },
    });

    const container = mount(<ReviewQueue />);

    expect(container.querySelector('.ir-queue-loading')).not.toBeNull();
    expect(dateInput(container)).not.toBeNull();
    expect(container.querySelector('.ir-queue-pagination')).not.toBeNull();
  });

  it('navigates to the page reported for the entered date', async () => {
    const findPageForDate = vi.fn().mockResolvedValue(2);
    // 3 pages at the default 20 entries per page.
    wireQueue({ totalRows: 41, findPageForDate });
    const container = mount(<ReviewQueue />);

    enterDate(container, '2026-07-13');
    await flush();

    expect(findPageForDate).toHaveBeenCalledTimes(1);
    const [date, entriesPerPage] = findPageForDate.mock.calls[0] as [
      Date,
      number,
    ];
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(6);
    expect(date.getDate()).toBe(13);
    expect(entriesPerPage).toBe(QUEUE_TABLE_DEFAULT_ENTRIES_PER_PAGE);
    // The reported page 2 is displayed 1-based as the third of three.
    expect(
      container.querySelector('.ir-queue-pagination-indicator')?.textContent
    ).toBe('3 of 3');
  });

  it('navigates when the day already in view is re-entered', async () => {
    // The page in view opens on 8/1, so the field already shows 8/1 and
    // re-picking it changes nothing in the DOM. The user is still asking to go
    // to the *first* page holding an 8/1 item, which may be an earlier page.
    const findPageForDate = vi.fn().mockResolvedValue(0);
    wireQueue({
      rows: [makeQueueRow({ due: new Date(2026, 7, 1, 12, 0) })],
      totalRows: 101,
      findPageForDate,
    });
    const container = mount(<ReviewQueue />);
    expect(dateInput(container)?.value).toBe('2026-08-01');

    pressKey(container, 'Enter');
    await flush();

    expect(findPageForDate).toHaveBeenCalledTimes(1);
    const [date] = findPageForDate.mock.calls[0] as [Date];
    expect(date.getMonth()).toBe(7);
    expect(date.getDate()).toBe(1);
    expect(
      container.querySelector('.ir-queue-pagination-indicator')?.textContent
    ).toBe('1 of 6');
  });

  it('ignores a stale lookup that resolves after a newer one', async () => {
    // Two jumps in flight; the first resolves last. The page must reflect the
    // date the user entered most recently, not whichever lookup finished last.
    const deferred: ((page: number) => void)[] = [];
    const findPageForDate = vi.fn(
      () => new Promise<number>((resolve) => deferred.push(resolve))
    );
    wireQueue({ totalRows: 101, findPageForDate });
    const container = mount(<ReviewQueue />);

    enterDate(container, '2026-01-01');
    enterDate(container, '2026-12-31');
    expect(deferred).toHaveLength(2);
    deferred[1](4); // newest lookup answers first
    deferred[0](0); // stale lookup answers late
    await flush();

    // 101 rows at 20 per page → 6 pages; page 4 shows as "5 of 6".
    expect(
      container.querySelector('.ir-queue-pagination-indicator')?.textContent
    ).toBe('5 of 6');
  });

  it('places the date field before the previous-page button', () => {
    wireQueue({ totalRows: 41 });

    const container = mount(<ReviewQueue />);

    const focusable = [
      ...container.querySelectorAll('.ir-queue-controls button, input'),
    ];
    const [date, prev, next] = focusable;
    expect(date).toBe(dateInput(container));
    expect(prev.textContent).toBe('<');
    expect(next.textContent).toBe('>');
  });

  it('shows the review day the visible page opens on', () => {
    // makePlugin sets a +4h rollover, so 06:00 on the 10th is review day 10.
    wireQueue({
      rows: [makeQueueRow({ due: new Date(2026, 6, 10, 6, 0) })],
      totalRows: 41,
    });

    const container = mount(<ReviewQueue />);

    expect(dateInput(container)?.value).toBe('2026-07-10');
  });

  it('assigns a small-hours due time to the previous review day', () => {
    // 02:00 on the 10th precedes the +4h boundary, so it is still day 9.
    wireQueue({
      rows: [makeQueueRow({ due: new Date(2026, 6, 10, 2, 0) })],
      totalRows: 41,
    });

    const container = mount(<ReviewQueue />);

    expect(dateInput(container)?.value).toBe('2026-07-09');
  });

  it('falls back to the current review day when the first row has no due date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 20, 12, 0));
    wireQueue({ rows: [makeQueueRow({ due: null })], totalRows: 41 });

    const container = mount(<ReviewQueue />);

    expect(dateInput(container)?.value).toBe('2026-01-20');
    vi.useRealTimers();
  });

  it('shows a single day when every row on the page is due the same day', () => {
    wireQueue({
      rows: [
        makeQueueRow({ id: 'a', due: new Date(2026, 6, 31, 9, 0) }),
        makeQueueRow({ id: 'b', due: new Date(2026, 6, 31, 20, 0) }),
      ],
      totalRows: 41,
    });

    const container = mount(<ReviewQueue />);

    expect(rangeLabel(container)).toBe('2026/7/31');
  });

  it('shows the span of days when the page covers more than one', () => {
    // The case the label exists for: the page opens on 7/31 but runs into 8/1,
    // so the date field alone cannot describe what is on screen.
    wireQueue({
      rows: [
        makeQueueRow({ id: 'a', due: new Date(2026, 6, 31, 9, 0) }),
        makeQueueRow({ id: 'b', due: new Date(2026, 7, 1, 9, 0) }),
      ],
      totalRows: 41,
    });

    const container = mount(<ReviewQueue />);

    expect(rangeLabel(container)).toBe('2026/7/31 - 8/1');
    // The field still holds the day the page opens on, which is what a jump
    // to this page resolves against. Label and field answer different
    // questions, and on a mixed page they legitimately differ.
    expect(dateInput(container)?.value).toBe('2026-07-31');
  });

  it('bounds the span by review day, not raw due time', () => {
    // Both rows fall on review day 7/31 under the +4h rollover: 02:00 on 8/1
    // precedes the boundary that opens 8/1, so it still belongs to 7/31.
    wireQueue({
      rows: [
        makeQueueRow({ id: 'a', due: new Date(2026, 6, 31, 9, 0) }),
        makeQueueRow({ id: 'b', due: new Date(2026, 7, 1, 2, 0) }),
      ],
      totalRows: 41,
    });

    const container = mount(<ReviewQueue />);

    expect(rangeLabel(container)).toBe('2026/7/31');
  });

  it('closes the span at the last dated row, ignoring undated ones', () => {
    // Undated rows sort last and carry no day, so they cannot bound the span.
    wireQueue({
      rows: [
        makeQueueRow({ id: 'a', due: new Date(2026, 6, 31, 9, 0) }),
        makeQueueRow({ id: 'b', due: new Date(2026, 7, 1, 9, 0) }),
        makeQueueRow({ id: 'c', due: null }),
      ],
      totalRows: 41,
    });

    const container = mount(<ReviewQueue />);

    expect(rangeLabel(container)).toBe('2026/7/31 - 8/1');
  });

  it('labels a page of only undated rows as unscheduled', () => {
    wireQueue({
      rows: [
        makeQueueRow({ id: 'a', due: null }),
        makeQueueRow({ id: 'b', due: null }),
      ],
      totalRows: 41,
    });

    const container = mount(<ReviewQueue />);

    expect(rangeLabel(container)).toBe('Unscheduled');
  });

  it('groups the range label and date field ahead of the pagination', () => {
    wireQueue({ totalRows: 41 });

    const container = mount(<ReviewQueue />);

    // Document order across the whole bar: both date controls share the left
    // flank, and the pagination follows them.
    const parts = [
      ...container.querySelectorAll(
        '.ir-queue-visible-range, .ir-queue-controls button, input'
      ),
    ];
    const [label, date, prev, next] = parts;
    expect(label.className).toContain('ir-queue-visible-range');
    expect(date).toBe(dateInput(container));
    expect(prev.textContent).toBe('<');
    expect(next.textContent).toBe('>');
  });

  it('balances the pagination with an equal flank on each side', () => {
    // The pagination is centred by the two flanks sharing the leftover width,
    // so the empty right-hand one must exist even though it renders nothing.
    wireQueue({ totalRows: 41 });

    const container = mount(<ReviewQueue />);

    const controls = container.querySelector('.ir-queue-controls');
    const flanks = controls?.querySelectorAll('.ir-queue-controls-flank');
    expect(flanks?.length).toBe(2);
    // The date controls occupy the first; the second is a pure spacer.
    expect(flanks?.[0].querySelector('.ir-queue-visible-range')).not.toBeNull();
    expect(flanks?.[0].querySelector('input[type="date"]')).not.toBeNull();
    expect(flanks?.[1].childNodes.length).toBe(0);
  });

  it('keeps the range label mounted while a later page loads', () => {
    wireQueue({
      isLoading: true,
      dataWhileLoading: { rows: [makeQueueRow()], totalRows: 41 },
    });

    const container = mount(<ReviewQueue />);

    expect(rangeLabel(container)).not.toBeNull();
  });

  it('renders the title inside the panel, above the controls', () => {
    wireQueue({ totalRows: 41 });

    const container = mount(<ReviewQueue />);

    const panel = container.querySelector('.ir-queue-panel');
    const title = panel?.querySelector('.ir-queue-title');
    const controls = panel?.querySelector('.ir-queue-controls');
    if (!title || !controls) {
      throw new Error('title or controls not rendered inside the panel');
    }

    expect(title.textContent).toBe('Upcoming');
    expect(
      title.compareDocumentPosition(controls) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('puts the controls above the table inside the panel', () => {
    wireQueue({ totalRows: 41 });

    const container = mount(<ReviewQueue />);

    const panel = container.querySelector('.ir-queue-panel');
    const controls = panel?.querySelector('.ir-queue-controls');
    const table = panel?.querySelector('.ir-queue-table');
    if (!controls || !table) {
      throw new Error('controls or table not rendered inside the panel');
    }

    expect(
      controls.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('keeps the title outside the table, which scrolls independently', () => {
    // The heading must not sit in the table's scroll region, or it would
    // scroll away with the rows.
    wireQueue({ totalRows: 41 });

    const container = mount(<ReviewQueue />);

    const table = container.querySelector('.ir-queue-table');
    expect(table?.querySelector('.ir-queue-title')).toBeNull();
  });

  it('keeps the title and controls in the panel while a later page loads', () => {
    // The spinner replaces the table only; the heading and controls must stay
    // inside the panel so the bordered group does not reshape mid-navigation.
    wireQueue({
      isLoading: true,
      dataWhileLoading: { rows: [makeQueueRow()], totalRows: 41 },
    });

    const container = mount(<ReviewQueue />);

    const panel = container.querySelector('.ir-queue-panel');
    expect(panel?.querySelector('.ir-queue-title')).not.toBeNull();
    expect(panel?.querySelector('.ir-queue-controls')).not.toBeNull();
    expect(panel?.querySelector('.ir-queue-loading')).not.toBeNull();
    expect(panel?.querySelector('.ir-queue-table')).toBeNull();
  });

  it('bounds the date field by the whole queue, not the visible page', () => {
    // The page shows one day; the queue runs well past it. The field must
    // offer the whole extent, or paging forward by date would be impossible.
    wireQueue({
      rows: [makeQueueRow({ due: new Date(2026, 6, 10, 9, 0) })],
      totalRows: 101,
      firstDue: new Date(2026, 6, 10, 9, 0),
      lastDue: new Date(2026, 8, 4, 9, 0),
    });

    const container = mount(<ReviewQueue />);

    expect(dateInput(container)?.getAttribute('min')).toBe('2026-07-10');
    expect(dateInput(container)?.getAttribute('max')).toBe('2026-09-04');
  });

  it('bounds the field by review day, not raw due time', () => {
    // Under the +4h rollover an item due 02:00 on 9/5 belongs to review day
    // 9/4. A max of 9/5 would offer a day holding nothing, and picking it
    // would land back on the last page with the field unchanged — the exact
    // stuck-value bug the clamp exists to prevent, one day out.
    wireQueue({
      rows: [makeQueueRow({ due: new Date(2026, 6, 10, 9, 0) })],
      totalRows: 101,
      firstDue: new Date(2026, 6, 10, 2, 0),
      lastDue: new Date(2026, 8, 5, 2, 0),
    });

    const container = mount(<ReviewQueue />);

    // 02:00 on 7/10 is review day 7/9; 02:00 on 9/5 is review day 9/4.
    expect(dateInput(container)?.getAttribute('min')).toBe('2026-07-09');
    expect(dateInput(container)?.getAttribute('max')).toBe('2026-09-04');
  });

  it('leaves the field unbounded when the queue holds no dated rows', () => {
    wireQueue({
      rows: [makeQueueRow({ due: null })],
      totalRows: 1,
      firstDue: null,
      lastDue: null,
    });

    const container = mount(<ReviewQueue />);

    expect(dateInput(container)?.hasAttribute('min')).toBe(false);
    expect(dateInput(container)?.hasAttribute('max')).toBe(false);
  });

  it('looks up the clamped date when one past the end is entered', async () => {
    // The reported bug: picking a date beyond the last one with items left the
    // field showing that date while the table sat on the last page. The clamp
    // must reach the lookup, so the day requested is the day that can actually
    // be shown rather than one no page opens on.
    const findPageForDate = vi.fn().mockResolvedValue(5);
    wireQueue({
      rows: [makeQueueRow({ due: new Date(2026, 8, 4, 9, 0) })],
      totalRows: 101,
      firstDue: new Date(2026, 6, 10, 9, 0),
      lastDue: new Date(2026, 8, 4, 9, 0),
      findPageForDate,
    });
    const container = mount(<ReviewQueue />);

    enterDate(container, '2026-12-25');
    await flush();

    expect(findPageForDate).toHaveBeenCalledTimes(1);
    const [date] = findPageForDate.mock.calls[0] as [Date];
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(8);
    expect(date.getDate()).toBe(4);
    // The field settles on the day the landed page opens on, which for a
    // clamped jump is the bound itself — not the date that was entered.
    expect(dateInput(container)?.value).toBe('2026-09-04');
  });

  describe('row change animation', () => {
    /** Whether the table is currently marked as having changed rows. */
    function isMarked(container: HTMLElement) {
      return (
        container
          .querySelector('.ir-queue-table')
          ?.classList.contains('ir-queue-table-changed') ?? false
      );
    }

    it('does not animate the queue in on first load', () => {
      // Nothing moved yet — there is no previous page for the rows to have
      // replaced, so the opening render must be still.
      wireQueue({ totalRows: 101 });

      const container = mount(<ReviewQueue />);

      expect(isMarked(container)).toBe(false);
    });

    it('animates the rows when a date jump lands on another page', async () => {
      // The case the cue exists for: a jump moves the table without the user
      // touching it, and on a clamped jump the date field lands where it
      // started, leaving the rows the only thing that visibly moved.
      const findPageForDate = vi.fn().mockResolvedValue(3);
      wireQueue({ totalRows: 101, findPageForDate });
      const container = mount(<ReviewQueue />);
      expect(isMarked(container)).toBe(false);

      enterDate(container, '2026-09-15');
      await flush();

      expect(isMarked(container)).toBe(true);
    });

    it('does not animate when a refetch leaves the page unchanged', async () => {
      // An item rescheduled under the user re-renders the table on the same
      // page. Flickering on every ordinary review action would make the cue
      // meaningless.
      const findPageForDate = vi.fn().mockResolvedValue(0);
      wireQueue({ totalRows: 101, findPageForDate });
      const container = mount(<ReviewQueue />);

      // Jump resolves to the page already shown, so nothing moves.
      enterDate(container, '2026-07-10');
      await flush();

      expect(isMarked(container)).toBe(false);
    });

    it('re-keys the table so the animation replays on each page change', async () => {
      // A CSS animation only runs when the node mounts, so a reused node would
      // stay still on the second jump. The key must change with the page to
      // force a fresh node.
      const findPageForDate = vi.fn().mockResolvedValue(2);
      wireQueue({ totalRows: 101, findPageForDate });
      const container = mount(<ReviewQueue />);

      enterDate(container, '2026-08-01');
      await flush();
      const first = container.querySelector('.ir-queue-table');
      expect(isMarked(container)).toBe(true);

      findPageForDate.mockResolvedValue(4);
      enterDate(container, '2026-09-01');
      await flush();
      const second = container.querySelector('.ir-queue-table');

      expect(isMarked(container)).toBe(true);
      // A different DOM node, which is what restarts the animation.
      expect(second).not.toBe(first);
    });
  });

  describe('empty queue', () => {
    it('keeps the title above the empty message', () => {
      wireQueue({ rows: [], totalRows: 0 });

      const container = mount(<ReviewQueue />);

      const panel = container.querySelector('.ir-queue-panel');
      const title = panel?.querySelector('.ir-queue-title');
      const placeholder = panel?.querySelector('.ir-review-placeholder');
      if (!title || !placeholder) {
        throw new Error('title or placeholder not rendered inside the panel');
      }

      expect(title.textContent).toBe('Upcoming');
      expect(placeholder.textContent).toContain('Nothing due for review');
      expect(
        title.compareDocumentPosition(placeholder) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });

    it('drops the controls, which have nothing to act on', () => {
      wireQueue({ rows: [], totalRows: 0 });

      const container = mount(<ReviewQueue />);

      expect(container.querySelector('.ir-queue-controls')).toBeNull();
      expect(container.querySelector('.ir-queue-table')).toBeNull();
    });
  });
});
