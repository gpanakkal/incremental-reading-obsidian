import type { QueueRow } from '#/components/types';
import type { ComponentChild } from 'preact';
import { useEffect, useRef } from 'react';
import type { QueueColumn, QueueColumnKey } from './columns';

/** Where a row's menu opens, in client coordinates. */
export interface MenuPosition {
  x: number;
  y: number;
}

/** How long a touch has to be held still to open a row's menu. */
export const LONG_PRESS_MS = 500;
/** How far a held touch may drift, per axis, and still be a long press. */
export const LONG_PRESS_SLOP_PX = 10;

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
  /** When true, only columns with `mobileVisible` are rendered. */
  isMobile: boolean;
  /**
   * When true, the table fades in to mark that its rows are not the ones that
   * were just on screen. Purely presentational: the caller decides what counts
   * as a change, and must also give the table a `key` that changes with it, or
   * the node is reused and the animation does not replay.
   */
  changed?: boolean;
  onRowClick: (row: QueueRow) => void;
  /**
   * Opens `row`'s menu at `position`. Given, each row gets a menu: on right
   * click, on a touch held still for {@link LONG_PRESS_MS} (iOS sends no
   * `contextmenu` for one), and from a ⋯ button in its last cell's action
   * slot. Omitted, rows have no menu.
   */
  onRowMenu?: (row: QueueRow, position: MenuPosition) => void;
}

/** A touch being held on a row, which becomes a long press unless let go. */
interface Press {
  row: QueueRow;
  x: number;
  y: number;
  timer: number;
}

/**
 * Long-press tracking for the rows of one table, one touch at a time.
 *
 * A long press ends in a release, and on some platforms a `contextmenu` and a
 * `click` as well; the row pressed swallows those, or one menu would open twice
 * and the row open under it. The swallowing ends at the next press, since a
 * platform that sends no click would otherwise eat the next real tap.
 *
 * The queue can refresh under a held touch, so the menu opens on the row as it
 * is by then, and not at all once the row has left the table.
 */
function useLongPress(
  onRowMenu: ((row: QueueRow, position: MenuPosition) => void) | undefined,
  rows: QueueRow[]
) {
  const pressRef = useRef<Press | null>(null);
  const swallowingRef = useRef<string | null>(null);
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const cancel = () => {
    if (pressRef.current) window.clearTimeout(pressRef.current.timer);
    pressRef.current = null;
  };
  useEffect(() => cancel, []);

  return {
    swallowingRef,
    cancel,
    start(row: QueueRow, event: PointerEvent) {
      cancel();
      swallowingRef.current = null;
      // A mouse has right click, which opens the same menu at once
      if (!onRowMenu || event.pointerType === 'mouse') return;
      const { clientX: x, clientY: y } = event;
      const timer = window.setTimeout(() => {
        pressRef.current = null;
        const current = rowsRef.current.find(({ id }) => id === row.id);
        if (!current) return;
        swallowingRef.current = row.id;
        onRowMenu(current, { x, y });
      }, LONG_PRESS_MS);
      pressRef.current = { row, x, y, timer };
    },
    move(event: PointerEvent) {
      const held = pressRef.current;
      if (!held) return;
      if (
        Math.abs(event.clientX - held.x) > LONG_PRESS_SLOP_PX ||
        Math.abs(event.clientY - held.y) > LONG_PRESS_SLOP_PX
      ) {
        cancel();
      }
    },
  };
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
 * Pure, presentational review-queue table: header row and body rows only. The
 * heading and the navigation controls are the container's to place, since they
 * sit outside the table's scroll region and must stay put while it reloads.
 *
 * Column structure comes from a `QueueColumn[]` config and cell content from
 * the `renderCells` callback, so it has no per-column logic of its own. Each
 * cell carries a hover-reveal action slot (empty by default) so row actions
 * can be added later with no structural change.
 */
export function QueueTable({
  rows,
  columns,
  columnOrder,
  columnHeaders,
  renderCells,
  cellTitles,
  isMobile,
  changed = false,
  onRowClick,
  onRowMenu,
}: QueueTableProps) {
  const longPress = useLongPress(onRowMenu, rows);
  const visibleColumns = orderColumns(
    isMobile ? columns.filter((column) => column.mobileVisible) : columns,
    columnOrder
  );

  return (
    <div
      className={`ir-queue-table${changed ? ' ir-queue-table-changed' : ''}`}
      role="table"
    >
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
            data-missing={row.file === null ? '' : undefined}
            role="row"
            tabIndex={0}
            onClick={() => {
              if (longPress.swallowingRef.current === row.id) {
                longPress.swallowingRef.current = null;
                return;
              }
              onRowClick(row);
            }}
            onContextMenu={
              onRowMenu &&
              ((event: MouseEvent) => {
                event.preventDefault();
                longPress.cancel();
                // Already open from the long press this belongs to
                if (longPress.swallowingRef.current === row.id) return;
                onRowMenu(row, { x: event.clientX, y: event.clientY });
              })
            }
            onPointerDown={(event: PointerEvent) => longPress.start(row, event)}
            onPointerMove={(event: PointerEvent) => longPress.move(event)}
            onPointerUp={longPress.cancel}
            onPointerCancel={longPress.cancel}
          >
            {visibleColumns.map((column, index) => (
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
                <span className="ir-queue-cell-actions">
                  {onRowMenu && index === visibleColumns.length - 1 && (
                    // Text, not an icon: the label belongs on this HTML
                    // button, and Obsidian's tooltip crashes on a labelled SVG
                    <button
                      className="ir-queue-row-menu clickable-icon"
                      aria-label="Item actions"
                      // Its own tap opens the menu; holding it must not open
                      // a second through the row's long press
                      onPointerDown={(event: PointerEvent) =>
                        event.stopPropagation()
                      }
                      onClick={(event: MouseEvent) => {
                        event.stopPropagation();
                        const target = event.currentTarget as HTMLElement;
                        const rect = target.getBoundingClientRect();
                        onRowMenu(row, { x: rect.left, y: rect.bottom });
                      }}
                    >
                      ⋯
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
