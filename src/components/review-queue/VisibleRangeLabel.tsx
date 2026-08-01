import { formatQueueDateRange } from './columns';

interface VisibleRangeLabelProps {
  /** First and last review day on the page, or null when it holds none. */
  range: { start: Date; end: Date } | null;
}

/** Shown when no row on the page carries a due date. */
const UNSCHEDULED_LABEL = 'Unscheduled';

/**
 * The review day (or span of days) the visible page covers.
 *
 * This exists because the date field beside it cannot honestly do both jobs.
 * The field is a control — a date entered there jumps to the page where that
 * day *begins* — and a page can span several days, so the day the field holds
 * and the days on screen legitimately differ. Stating the span outright means
 * the field never has to stand in as a label for rows it does not describe.
 */
export function VisibleRangeLabel({ range }: VisibleRangeLabelProps) {
  return (
    <div className="ir-queue-visible-range">
      {range ? formatQueueDateRange(range.start, range.end) : UNSCHEDULED_LABEL}
    </div>
  );
}
