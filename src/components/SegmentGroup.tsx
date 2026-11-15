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
 *
 * From the keyboard it reads like a toggle extended to any number of
 * choices: Space on a focused segment reports the segment after the pressed
 * one, left to right and wrapping, and moves focus there, once however long
 * it is held. Enter presses nothing and bubbles on, so the dialog around
 * the group can confirm on it (see {@link confirmsOnEnter}).
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
    <div
      className="ir-segments"
      role="group"
      onKeyDown={(e) => {
        // Both keys would also run the focused button's own activation, a
        // click: Enter on keydown, Space on keyup (only while its keydown
        // went unprevented)
        if (e.key === 'Enter') {
          e.preventDefault();
        } else if (e.key === ' ') {
          e.preventDefault();
          // Once a press, like the button's own Space: held, it would spin
          // through the segments and stop wherever the release lands
          if (e.repeat) return;
          const next =
            (segments.findIndex((segment) => segment.value === value) + 1) %
            segments.length;
          onChange(segments[next].value);
          (e.currentTarget.children[next] as HTMLElement).focus();
        }
      }}
    >
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

/**
 * Whether a keydown is an Enter that should confirm the dialog it lands in:
 * from anywhere but a button, whose own Enter activation clicks it (Cancel
 * cancels), except a segment of a {@link SegmentGroup}, which leaves Enter
 * to the dialog. Tag check, not instanceof: a popout window has its own
 * HTMLButtonElement.
 */
export function confirmsOnEnter(e: {
  key: string;
  target: EventTarget | null;
}): boolean {
  if (e.key !== 'Enter') return false;
  const target = e.target as HTMLElement;
  return (
    target.tagName !== 'BUTTON' ||
    target.closest('.ir-segments[role="group"]') !== null
  );
}
