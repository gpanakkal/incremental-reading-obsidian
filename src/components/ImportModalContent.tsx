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
import type { ImportModalProps } from './types';

export function ImportModalContent({
  plugin,
  schedule,
  defaultCopyOnImport,
  onClose,
}: ImportModalProps) {
  const [strategy, setStrategy] = useState<SchedulingStrategy>('priority');
  const [makeCopy, setMakeCopy] = useState(defaultCopyOnImport);
  const [scheduleValues, setScheduleValues] = useState({
    priority: schedule.priority ?? plugin.settings.defaultPriority,
    fixedIntervalDays: schedule.intervalDays ?? MINIMUM_FIXED_REVIEW_INTERVAL,
  });

  const updateValues = (updates: Partial<typeof scheduleValues>) => {
    setScheduleValues((prev) => ({ ...prev, ...updates }));
  };

  const handleEnter = () => {
    const value =
      strategy === 'priority'
        ? scheduleValues.priority
        : scheduleValues.fixedIntervalDays;
    onClose({ strategy, value, makeCopy });
  };

  const intervalTooltip =
    `Number of days between reviews, from ` +
    `${MINIMUM_FIXED_REVIEW_INTERVAL} to ${MAXIMUM_FIXED_REVIEW_INTERVAL}.`;

  const prioTooltip =
    `Priority is used to grow the time to the next review. Ranges from ` +
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
              onChange={(e) =>
                setStrategy(
                  e.currentTarget.checked ? 'priority' : 'fixed-interval'
                )
              }
            />
          </div>
          Priority scheduling
        </label>
      </div>
      {strategy === 'priority' ? (
        <>
          <PriorityField
            initialPriority={scheduleValues.priority}
            onBlur={(priority: number) => updateValues({ priority })}
            showMultiplier
          />
          <div className="ir-scheduling-tooltip">{prioTooltip}</div>
        </>
      ) : (
        <>
          <FixedIntervalField
            initialInterval={schedule.intervalDays}
            onBlur={(intervalDays: number) =>
              updateValues({ fixedIntervalDays: intervalDays })
            }
          />
          <div className="ir-scheduling-tooltip">{intervalTooltip}</div>
        </>
      )}
      <div className="ir-toggle">
        <label className="ir-toggle-label">
          Import in place
          <div
            className={'checkbox-container' + (makeCopy ? ' is-enabled' : '')}
          >
            <input
              type="checkbox"
              checked={makeCopy}
              onChange={(e) => setMakeCopy(e.currentTarget.checked)}
            />
          </div>
          Make a copy
        </label>
      </div>
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
