import {
  MAXIMUM_FIXED_REVIEW_INTERVAL,
  MINIMUM_FIXED_REVIEW_INTERVAL,
} from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import { useState } from 'react';

export function FixedIntervalField({
  initialInterval,
  onBlur,
}: {
  initialInterval: number | null;
  onBlur: (intervalDays: number) => Promise<void>;
}) {
  const [fixedInterval, setFixedInterval] = useState<number>(
    initialInterval ?? MINIMUM_FIXED_REVIEW_INTERVAL
  );

  return (
    <>
      <div className="ir-fixed-interval-container">
        <label className={'ir-fixed-interval-label'}>
          Every
          <input
            id={'ir-fixed-interval-input'}
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
          days
        </label>
      </div>
    </>
  );
}
