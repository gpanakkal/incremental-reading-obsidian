import {
  buildTree,
  topLevelScanning,
  treeFiles,
  type TreeEntry,
} from '#/lib/bulk-import/tree';
import type {
  BulkImportOptions,
  CandidateSource,
  ScanEvent,
} from '#/lib/bulk-import/types';
import { isCopyImportable } from '#/lib/mime';
import type { TFile } from 'obsidian';
import { useLayoutEffect, useMemo, useState } from 'react';
import { ImportOptionsFields, useImportOptions } from './ImportOptions';
import { LoadingSpinner } from './LoadingSpinner';

/** What a scan has reported so far, and whether it has finished. */
interface ScanState {
  events: readonly ScanEvent[];
  done: boolean;
}

const NOT_STARTED: ScanState = { events: [], done: false };

/**
 * What `source`'s scan reports, each event kept as soon as the scan yields
 * it. A change of `subfolders` or unmounting stops the scan and forgets what
 * it found; a change starts it over.
 */
function useScan(source: CandidateSource, subfolders: boolean): ScanState {
  const [state, setState] = useState<ScanState>(NOT_STARTED);
  // Run before the screen paints: rows a toggle drops are gone in that frame,
  // and rows the source answers for at once are back before it shows
  useLayoutEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      try {
        for await (const event of source.scan(signal, { subfolders })) {
          // Not a row more once stopped
          if (signal.aborted) return;
          setState((prev) => ({ ...prev, events: [...prev.events, event] }));
        }
      } catch (error) {
        // The rows found so far can still be imported
        console.error(error);
      } finally {
        if (!signal.aborted) setState((prev) => ({ ...prev, done: true }));
      }
    })();
    return () => {
      controller.abort();
      setState(NOT_STARTED);
    };
  }, [source, subfolders]);
  return state;
}

/** The rows of `entries`, folders holding theirs below their names. */
function TreeRows({
  entries,
  unticked,
  toggle,
}: {
  entries: readonly TreeEntry[];
  unticked: ReadonlySet<TFile>;
  toggle: (file: TFile) => void;
}) {
  return (
    <>
      {entries.map((entry) =>
        entry.kind === 'file' ? (
          <li key={entry.file.path} className="ir-bulk-import-row">
            <label>
              <input
                type="checkbox"
                checked={!unticked.has(entry.file)}
                onChange={() => toggle(entry.file)}
              />
              {/* Cut off with an ellipsis (styles.css); the full name is the
                  tooltip. Obsidian draws its tooltip from `aria-label` on
                  hover, and on a long press on mobile. */}
              <span
                className="ir-bulk-import-name"
                aria-label={entry.file.basename}
              >
                {entry.file.basename}
              </span>
              {/* Every type but Markdown is tagged, as in the Files view.
                  `nav-file-tag` is Obsidian's own (undocumented) class, and
                  its app.css rule is not scoped to the Files view. */}
              {entry.file.extension !== 'md' && (
                <span className="ir-bulk-import-tag nav-file-tag">
                  {entry.file.extension}
                </span>
              )}
            </label>
          </li>
        ) : (
          <li key={entry.path} className="ir-bulk-import-folder">
            <div className="ir-bulk-import-folder-title">
              <span className="ir-bulk-import-name" aria-label={entry.name}>
                {entry.name}
              </span>
              {entry.scanning && (
                <LoadingSpinner label={`Finding files in ${entry.name}`} />
              )}
            </div>
            <ul className="ir-bulk-import-children">
              <TreeRows
                entries={entry.entries}
                unticked={unticked}
                toggle={toggle}
              />
            </ul>
          </li>
        )
      )}
    </>
  );
}

export interface BulkImportModalContentProps {
  /** Where the files come from. */
  source: CandidateSource;
  /**
   * What the options start at. `includeSubfolders` counts only for a source
   * that `canIncludeSubfolders`.
   */
  defaults: { priority: number; makeCopy: boolean; includeSubfolders: boolean };
  /** "Include subfolders" was switched to `on`. */
  onIncludeSubfoldersChange: (on: boolean) => void;
  /** Import `files`, the ticked rows in the order listed, with `options`. */
  onConfirm: (files: TFile[], options: BulkImportOptions) => void;
  onCancel: () => void;
}

/**
 * The import options, then a checklist of the files `source` finds, each
 * ticked to start with, the count of those ticked, and the buttons.
 *
 * A source that can go deeper also gets an "Include subfolders" toggle,
 * starting as `defaults` has it: on, the first scan already goes deeper.
 * Switching it either way scans afresh: on, the list becomes a tree of the
 * folders below, each folder's subfolders above its files as in
 * the file explorer, the subfolders' files checked once the top level's are;
 * off, the subfolders go, their files with them. The count and the import
 * cover the ticked files the tree shows, top to bottom.
 */
export function BulkImportModalContent({
  source,
  defaults,
  onConfirm,
  onCancel,
  onIncludeSubfoldersChange,
}: BulkImportModalContentProps) {
  const [includeSubfolders, setIncludeSubfolders] = useState(
    () => source.canIncludeSubfolders === true && defaults.includeSubfolders
  );
  const scan = useScan(source, includeSubfolders);
  const tree = useMemo(
    () => buildTree(scan.events, scan.done),
    [scan.events, scan.done]
  );
  const topScanning = useMemo(
    () => topLevelScanning(scan.events, scan.done),
    [scan.events, scan.done]
  );
  const files = useMemo(() => treeFiles(tree), [tree]);
  const [unticked, setUnticked] = useState<ReadonlySet<TFile>>(() => new Set());
  const { values, update, current } = useImportOptions({
    priority: defaults.priority,
    intervalDays: null,
    makeCopy: defaults.makeCopy,
  });
  const canCopy = files.every((file) => isCopyImportable(file));
  const ticked = files.filter((file) => !unticked.has(file));

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
    onConfirm(ticked, {
      // A fixed interval schedules without priority, so it keeps the default
      priority: fixed ? defaults.priority : chosen.priority,
      fixedIntervalDays: fixed ? chosen.fixedIntervalDays : null,
      makeCopy: canCopy && chosen.makeCopy,
    });
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
      {source.canIncludeSubfolders && (
        <div className="ir-toggle">
          <label className="ir-toggle-label">
            <div
              className={
                'checkbox-container' + (includeSubfolders ? ' is-enabled' : '')
              }
            >
              <input
                type="checkbox"
                checked={includeSubfolders}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  setIncludeSubfolders(on);
                  onIncludeSubfoldersChange(on);
                }}
              />
            </div>
            Include subfolders
          </label>
        </div>
      )}
      <ul className="ir-bulk-import-list">
        <TreeRows entries={tree} unticked={unticked} toggle={toggle} />
        {topScanning && (
          <li>
            <LoadingSpinner label="Finding files to import" />
          </li>
        )}
      </ul>
      {scan.done && files.length === 0 && (
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
