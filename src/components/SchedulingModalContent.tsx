import {
  MAXIMUM_FIXED_REVIEW_INTERVAL,
  MAXIMUM_PRIORITY,
  MINIMUM_FIXED_REVIEW_INTERVAL,
  MINIMUM_PRIORITY,
} from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import type { SchedulingStrategy } from '#/lib/types';
import { useState } from 'react';
import { FixedIntervalField } from './action-bar/FixedIntervalField';
import { PriorityField } from './action-bar/PriorityField';
import type { SchedulingModalProps } from './types';

export function SchedulingModalContent({
  plugin,
  type,
  schedule,
  onClose,
}: SchedulingModalProps) {
  // if no data, assume we're going to import later
  const [strategy, setStrategy] = useState<SchedulingStrategy>(
    schedule.intervalDays === null ? 'priority' : 'fixed-interval'
  );

  const [scheduleValues, setScheduleValues] = useState({
    priority: schedule.priority ?? plugin.settings.defaultPriority,
    fixedIntervalDays: schedule.intervalDays ?? MINIMUM_FIXED_REVIEW_INTERVAL,
  });

  const updateValues = (updates: Partial<typeof scheduleValues>) => {
    setScheduleValues((prev) => ({ ...prev, ...updates }));
  };

  const handleToggle = (value: boolean) => {
    if (value === true) {
      setStrategy('priority');
    } else {
      setStrategy('fixed-interval');
    }
  };

  const handleEnter = () => {
    const value =
      strategy === 'priority'
        ? scheduleValues.priority
        : scheduleValues.fixedIntervalDays;

    onClose({ strategy, value });
  };

  const intervalTooltip =
    `Number of days between reviews, from` +
    `from ${MINIMUM_FIXED_REVIEW_INTERVAL} to ${MAXIMUM_FIXED_REVIEW_INTERVAL}.`;

  const prioTooltip =
    `Priority is used to grow the time to the next review, from ` +
    `${IRScheduler.toDisplayPriority(MINIMUM_PRIORITY)} (slow growth, more frequent review) to ` +
    `${IRScheduler.toDisplayPriority(MAXIMUM_PRIORITY)} (fast growth, less frequent review).`;

  return (
    <div
      className="ir-scheduling-modal"
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleEnter();
        }
      }}
    >
      {type === 'article' && (
        <div className="ir-toggle">
          <label className="ir-toggle-label">
            Fixed intervals
            <div
              className={
                'checkbox-container' +
                (strategy === 'priority' ? ' is-enabled' : '')
              }
            >
              <input
                type="checkbox"
                checked={strategy === 'priority'}
                onChange={(e) => handleToggle(e.currentTarget.checked)}
              />
            </div>
            Priority scheduling
          </label>
        </div>
      )}
      {strategy === 'priority' ? (
        <>
          <div>{prioTooltip}</div>
          <PriorityField
            initialPriority={scheduleValues.priority}
            onBlur={(priority: number) => updateValues({ priority })}
            showMultiplier
          />
        </>
      ) : (
        <>
          <div>{intervalTooltip}</div>
          <FixedIntervalField
            initialInterval={schedule.intervalDays}
            onBlur={(intervalDays: number) =>
              updateValues({ fixedIntervalDays: intervalDays })
            }
          />
        </>
      )}
      <div className="modal-button-container">
        <button
          onClick={() => {
            onClose('cancel');
          }}
        >
          Cancel
        </button>
        <button onClick={handleEnter} className="mod-cta">
          Confirm
        </button>
      </div>
    </div>
  );
}
