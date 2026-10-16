import { ImportOptionsFields, useImportOptions } from './ImportOptions';
import type { ImportModalProps } from './types';

export function ImportModalContent({
  plugin,
  schedule,
  defaultCopyOnImport,
  canCopy,
  onClose,
}: ImportModalProps) {
  const { values, update, current } = useImportOptions({
    priority: schedule.priority ?? plugin.settings.defaultPriority,
    intervalDays: schedule.intervalDays,
    makeCopy: canCopy && defaultCopyOnImport,
  });

  const handleEnter = () => {
    const chosen = current();
    const { strategy, makeCopy } = chosen;
    const value =
      strategy === 'priority' ? chosen.priority : chosen.fixedIntervalDays;
    onClose({ strategy, value, makeCopy });
  };

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
      <ImportOptionsFields
        values={values}
        update={update}
        canCopy={canCopy}
        initialInterval={schedule.intervalDays}
      />
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
