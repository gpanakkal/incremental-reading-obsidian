import { MINIMUM_FIXED_REVIEW_INTERVAL } from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import { filterDigitInsertions, sanitizeDigitText } from '#/lib/numeric-input';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'react';

/**
 * `leading` takes the place of the label text on both sides of the input, e.g.
 * an icon button. It sits outside the `<label>` so a click on it never lands
 * on the input instead, and the input is named with `aria-label` in the text's
 * place.
 *
 * Escape drops the edit in progress and shows the stored interval again: the
 * one this field last saved, even before it comes back as `initialInterval`,
 * or else the one passed in.
 *
 * Only digits ever show: other characters are dropped from text as it goes in,
 * and from what reaches the input some other way. A text input rather than a
 * number one, which shows a sign, point or exponent typed into it while
 * reporting its value as empty, so the edit would read as a cleared field.
 */
export function FixedIntervalField({
  initialInterval,
  onBlur,
  leading,
}: {
  initialInterval: number | null;
  onBlur: (intervalDays: number) => void | Promise<void>;
  leading?: ComponentChildren;
}) {
  const hasLeading = leading !== undefined;
  const inputRef = useRef<HTMLInputElement>(null);
  // A plain listener, since preact only hears `onBeforeInput` in engines that
  // have an `onbeforeinput` property
  useEffect(() => filterDigitInsertions(inputRef.current!), []);
  /** The interval last stored, whether passed in or saved from here. */
  const [stored, setStored] = useState(initialInterval);
  /** The `initialInterval` of the last render. */
  const [seenInterval, setSeenInterval] = useState(initialInterval);
  /**
   * The edit in progress: the interval it cleans up to, and the text typed
   * when that changes nothing, which stays on screen until the edit ends so
   * clearing the field to type another number works.
   */
  const [draft, setDraft] = useState<{
    value: number;
    text: string | null;
  } | null>(null);

  // Follow a new stored interval, except the one this field just saved
  if (seenInterval !== initialInterval) {
    setSeenInterval(initialInterval);
    if (initialInterval !== null && stored !== initialInterval) {
      setStored(initialInterval);
      setDraft(null);
    }
  }

  const storedValue = stored ?? MINIMUM_FIXED_REVIEW_INTERVAL;
  const held = draft ? draft.value : storedValue;

  return (
    <>
      <div className="ir-fixed-interval-container">
        {leading}
        <label className={'ir-fixed-interval-label'}>
          {!hasLeading && 'Every'}
          <input
            ref={inputRef}
            id={'ir-fixed-interval-input'}
            aria-label={hasLeading ? 'Fixed interval in days' : undefined}
            value={
              draft ? (draft.text ?? String(draft.value)) : String(storedValue)
            }
            className={'ir-fixed-interval-input'}
            type="text"
            inputMode="numeric"
            onChange={(e) => {
              // Drops what got past the filter: compositions, drops, autofill
              const text = sanitizeDigitText(e.currentTarget.value);
              let value = held;
              try {
                value = IRScheduler.adjustFixedIntervalOnChange(text);
              } catch (_error) {
                /** Fall back to prior value */
              }
              setDraft({ value, text: value === held ? text : null });
            }}
            onBlur={() => {
              setStored(held);
              setDraft(null);
              void onBlur(held);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              } else if (e.key === 'Escape') {
                // Restored here rather than by the re-render, which would set
                // the value after select() and so drop the selection
                e.currentTarget.value = String(storedValue);
                setDraft(null);
                e.currentTarget.select();
              }
            }}
            onFocus={(e) => e.currentTarget.select()}
          />
          {!hasLeading && 'days'}
        </label>
      </div>
    </>
  );
}
