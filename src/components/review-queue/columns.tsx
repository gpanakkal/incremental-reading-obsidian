import type { QueueCardMemory, QueueRow } from '#/components/types';
import { BrainCog, FileText, Scissors } from 'lucide-react';
import type { ComponentChild } from 'preact';

/** Keys of the renderable queue columns (`id`/`file` are never rendered). */
export type QueueColumnKey =
  | 'type'
  | 'due'
  | 'scheduling'
  | 'reference'
  | 'parent';

/**
 * How much horizontal space a column takes.
 * - `content`: only as wide as the widest of its content and its header, so
 *   short columns (type, due) stop wasting space on long-path rows.
 * - `flexible`: shares the leftover width with the other flexible columns.
 */
export type QueueColumnWidth = 'content' | 'flexible';

/**
 * Structural description of one queue-table column. Cell content is not
 * defined here: the table receives a `renderCells` callback that maps a row to
 * its displayed content per column key.
 */
export interface QueueColumn {
  /** Stable key; also emitted as `data-column` for styling/tests. */
  key: QueueColumnKey;
  /** Whether this column is shown when `app.isMobile` is true. */
  mobileVisible: boolean;
  /** Horizontal sizing behaviour; defaults to `flexible` when omitted. */
  width?: QueueColumnWidth;
  /** Optional extra class for the cell. */
  className?: string;
}

/** Display order for the queue: type, due, reference, parent, then scheduling. */
export const QUEUE_COLUMN_ORDER: QueueColumnKey[] = [
  'type',
  'due',
  'reference',
  'parent',
  'scheduling',
];

/** Header labels rendered at the top of each queue column. */
export const QUEUE_COLUMN_HEADERS: Partial<Record<QueueColumnKey, string>> = {
  type: 'Type',
  due: 'Due',
  reference: 'File',
  parent: 'Source / Parent',
  scheduling: 'Scheduling',
};

/**
 * Build the default queue columns. Kept as a factory (not a constant) so callers
 * always get a fresh array and future columns can depend on runtime config.
 */
export function buildQueueColumns(): QueueColumn[] {
  return [
    { key: 'due', mobileVisible: true, width: 'content' },
    { key: 'type', mobileVisible: false, width: 'content' },
    // Scheduling and parent stay visible on mobile: the narrow-layout CSS wraps
    // them onto a second line rather than dropping them.
    { key: 'scheduling', mobileVisible: true, width: 'content' },
    {
      key: 'reference',
      mobileVisible: true,
      width: 'flexible',
      className: 'ir-queue-reference',
    },
    {
      key: 'parent',
      mobileVisible: true,
      width: 'flexible',
      className: 'ir-queue-reference',
    },
  ];
}

const TYPE_ICONS: Record<QueueRow['type'], typeof FileText> = {
  article: FileText,
  snippet: Scissors,
  card: BrainCog,
};

/**
 * Placeholder icons for each item type until dedicated ones are designed.
 * The icon carries no label of its own: the enclosing cell is labelled with
 * this row's type (see `queueCellTitles`), and a second label nested inside it
 * would render a tooltip on top of the cell's own.
 */
function typeIcon(type: QueueRow['type']): ComponentChild {
  const Icon = TYPE_ICONS[type];
  return (
    <span className="ir-queue-type-icon">
      <Icon />
    </span>
  );
}

/** Placeholder for a cell with nothing to show. */
const EMPTY_CELL = '—';

/**
 * Format a due date as `2026/7/10` (local time, no zero padding). A null due
 * (row has no due time) renders as `--` rather than the epoch.
 */
