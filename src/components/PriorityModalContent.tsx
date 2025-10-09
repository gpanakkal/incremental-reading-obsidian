import { useCallback, useState } from 'preact/hooks';
import type { FileView, MarkdownView } from 'obsidian';
import type ReviewManager from '#/lib/ReviewManager';
import {
  DEFAULT_PRIORITY,
  ERROR_NOTICE_DURATION_MS,
  SUCCESS_NOTICE_DURATION_MS,
} from '#/lib/constants';
import { transformPriority } from '#/lib/utils';

interface PriorityModalProps {
  reviewManager: ReviewManager;
  view: MarkdownView | FileView;
  onClose: () => void;
}

export function PriorityModalContent({
  reviewManager,
  view,
  onClose,
}: PriorityModalProps) {
  const [display, setDisplay] = useState({
    priority: DEFAULT_PRIORITY / 10,
  });

  const updateDisplay = (updates: Partial<typeof display>) => {
    setDisplay((prev) => ({ ...prev, ...updates }));
  };

  const handleSubmit = async () => {
    const priority = transformPriority(display.priority);
    await reviewManager.importArticle(view, priority);
    onClose();
  };

  return (
    <div className="ir-priority-modal">
      <h2>Import article</h2>
      <p>
        Set the priority for this article. Priority ranges from 1 (highest) to 5
        (lowest).
      </p>
      <div className="ir-priority-input-container">
        <label>
          Priority:{' '}
          <input
            type="text"
            value={display.priority}
            onChange={(e) => {
              const transformed = transformPriority(e.currentTarget.value);
              updateDisplay({ priority: transformed / 10 });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSubmit();
              } else if (e.key === 'Escape') {
                onClose();
              }
            }}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
      </div>
      <div className="modal-button-container">
        <button onClick={onClose}>Cancel</button>
        <button onClick={handleSubmit} className="mod-cta">
          Import
        </button>
      </div>
    </div>
  );
}
