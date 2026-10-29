import {
  MAXIMUM_FIXED_REVIEW_INTERVAL,
  MAXIMUM_PRIORITY,
  MINIMUM_FIXED_REVIEW_INTERVAL,
  MINIMUM_PRIORITY,
} from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import type { SchedulingStrategy } from '#/lib/types';
import { useRef, useState } from 'react';
import { FixedIntervalField } from './action-bar/FixedIntervalField';
import { PriorityField } from './action-bar/PriorityField';
import { SegmentGroup, STRATEGY_SEGMENTS, type Segment } from './SegmentGroup';

/** What the import dialogs ask before importing: how to schedule, and where. */
export interface ImportOptionValues {
  strategy: SchedulingStrategy;
  priority: number;
  fixedIntervalDays: number;
  /** Shown only while a copy can be made; see {@link ImportOptionsFields}. */
  makeCopy: boolean;
}

/**
 * The import options, starting at `priority`, at `intervalDays` (or the
 * shortest fixed interval) and at `makeCopy`, with priority scheduling.
 * `current` reads them as last updated: Enter in a field blurs it, which
 * updates them, and confirms in the same event, before they render anew.
 */
export function useImportOptions(initial: {
  priority: number;
  intervalDays: number | null;
  makeCopy: boolean;
}) {
  const [values, setValues] = useState<ImportOptionValues>({
    strategy: 'priority',
    priority: initial.priority,
    fixedIntervalDays: initial.intervalDays ?? MINIMUM_FIXED_REVIEW_INTERVAL,
    makeCopy: initial.makeCopy,
  });
  const latestRef = useRef(values);
  const update = (updates: Partial<ImportOptionValues>) => {
    latestRef.current = { ...latestRef.current, ...updates };
    setValues(latestRef.current);
  };
  return { values, update, current: () => latestRef.current };
}

const COPY_SEGMENTS: Segment<boolean>[] = [
  { value: false, label: 'Import in place' },
  { value: true, label: 'Make a copy' },
];

const INTERVAL_TOOLTIP =
  `Number of days between reviews, from ` +
  `${MINIMUM_FIXED_REVIEW_INTERVAL} to ${MAXIMUM_FIXED_REVIEW_INTERVAL}.`;

const PRIORITY_TOOLTIP =
  `Priority is used to grow the time to the next review. Ranges from ` +
  `${IRScheduler.toDisplayPriority(MINIMUM_PRIORITY)} (slow growth, more frequent review) to ` +
  `${IRScheduler.toDisplayPriority(MAXIMUM_PRIORITY)} (fast growth, less frequent review).`;

/**
 * The controls for {@link ImportOptionValues}: priority or fixed-interval
 * scheduling, and in place or a copy when `canCopy`. The fields carry fixed
 * element ids, so only one of these may be mounted at a time.
 * @param initialInterval what the fixed-interval field starts at
 */
export function ImportOptionsFields({
  values,
  update,
  canCopy,
  initialInterval,
}: {
  values: ImportOptionValues;
  update: (updates: Partial<ImportOptionValues>) => void;
  canCopy: boolean;
  initialInterval: number | null;
}) {
  const { strategy, makeCopy } = values;
  return (
    <>
      <SegmentGroup
        segments={STRATEGY_SEGMENTS}
        value={strategy}
        onChange={(chosen) => update({ strategy: chosen })}
      />
      {strategy === 'priority' ? (
        <>
          <PriorityField
            initialPriority={values.priority}
            onBlur={(priority: number) => update({ priority })}
            showMultiplier
          />
          <div className="ir-scheduling-tooltip">{PRIORITY_TOOLTIP}</div>
        </>
      ) : (
        <>
          <FixedIntervalField
            initialInterval={initialInterval}
            onBlur={(intervalDays: number) =>
              update({ fixedIntervalDays: intervalDays })
            }
          />
          <div className="ir-scheduling-tooltip">{INTERVAL_TOOLTIP}</div>
        </>
      )}
      {canCopy && (
        <SegmentGroup
          segments={COPY_SEGMENTS}
          value={makeCopy}
          onChange={(chosen) => update({ makeCopy: chosen })}
        />
      )}
    </>
  );
}