export function formatQueueDate(date: Date | null): string {
  if (date === null) return '--';
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

/**
 * Format a span of review days the way {@link formatQueueDate} formats a
 * single one, dropping the leading segments the end shares with the start:
 * `2026/7/31 - 8/1`, `2026/8/2 - 3`, `2026/12/31 - 2027/1/1`. A span of one
 * day is just that day.
 *
 * Eliding is left-anchored: a differing segment forces every segment after it
 * to be shown, since `2026/8/2 - 3` only reads as August because the month was
 * omitted. Comparing dates rather than formatted strings keeps that decision
 * independent of how a segment happens to render.
 */
export function formatQueueDateRange(start: Date, end: Date): string {
  const sameYear = start.getFullYear() === end.getFullYear();
  const sameMonth = sameYear && start.getMonth() === end.getMonth();
  if (sameMonth && start.getDate() === end.getDate()) {
    return formatQueueDate(start);
  }

  const month = end.getMonth() + 1;
  const day = end.getDate();
  let tail: string;
  if (!sameYear) tail = `${end.getFullYear()}/${month}/${day}`;
  else if (!sameMonth) tail = `${month}/${day}`;
  else tail = `${day}`;

  return `${formatQueueDate(start)} - ${tail}`;
}

/**
 * Human label for the origin column, which holds different things per type:
 * an article's imported-from note is its source, while a snippet or card was
 * extracted from a parent item (or a non-item note)
 */
export function originLabel(type: QueueRow['type']): string {
  return type === 'article' ? 'Source' : 'Parent';
}

/** Human label for a row's scheduling kind, shown in-line beside the value. */
function schedulingLabel(row: QueueRow): string {
  switch (row.scheduling.kind) {
    case 'fixed-interval':
      return 'Interval';
    case 'priority':
      return 'Priority';
    case 'srs':
      return '';
  }
}

/**
 * A card's memory state as label/value pairs, in D, S, R order. Retrievability
 * is a probability so it gets two decimals; difficulty and stability are open
 * scales where one decimal is enough to compare rows at a glance. A card that
 * has never been reviewed has no retrievability.
 */
export function cardMemoryParts(
  memory: QueueCardMemory
): { label: string; value: string }[] {
  return [
    { label: 'D', value: memory.difficulty.toFixed(1) },
    { label: 'S', value: memory.stability.toFixed(1) },
    {
      label: 'R',
      value:
        memory.retrievability === null
          ? '--'
          : memory.retrievability.toFixed(2),
    },
  ];
}

/**
 * Plain-text memory state (`D 5.2 · S 12.4 · R 0.90`) for the cell's tooltip,
 * which cannot hold the markup the cell itself uses.
 */
export function formatCardMemory(memory: QueueCardMemory): string {
  return cardMemoryParts(memory)
    .map((part) => `${part.label} ${part.value}`)
    .join(' · ');
}

function schedulingText(row: QueueRow): string {
  if (row.scheduling.kind === 'srs') {
    return formatCardMemory(row.scheduling.value);
  }
  return `${schedulingLabel(row)} ${row.scheduling.value}`;
}

/**
 * Map a `QueueRow` to the displayed content of each column
 */
export function renderQueueCells(
  row: QueueRow
): Record<QueueColumnKey, ComponentChild> {
  return {
    type: typeIcon(row.type),
    due: formatQueueDate(row.due),
    scheduling:
      row.scheduling.kind === 'srs' ? (
        <span className="ir-queue-card-memory">
          {cardMemoryParts(row.scheduling.value).map((part) => (
            <span key={part.label} className="ir-queue-card-memory-part">
              <span className="ir-queue-inline-label">{part.label} </span>
              {part.value}
            </span>
          ))}
        </span>
      ) : (
        <span>
          <span className="ir-queue-inline-label">{schedulingLabel(row)} </span>
          {row.scheduling.value}
        </span>
      ),
    reference: row.reference,
    parent: (
      <span>
        <span className="ir-queue-inline-label ir-queue-origin-label">
          {originLabel(row.type)}{' '}
        </span>
        {row.parent ?? EMPTY_CELL}
      </span>
    ),
  };
}

/**
 * Plain-text version of each cell, used as the cell's `title` so content the
 * column is too narrow to show is still readable on hover. Kept separate from
 * `renderQueueCells` because a title attribute cannot hold markup.
 */
export function queueCellTitles(row: QueueRow): Record<QueueColumnKey, string> {
  return {
    type: row.type,
    due: formatQueueDate(row.due),
    scheduling: schedulingText(row),
    reference: row.reference,
    parent: `${originLabel(row.type)} ${row.parent ?? EMPTY_CELL}`,
  };
}
