import type { QueueRow } from '#/components/types';
import { BrainCog, FileText, Scissors } from 'lucide-react';
import type { ComponentChild } from 'preact';

/** Keys of the renderable queue columns (`id`/`file` are never rendered). */
export type QueueColumnKey = 'type' | 'due' | 'scheduling' | 'reference';

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
  /** Optional extra class for the cell. */
  className?: string;
}

/** Display order for the queue: type, due, reference, then scheduling. */
export const QUEUE_COLUMN_ORDER: QueueColumnKey[] = [
  'type',
  'due',
  'reference',
  'scheduling',
];

/** Header labels rendered at the top of each queue column. */
export const QUEUE_COLUMN_HEADERS: Partial<Record<QueueColumnKey, string>> = {
  type: 'Type',
  due: 'Due',
  reference: 'File',
  scheduling: 'Scheduling',
};

/**
 * Build the default queue columns. Kept as a factory (not a constant) so callers
 * always get a fresh array and future columns can depend on runtime config.
 */
export function buildQueueColumns(): QueueColumn[] {
  return [
    { key: 'due', mobileVisible: true },
    { key: 'type', mobileVisible: false },
    { key: 'scheduling', mobileVisible: false },
    { key: 'reference', mobileVisible: true, className: 'ir-queue-reference' },
  ];
}

const TYPE_ICONS: Record<QueueRow['type'], typeof FileText> = {
  article: FileText,
  snippet: Scissors,
  card: BrainCog,
};

/**
 * Placeholder icons for each item type until dedicated ones are designed.
 * The `aria-label` must sit on an HTML wrapper, not the SVG itself: Obsidian's
 * tooltip handler calls `isShown()` (an HTMLElement-only augmentation) on
 * whichever element carries the label, and throws on SVG elements.
 */
function typeIcon(type: QueueRow['type']): ComponentChild {
  const Icon = TYPE_ICONS[type];
  return (
    <span className="ir-queue-type-icon" aria-label={type}>
      <Icon />
    </span>
  );
}

/**
 * Format a due date as `2026/7/10` (local time, no zero padding). A null due
 * (row has no due time) renders as `--` rather than the epoch.
 */
export function formatQueueDate(date: Date | null): string {
  if (date === null) return '--';
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

/** Human label for a row's scheduling kind, shown in-line beside the value. */
function schedulingLabel(row: QueueRow): string {
  switch (row.scheduling.kind) {
    case 'fixed-interval':
      return 'Interval';
    case 'priority':
      return 'Priority';
    case 'none':
      return '';
  }
}

/**
 * Map a `QueueRow` to the displayed content of each column. `row.due` already
 * has `due_fuzz` folded in by `ReviewManager.getQueue`, so it only needs
 * formatting here. The scheduling value is labelled in-line per row (data is
 * heterogeneous: priority vs. interval); cards without a value render an em
 * dash.
 */
export function renderQueueCells(
  row: QueueRow
): Record<QueueColumnKey, ComponentChild> {
  return {
    type: typeIcon(row.type),
    due: formatQueueDate(row.due),
    scheduling:
      row.scheduling.value === null ? (
        '—'
      ) : (
        <span>
          <span className="ir-queue-inline-label">{schedulingLabel(row)}: </span>
          {row.scheduling.value}
        </span>
      ),
    reference: row.reference,
  };
}
