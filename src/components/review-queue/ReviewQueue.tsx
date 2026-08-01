import { useReviewContext } from '#/components/ReviewContext';
import type { QueueRow } from '#/components/types';
import { useQueue } from '#/hooks/useReactQuery';
import { QUEUE_TABLE_DEFAULT_ENTRIES_PER_PAGE } from '#/lib/constants';
import { setCurrentItemId, setPage } from '#/lib/store';
import { currentReviewDay, reviewDayOf } from '#/lib/utils';
import { useRef, useState } from 'react';
import { useDispatch } from 'react-redux';
import {
  buildQueueColumns,
  QUEUE_COLUMN_HEADERS,
  QUEUE_COLUMN_ORDER,
  queueCellTitles,
  renderQueueCells,
} from './columns';
import { DateJumpField } from './DateJumpField';
import { QueuePagination } from './QueuePagination';
import { QueueTable } from './QueueTable';
import { VisibleRangeLabel } from './VisibleRangeLabel';

const QUEUE_TABLE_TITLE = 'Upcoming';

export function ReviewQueue() {
  const { plugin, reviewManager } = useReviewContext();
  const dispatch = useDispatch();
  const [pageNumber, setPageNumber] = useState(0);
  /** Ticket for the most recent date lookup; older results are discarded. */
  const latestJump = useRef(0);
  /**
   * The page the table last rendered, so a page change can be told apart from
   * a first render or a same-page refetch. Null until the table has rendered
   * once, which is what keeps the opening load from animating.
   */
  const renderedPage = useRef<number | null>(null);

  const { data, isLoading } = useQueue({
    slice: {
      pageNumber,
      entriesPerPage: QUEUE_TABLE_DEFAULT_ENTRIES_PER_PAGE,
    },
  });

  function handleRowClick(row: QueueRow) {
    dispatch(setCurrentItemId(row.id));
    dispatch(setPage('review'));
  }

  /**
   * Jump to the page holding the first item due on or after `date`. The page
   * is resolved by the manager, which is the only place that knows the whole
   * queue's order — the client holds just the current page.
   *
   * Lookups are sequenced: two quick date entries can be in flight at once,
   * and without the token an earlier, slower one could land last and override
   * the date the user actually chose.
   */
  function handleJumpToDate(date: Date) {
    const token = ++latestJump.current;
    void reviewManager
      .findPageForDate(date, QUEUE_TABLE_DEFAULT_ENTRIES_PER_PAGE)
      .then((page) => {
        if (token === latestJump.current) setPageNumber(page);
      });
  }

  // First load has nothing to frame the spinner with; later page changes do,
  // and must keep the controls mounted (see below).
  if (isLoading && !data) {
    return (
      <div
        className="ir-queue-loading"
        role="status"
        aria-label="Loading queue"
      >
        <div className="ir-queue-spinner" />
      </div>
    );
  }

  if (!data || data.totalRows === 0) {
    return <div className="ir-review-placeholder">Nothing due for review.</div>;
  }

  const pageCount = Math.ceil(
    data.totalRows / QUEUE_TABLE_DEFAULT_ENTRIES_PER_PAGE
  );
  // getQueue clamps a stale too-high page (the queue can shrink between
  // renders), so mirror that clamp for the indicator and prev/next arithmetic.
  const currentPage = Math.min(pageNumber, pageCount - 1);

  // The review day the page opens on. Derived from the rows rather than held
  // in state so it stays right however the page changed — arrows, a date
  // jump, or a refetch after an item is rescheduled. Rows are due-ascending,
  // so the first one names the day. Undated rows sort last and cannot.
  const firstDue = data.rows[0]?.due;
  const visibleDay = firstDue
    ? reviewDayOf(firstDue, plugin.settings.dayRolloverOffset)
    : currentReviewDay(plugin.settings.dayRolloverOffset);

  // Whether the table is about to show a different page than the one it last
  // showed. False on the first render, so the queue does not animate itself in
  // on open — there is no previous page for it to have moved from.
  //
  // Recorded here rather than in an effect because the flag has to describe
  // *this* render: an effect would run after the DOM is painted, one render too
  // late to decide whether the node mounting now should animate. The spinner
  // render is deliberately skipped, since the table is unmounted then and has
  // not shown the new page yet — updating on it would consume the change and
  // leave the real render looking unchanged.
  const pageChanged =
    !isLoading &&
    renderedPage.current !== null &&
    renderedPage.current !== currentPage;
  if (!isLoading) renderedPage.current = currentPage;

  // The review days the queue as a whole spans, which bound the date field.
  // Converted with `reviewDayOf` for the same reason `visibleDay` is: the
  // field speaks in review days, so passing a raw due instant would offer a
  // boundary day that holds nothing. Under a +4h rollover an item due 02:00 on
  // 8/1 is review day 7/31, and a max of 8/1 would let the user pick a day
  // with no items — landing back on the same page with the field unchanged,
  // which is the very thing the clamp exists to prevent.
  const minDay = data.firstDue
    ? reviewDayOf(data.firstDue, plugin.settings.dayRolloverOffset)
    : undefined;
  const maxDay = data.lastDue
    ? reviewDayOf(data.lastDue, plugin.settings.dayRolloverOffset)
    : undefined;

  // The span of review days on screen, which the date field cannot express:
  // it holds the day the page *opens* on, while a page can run over several.
  // Rows are due-ascending and undated ones sort last, so the last dated row
  // closes the span; a page of only undated rows has no span at all.
  // Scanned back by hand rather than with `findLast`, which is ES2023 and so
  // outside both the ES2022 target and the configured `lib`.
  let lastDue: Date | null = null;
  for (let i = data.rows.length - 1; i >= 0; i--) {
    const { due } = data.rows[i];
    if (due !== null) {
      lastDue = due;
      break;
    }
  }
  const visibleRange =
    firstDue && lastDue
      ? {
          start: reviewDayOf(firstDue, plugin.settings.dayRolloverOffset),
          end: reviewDayOf(lastDue, plugin.settings.dayRolloverOffset),
        }
      : null;

  // Heading, controls, and table share one bordered panel and read as a single
  // object, so nothing divides them internally. The heading lives here rather
  // than in QueueTable because it must sit outside the table's scroll region
  // and stay put while the table reloads.
  return (
    <div className="ir-queue-panel">
      <div className="ir-queue-title">{QUEUE_TABLE_TITLE}</div>
      <div className="ir-queue-controls">
        {/* The date controls share the left flank; the right one is left empty
            to balance it. Both flanks take an equal share of whatever the
            pagination does not use, so the page indicator sits at the centre
            of the bar however wide the label and field grow. */}
        <div className="ir-queue-controls-flank">
          <VisibleRangeLabel range={visibleRange} />
          <DateJumpField
            value={visibleDay}
            min={minDay}
            max={maxDay}
            onJump={handleJumpToDate}
          />
        </div>
        <QueuePagination
          pageNumber={currentPage}
          pageCount={pageCount}
          onPageChange={setPageNumber}
        />
        <div className="ir-queue-controls-flank" aria-hidden="true" />
      </div>
      {isLoading ? (
        // A page change is a cache miss on the ['queue', subset] key, so the
        // query reports loading again. Only the table is swapped out; the
        // date field and pagination stay put, since replacing the controls
        // the user just acted on is disorienting.
        <div
          className="ir-queue-loading"
          role="status"
          aria-label="Loading queue"
        >
          <div className="ir-queue-spinner" />
        </div>
      ) : (
        <QueueTable
          // Fades the table in when, and only when, the page changed under the
          // user — the arrows, a date jump, or a jump clamped to the last page,
          // where the rows are the only thing that moves. The key restarts the
          // animation: changing it makes Preact build a fresh node, and a CSS
          // animation runs from the start on a node that has just mounted. A
          // same-page refetch keeps the key, so the node and its finished
          // animation are reused and nothing flickers during ordinary review.
          key={`page-${currentPage}`}
          changed={pageChanged}
          rows={data.rows}
          columns={buildQueueColumns()}
          columnOrder={QUEUE_COLUMN_ORDER}
          columnHeaders={QUEUE_COLUMN_HEADERS}
          renderCells={renderQueueCells}
          cellTitles={queueCellTitles}
          isMobile={plugin.app.isMobile}
          onRowClick={handleRowClick}
        />
      )}
    </div>
  );
}
