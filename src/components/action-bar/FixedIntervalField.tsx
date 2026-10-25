import {
  MAXIMUM_FIXED_REVIEW_INTERVAL,
  MINIMUM_FIXED_REVIEW_INTERVAL,
} from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'react';

/**
 * `leading` takes the place of the label text on both sides of the input, e.g.
 * an icon button. It sits outside the `<label>` so a click on it never lands
 * on the input instead, and the input is named with `aria-label` in the text's
 * place.
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
  const [fixedInterval, setFixedInterval] = useState<number>(
    initialInterval ?? MINIMUM_FIXED_REVIEW_INTERVAL
  );
  const prevIntervalRef = useRef(initialInterval);

  useEffect(
    function updateIntervalOnRerender() {
      if (
        initialInterval !== null &&
        prevIntervalRef.current !== initialInterval
      ) {
        prevIntervalRef.current = initialInterval;
        setFixedInterval(initialInterval);
      }
    },
    [initialInterval]
  );

  return (
    <>
      <div className="ir-fixed-interval-container">
        {leading}
        <label className={'ir-fixed-interval-label'}>
          {!hasLeading && 'Every'}
          <input
            id={'ir-fixed-interval-input'}
            aria-label={hasLeading ? 'Fixed interval in days' : undefined}
            value={fixedInterval}
            className={'ir-fixed-interval-input'}
            type="number"
            min={MINIMUM_FIXED_REVIEW_INTERVAL}
            max={MAXIMUM_FIXED_REVIEW_INTERVAL}
            step={1}
            inputMode="numeric"
            onChange={(e) => {
              try {
                const adjusted = IRScheduler.adjustFixedIntervalOnChange(
                  e.currentTarget.value
                );
                setFixedInterval(adjusted);
              } catch (_error) {
                /** Fall back to prior value */
              }
            }}
            onBlur={() => {
              prevIntervalRef.current = fixedInterval;
              void onBlur(fixedInterval);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              } else if (e.key === 'Escape') {
                setFixedInterval(fixedInterval);
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
