import type { ReviewArticle, ReviewSnippet } from '#/lib/types';
import { transformPriority } from '#/lib/utils';
import { useState, useEffect } from 'preact/hooks';
import { useReviewContext } from './ReviewContext';

export function PriorityField({
  item,
}: {
  item: ReviewArticle | ReviewSnippet;
}) {
  const { actions } = useReviewContext();
  const [display, setDisplay] = useState({
    priority: item.data.priority / 10,
  });

  const updateDisplay = (updates: Partial<typeof display>) => {
    setDisplay((prev) => ({ ...prev, ...updates }));
  };

  useEffect(() => {
    setDisplay({ priority: item.data.priority / 10 });
  }, [item]);

  return (
    <div className="ir-priority-container">
      <label className={'ir-priority-label'}>
        Priority
        <input
          id={'ir-priority-input'}
          value={display.priority}
          className={'ir-priority-input'}
          type="text"
          inputMode="decimal"
          onChange={(e) => {
            const transformed = transformPriority(e.currentTarget.value);
            updateDisplay({ priority: transformed / 10 });
          }}
          onBlur={() => {
            void actions.reprioritize(item, display.priority);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              updateDisplay({ priority: item.data.priority });
              e.currentTarget.select();
            }
          }}
          onFocus={(e) => e.currentTarget.select()}
        />
      </label>
    </div>
  );
}
