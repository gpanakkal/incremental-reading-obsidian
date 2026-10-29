import type { SchedulingStrategy } from '#/lib/types';

/** One choice of a {@link SegmentGroup}: its label and what it stands for. */
export interface Segment<T> {
  value: T;
  label: string;
}

/** The scheduling strategies, as an article's strategy group offers them. */
export const STRATEGY_SEGMENTS: Segment<SchedulingStrategy>[] = [
  { value: 'priority', label: 'Priority scheduling' },
  { value: 'fixed-interval', label: 'Fixed intervals' },
];

/**
 * A segmented button group (`.ir-segments`): a button a segment, in order,
 * the one whose value is `value` pressed (`aria-pressed`) and `.is-active`.
 * A press reports its segment's value, pressed already or not. Labels key
 * the buttons, so they must be distinct.
 */
export function SegmentGroup<T>({
  segments,
  value,
  onChange,
}: {
  segments: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="ir-segments" role="group">
      {segments.map((segment) => (
        <button
          key={segment.label}
          className={
            'ir-segment' + (segment.value === value ? ' is-active' : '')
          }
          aria-pressed={segment.value === value}
          onClick={() => onChange(segment.value)}
        >
          {segment.label}
        </button>
      ))}
    </div>
  );
}
