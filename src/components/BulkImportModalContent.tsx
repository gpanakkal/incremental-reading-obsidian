import type {
  BulkImportOptions,
  CandidateSource,
} from '#/lib/bulk-import/types';
import { isCopyImportable } from '#/lib/mime';
import type { TFile } from 'obsidian';
import { useEffect, useState } from 'react';
import { ImportOptionsFields, useImportOptions } from './ImportOptions';
import { LoadingSpinner } from './LoadingSpinner';

/** A file listed for import, and its path from where its source starts. */
interface Row {
  file: TFile;
  relativePath: string;
}

/**
 * The rows `source` finds, each appended as soon as the scan yields it, and
 * whether the scan is still running. Unmounting stops the scan.
 */
function useScan(source: CandidateSource) {
  const [rows, setRows] = useState<Row[]>([]);
  const [scanning, setScanning] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of source.scan(controller.signal)) {
          if (event.type !== 'file') continue;
          const { file, relativePath } = event;
          setRows((prev) => [...prev, { file, relativePath }]);
        }
      } catch (error) {
        // The rows found so far can still be imported
        console.error(error);
      } finally {
        if (!controller.signal.aborted) setScanning(false);
      }
    })();
    return () => controller.abort();
  }, [source]);
  return { rows, scanning };
}

export interface BulkImportModalContentProps {
  /** Where the files come from. */
  source: CandidateSource;
  /** What the options start at. */
  defaults: { priority: number; makeCopy: boolean };
  /** Import `files`, the ticked rows in the order listed, with `options`. */
  onConfirm: (files: TFile[], options: BulkImportOptions) => void;
  onCancel: () => void;
}

/**
 * The import options, then a checklist of the files `source` finds, each
 * ticked to start with, the count of those ticked, and the buttons.
 */
export function BulkImportModalContent({
  source,
  defaults,
  onConfirm,
  onCancel,
}: BulkImportModalContentProps) {
  const { rows, scanning } = useScan(source);
  const [unticked, setUnticked] = useState<ReadonlySet<TFile>>(() => new Set());
  const { values, update, current } = useImportOptions({
    priority: defaults.priority,
    intervalDays: null,
    makeCopy: defaults.makeCopy,
  });
  const canCopy = rows.every(({ file }) => isCopyImportable(file));
  const ticked = rows.filter(({ file }) => !unticked.has(file));

  const toggle = (file: TFile) => {
    setUnticked((prev) => {
      const next = new Set(prev);
      if (!next.delete(file)) next.add(file);
      return next;
    });
  };

  const confirm = () => {
    if (ticked.length === 0) return;
    const chosen = current();
    const fixed = chosen.strategy === 'fixed-interval';
    onConfirm(
      ticked.map(({ file }) => file),
      {
        // A fixed interval schedules without priority, so it keeps the default
        priority: fixed ? defaults.priority : chosen.priority,
        fixedIntervalDays: fixed ? chosen.fixedIntervalDays : null,
        makeCopy: canCopy && chosen.makeCopy,
      }
    );
  };

  return (
    <div className="ir-scheduling-modal ir-bulk-import">
      <div
        className="ir-bulk-import-options"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            confirm();
          }
        }}
      >
        <ImportOptionsFields
          values={values}
          update={update}
          canCopy={canCopy}
          initialInterval={null}
        />
      </div>
      <ul className="ir-bulk-import-list">
        {rows.map(({ file, relativePath }) => (
          <li key={file.path} className="ir-bulk-import-row">
            <label>
              <input
                type="checkbox"
                checked={!unticked.has(file)}
                onChange={() => toggle(file)}
              />
              <span className="ir-bulk-import-name">{file.name}</span>
              {relativePath !== file.name && (
                <span className="ir-bulk-import-path">{relativePath}</span>
              )}
            </label>
          </li>
        ))}
        {scanning && (
          <li>
            <LoadingSpinner label="Finding files to import" />
          </li>
        )}
      </ul>
      {!scanning && rows.length === 0 && (
        <div className="ir-bulk-import-empty">No files to import here</div>
      )}
      <div className="ir-bulk-import-count">{ticked.length} selected</div>
      <div className="modal-button-container">
        <button onClick={onCancel}>Cancel</button>
        <button
          className="mod-cta"
          disabled={ticked.length === 0}
          onClick={confirm}
        >
          Import {ticked.length}
        </button>
      </div>
    </div>
  );
}
