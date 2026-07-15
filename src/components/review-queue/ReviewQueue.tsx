import { useReviewContext } from '#/components/ReviewContext';
import type { QueueRow } from '#/components/types';
import { useQueue } from '#/hooks/useReactQuery';
import { QUEUE_TABLE_DEFAULT_ENTRIES_PER_PAGE } from '#/lib/constants';
import { setCurrentItemId, setPage } from '#/lib/store';
import { useState } from 'react';
import { useDispatch } from 'react-redux';
import {
  buildQueueColumns,
  QUEUE_COLUMN_HEADERS,
  QUEUE_COLUMN_ORDER,
  renderQueueCells,
} from './columns';
import { QueuePagination } from './QueuePagination';
import { QueueTable } from './QueueTable';

export function ReviewQueue() {
  const { plugin } = useReviewContext();
  const dispatch = useDispatch();
  const [pageNumber, setPageNumber] = useState(0);

  const { data } = useQueue({
    slice: {
      pageNumber,
      entriesPerPage: QUEUE_TABLE_DEFAULT_ENTRIES_PER_PAGE,
    },
  });

  function handleRowClick(row: QueueRow) {
    dispatch(setCurrentItemId(row.id));
    dispatch(setPage('review'));
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

  return (
    <>
      <QueuePagination
        pageNumber={currentPage}
        pageCount={pageCount}
        onPageChange={setPageNumber}
      />
      <QueueTable
        rows={data.rows}
        columns={buildQueueColumns()}
        columnOrder={QUEUE_COLUMN_ORDER}
        columnHeaders={QUEUE_COLUMN_HEADERS}
        renderCells={renderQueueCells}
        isMobile={plugin.app.isMobile}
        onRowClick={handleRowClick}
      />
    </>
  );
}
