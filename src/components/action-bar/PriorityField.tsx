import IRScheduler from '#/lib/IRScheduler';
import { useEffect, useRef, useState } from 'react';

/**
 * Note: pass a `key` prop with the item's ID to ensure priority is updated
 * correctly when navigating to other items
 */
export function PriorityField({
  initialPriority,
  onBlur,
  showMultiplier = false,
}: {
  initialPriority: number;
  onBlur: (priority: number) => void | Promise<void>;
  showMultiplier?: boolean;
}) {
  const [displayPrio, setDisplayPrio] = useState<number>(initialPriority / 10);
  const prevPriorityRef = useRef(initialPriority);

  useEffect(
    function updatePrioOnRerender() {
      if (prevPriorityRef.current !== initialPriority) {
        prevPriorityRef.current = initialPriority;
        setDisplayPrio(initialPriority / 10);
      }
    },
    [initialPriority]
  );

  return (
    <div className="ir-priority-container">
      <label className={'ir-priority-label'}>
        Priority
        <input
          id={'ir-priority-input'}
          value={displayPrio}
          className={'ir-priority-input'}
          type="text"
          inputMode="numeric"
          onChange={(e) => {
            try {
              const adjusted = IRScheduler.adjustDisplayPriorityOnChange(
                e.currentTarget.value
              );
              setDisplayPrio(adjusted);
            } catch (_error) {
              /* fall back to prior value */
            }
          }}
          onBlur={() => {
            const transformed = IRScheduler.transformPriority(displayPrio);
            prevPriorityRef.current = transformed;
            void onBlur(transformed);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              setDisplayPrio(initialPriority / 10);
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
                IRScheduler.transformPriority(displayPrio)
              ) * 100
            ) / 100}
            x interval multiplier)
          </div>
        )}
      </label>
    </div>
  );
}
