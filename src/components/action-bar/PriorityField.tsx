import IRScheduler from '#/lib/IRScheduler';
import type { ComponentChildren } from 'preact';
import { useState } from 'react';

/**
 * Note: pass a `key` prop with the item's ID to ensure priority is updated
 * correctly when navigating to other items
 *
 * `leading` takes the place of the text label, e.g. an icon button. It sits
 * outside the `<label>` so a click on it never lands on the input instead, and
 * the input is named with `aria-label` in the text's place.
 *
 * Escape drops the edit in progress and shows the stored priority again: the
 * one this field last saved, even before it comes back as `initialPriority`,
 * or else the one passed in.
 */
export function PriorityField({
  initialPriority,
  onBlur,
  showMultiplier = false,
  leading,
}: {
  initialPriority: number;
  onBlur: (priority: number) => void | Promise<void>;
  showMultiplier?: boolean;
  leading?: ComponentChildren;
}) {
  const hasLeading = leading !== undefined;
  /** The priority last stored, whether passed in or saved from here. */
  const [stored, setStored] = useState(initialPriority);
  /** The `initialPriority` of the last render. */
  const [seenPriority, setSeenPriority] = useState(initialPriority);
  /**
   * The edit in progress: the display priority it cleans up to, and the text
   * typed when that changes nothing, which stays on screen until the edit ends
   * so a half-typed number like "4." isn't cut short.
   */
  const [draft, setDraft] = useState<{
    value: number;
    text: string | null;
  } | null>(null);

  // Follow a new stored priority, except the one this field just saved
  if (seenPriority !== initialPriority) {
    setSeenPriority(initialPriority);
    if (stored !== initialPriority) {
      setStored(initialPriority);
      setDraft(null);
    }
  }

  const storedText = String(stored / 10);
  const held = draft ? draft.value : stored / 10;

  return (
    <div className="ir-priority-container">
      {leading}
      <label className={'ir-priority-label'}>
        {!hasLeading && 'Priority'}
        <input
          id={'ir-priority-input'}
          aria-label={hasLeading ? 'Priority' : undefined}
          value={draft ? (draft.text ?? String(draft.value)) : storedText}
          className={'ir-priority-input'}
          type="text"
          inputMode="numeric"
          onChange={(e) => {
            const text = e.currentTarget.value;
            let value = held;
            try {
              value = IRScheduler.adjustDisplayPriorityOnChange(text);
            } catch (_error) {
              /* fall back to prior value */
            }
            setDraft({ value, text: value === held ? text : null });
          }}
          onBlur={() => {
            const transformed = IRScheduler.transformPriority(held);
            setStored(transformed);
            setDraft(null);
            void onBlur(transformed);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              // Restored here rather than by the re-render, which would set
              // the value after select() and so drop the selection
              e.currentTarget.value = storedText;
              setDraft(null);
              e.currentTarget.select();
            }
          }}
          onFocus={(e) => e.currentTarget.select()}
        />
        {showMultiplier && (
          <div>
            (
            {Math.round(
              IRScheduler.getIntervalMultiplier(
                IRScheduler.transformPriority(held)
              ) * 100
            ) / 100}
            x interval multiplier)
          </div>
        )}
      </label>
    </div>
  );
}
