import type { QueueRow } from '#/components/types';
import type { ComponentChild } from 'preact';
import type { QueueColumn, QueueColumnKey } from './columns';

interface QueueTableProps {
  rows: QueueRow[];
  columns: QueueColumn[];
  /**
   * Column keys in display order. Columns not listed here keep their original
   * relative order and come after all listed ones. Omit to keep the `columns`
   * order as-is.
   */
  columnOrder?: QueueColumnKey[];
  /**
   * Text labels rendered as a header row, keyed by column key (e.g.
   * `{ reference: 'File' }`). Columns without an entry get an empty header
   * cell. Omit to render no header row.
   */
  columnHeaders?: Partial<Record<QueueColumnKey, string>>;
  /** Maps a row to the displayed content of each column. */
  renderCells: (row: QueueRow) => Record<QueueColumnKey, ComponentChild>;
  /**
   * Maps a row to the plain-text tooltip of each column, applied as the cell's
   * `aria-label` so text the column is too narrow to show is still readable on
   * hover. `aria-label` rather than `title`: Obsidian renders its own themed
   * tooltip for labelled elements, and a `title` would stack the browser's
   * default tooltip on top of it. Omit to render no tooltips.
   */
  cellTitles?: (row: QueueRow) => Record<QueueColumnKey, string>;
  /** Heading rendered above the table. Omit to render no title. */
  title?: string;
  /** When true, only columns with `mobileVisible` are rendered. */
  isMobile: boolean;
  onRowClick: (row: QueueRow) => void;
}

/** Apply `columnOrder`: listed columns first, unlisted ones after in place. */
function orderColumns(
  columns: QueueColumn[],
  order?: QueueColumnKey[]
): QueueColumn[] {
  if (!order) return columns;
  const listed = order
    .map((key) => columns.find((column) => column.key === key))
    .filter((column): column is QueueColumn => column !== undefined);
  const unlisted = columns.filter((column) => !order.includes(column.key));
  return [...listed, ...unlisted];
}

/**
 * Pure, presentational review-queue table. Column structure comes from a
 * `QueueColumn[]` config and cell content from the `renderCells` callback, so
 * it has no per-column logic of its own. Each cell carries a hover-reveal
 * action slot (empty by default) so row actions can be added later with no
 * structural change.
 */
export function QueueTable({
  rows,
  columns,
  columnOrder,
  columnHeaders,
  renderCells,
  cellTitles,
  title,
  isMobile,
  onRowClick,
}: QueueTableProps) {
  const visibleColumns = orderColumns(
    isMobile ? columns.filter((column) => column.mobileVisible) : columns,
    columnOrder
  );

  return (
    <div className="ir-queue-table" role="table">
      {title && <div className="ir-queue-title">{title}</div>}
      {columnHeaders && (
        <div className="ir-queue-header" role="row">
          {visibleColumns.map((column) => (
            <div
              key={column.key}
              className="ir-queue-header-cell"
              data-column={column.key}
              data-width={column.width ?? 'flexible'}
              role="columnheader"
            >
              {columnHeaders[column.key] ?? ''}
            </div>
          ))}
        </div>
      )}
      {rows.map((row) => {
        const cells = renderCells(row);
        const titles = cellTitles?.(row);
        return (
          <div
            key={row.id}
            className="ir-queue-row"
            data-type={row.type}
            role="row"
            tabIndex={0}
            onClick={() => onRowClick(row)}
          >
            {visibleColumns.map((column) => (
              <div
                key={column.key}
                className={`ir-queue-cell${
                  column.className ? ` ${column.className}` : ''
                }`}
                data-column={column.key}
                data-width={column.width ?? 'flexible'}
                role="cell"
                aria-label={titles?.[column.key]}
              >
                <span className="ir-queue-cell-value">{cells[column.key]}</span>
                <span className="ir-queue-cell-actions" />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
