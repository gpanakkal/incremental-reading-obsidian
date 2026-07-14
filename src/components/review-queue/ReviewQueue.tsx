import { useReviewContext } from '#/components/ReviewContext';
import type { QueueRow } from '#/components/types';
import { useQueue } from '#/hooks/useReactQuery';
import { setCurrentItemId, setPage } from '#/lib/store';
import { useDispatch } from 'react-redux';
import {
  buildQueueColumns,
  QUEUE_COLUMN_HEADERS,
  QUEUE_COLUMN_ORDER,
  renderQueueCells,
} from './columns';
import { QueueTable } from './QueueTable';

export function ReviewQueue() {
  const { plugin } = useReviewContext();
  const dispatch = useDispatch();
  const { data: rows } = useQueue({ kind: 'due' });

  function handleRowClick(row: QueueRow) {
    dispatch(setCurrentItemId(row.id));
    dispatch(setPage('review'));
  }

  if (!rows || rows.length === 0) {
    return <div className="ir-review-placeholder">Nothing due for review.</div>;
  }

  return (
    <QueueTable
      rows={rows}
      columns={buildQueueColumns()}
      columnOrder={QUEUE_COLUMN_ORDER}
      columnHeaders={QUEUE_COLUMN_HEADERS}
      renderCells={renderQueueCells}
      isMobile={plugin.app.isMobile}
      onRowClick={handleRowClick}
    />
  );
}
