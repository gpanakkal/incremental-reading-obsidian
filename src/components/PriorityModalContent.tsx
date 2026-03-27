import { useState } from 'react';
import { MAXIMUM_PRIORITY, MINIMUM_PRIORITY } from '#/lib/constants';
import { toDisplayPriority, transformPriority } from '#/lib/utils';
import type { TFile } from 'obsidian';
import type IncrementalReadingPlugin from '#/main';

interface PriorityModalProps {
  plugin: IncrementalReadingPlugin;
  file: TFile;
  onClose: () => void;
}

export function PriorityModalContent({
  plugin,
  file,
  onClose,
}: PriorityModalProps) {
  const [display, setDisplay] = useState({
    priority: plugin.settings.defaultPriority / 10,
  });

  const updateDisplay = (updates: Partial<typeof display>) => {
    setDisplay((prev) => ({ ...prev, ...updates }));
  };

  const handleSubmit = async () => {
    const priority = transformPriority(display.priority);
    const article = await plugin.reviewManager.importArticle(file, priority);
    if (article && plugin.getOpenReviewLeaf()) {
      await plugin.learn(article);
    }
    onClose();
  };

  const tooltip =
    `Set the priority for this article. Priority ranges from ` +
    `${toDisplayPriority(MINIMUM_PRIORITY)} (highest) to ` +
    `${toDisplayPriority(MAXIMUM_PRIORITY)} (lowest).`;

  return (
    <div className="ir-priority-modal">
      <h2>Import article</h2>
      <p>{tooltip}</p>
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
                void handleSubmit();
              } else if (e.key === 'Escape') {
                onClose();
              }
            }}
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
      </div>
      <div className="modal-button-container">
        <button onClick={onClose}>Cancel</button>
        <button onClick={() => void handleSubmit()} className="mod-cta">
          Import
        </button>
      </div>
    </div>
  );
}
