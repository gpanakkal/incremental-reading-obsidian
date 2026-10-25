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

  /**
   * The values as last committed, ahead of the re-render. A field's Enter
   * commits by blurring the field, then bubbles here to confirm within the
   * same keydown, before state from the blur reaches this closure.
   */
  const committedRef = useRef(scheduleValues);

  const updateValues = (updates: Partial<typeof scheduleValues>) => {
    committedRef.current = { ...committedRef.current, ...updates };
    setScheduleValues(committedRef.current);
  };

  const handleToggle = (value: boolean) => {
    if (value === true) {
      setStrategy('priority');
    } else {
      setStrategy('fixed-interval');
    }
  };

  /**
   * Saving is async and the modal stays open until it finishes, so a second
   * Enter (key repeat) or click in the meantime must not confirm again.
   */
  const closedRef = useRef(false);

  const close: typeof onClose = (result) => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose(result);
  };

  const handleEnter = () => {
    const committed = committedRef.current;
    const value =
      strategy === 'priority'
        ? committed.priority
        : committed.fixedIntervalDays;

    close({ strategy, value });
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
        // A focused button's own Enter activation clicks it, so Enter on
        // Cancel cancels. Tag check, not instanceof: a popout window has its
        // own HTMLButtonElement.
        const onButton = (e.target as HTMLElement).tagName === 'BUTTON';
        if (e.key === 'Enter' && !onButton) {
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
            initialInterval={scheduleValues.fixedIntervalDays}
            onBlur={(intervalDays: number) =>
              updateValues({ fixedIntervalDays: intervalDays })
            }
          />
          <div className="ir-scheduling-tooltip">{intervalTooltip}</div>
        </>
      )}
      <div className="modal-button-container">
        <button
          onClick={() => {
            close('cancel');
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
