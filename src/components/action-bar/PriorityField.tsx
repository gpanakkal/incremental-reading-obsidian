import IRScheduler from '#/lib/IRScheduler';
import { useState } from 'react';

export function PriorityField({
  initialPriority,
  onBlur,
}: {
  initialPriority: number;
  onBlur: (priority: number) => Promise<void>;
}) {
  const [displayPrio, setDisplayPrio] = useState<number>(initialPriority / 10);

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
            void onBlur(transformed);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              setDisplayPrio(initialPriority);
              e.currentTarget.select();
            }
          }}
          onFocus={(e) => e.currentTarget.select()}
        />
      </label>
    </div>
  );
}
