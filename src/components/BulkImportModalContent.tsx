import {
  folderStates,
  NO_TICKS,
  ticksReducer,
  untickedFiles,
  type CheckState,
  type Ticks,
  type TicksAction,
} from '#/lib/bulk-import/ticks';
import {
  buildTree,
  subtreeScanning,
  topLevelScanning,
  treeFiles,
  type TreeEntry,
  type TreeFolder,
} from '#/lib/bulk-import/tree';
import type {
  BulkImportOptions,
  CandidateSource,
  ScanEvent,
} from '#/lib/bulk-import/types';
import { isCopyImportable } from '#/lib/mime';
import { setIcon, type TFile } from 'obsidian';
import type { ComponentChildren } from 'preact';
import {
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { ImportOptionsFields, useImportOptions } from './ImportOptions';
import { LoadingSpinner } from './LoadingSpinner';

/** What a scan has reported so far, and whether it has finished. */
interface ScanState {
  events: readonly ScanEvent[];
  done: boolean;
}

const NOT_STARTED: ScanState = { events: [], done: false };

/** The rows unticked on a source no row was unticked on yet. */
/** The ticks, for the source they were set on. */
interface TicksOn {
  source: CandidateSource | null;
  ticks: Ticks;
}

/** No folder collapsed. */
const NO_PATHS: ReadonlySet<string> = new Set();

/**
 * `ticksReducer` on the ticks set on `source`: a new source starts from
 * `NO_TICKS`, every row ticked, and the same one again keeps its ticks.
 */
function ticksOnReducer(
  state: TicksOn,
  { source, action }: { source: CandidateSource | null; action: TicksAction }
): TicksOn {
  const same = state.source === source;
  const ticks = ticksReducer(same ? state.ticks : NO_TICKS, action);
  return same && ticks === state.ticks ? state : { source, ticks };
}

/**
 * What `source`'s scan reports, each event kept as soon as the scan yields
 * it. A change of `source` or `subfolders` or unmounting stops the scan and
 * forgets what it found; a change starts it over. Without a source, nothing.
 */
function useScan(
  source: CandidateSource | null,
  subfolders: boolean
): ScanState {
  const [state, setState] = useState<ScanState>(NOT_STARTED);
  // Run before the screen paints: rows a toggle drops are gone in that frame,
  // and rows the source answers for at once are back before it shows
  useLayoutEffect(() => {
    if (!source) return;
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

/**
 * A folder's checkbox: ticked, unticked, or partly filled. `indeterminate`
 * gives the partial state its meaning, but Obsidian's checkboxes draw
 * nothing of the browser's; `ir-partial` fills the box's left half instead
 * (styles.css). Obsidian's own dash for `data-indeterminate="true"` reads as
 * a collapse arrow next to a folder name, so the box never carries it.
 */
function FolderBox({
  state,
  onChange,
}: {
  state: CheckState;
  onChange: () => void;
}) {
  const partial = state === 'partial';
  return (
    <input
      type="checkbox"
      checked={state === 'checked'}
      indeterminate={partial}
      className={partial ? 'ir-partial' : undefined}
      onChange={onChange}
    />
  );
}

interface TreeRowsProps {
  entries: readonly TreeEntry[];
  unticked: ReadonlySet<TFile>;
  toggle: (file: TFile) => void;
  /** What each folder's checkbox shows, by path. */
  folderStates: ReadonlyMap<string, CheckState>;
  toggleFolder: (folder: TreeFolder) => void;
  /** The paths of the folders collapsed. */
  collapsed: ReadonlySet<string>;
  toggleCollapsed: (folder: TreeFolder) => void;
}

/**
 * The arrow that collapses and expands a folder, as the Files view draws it:
 * Obsidian's own `right-triangle` icon in a `collapse-icon`, which its app.css
 * turns to point right once `is-collapsed` (both undocumented). It sits
 * outside the folder's label, so it never ticks the folder, and is named by
 * the folder's name: an `aria-label` would put a tooltip on it, which the
 * Files view's arrow has none of.
 */
function CollapseButton({
  expanded,
  nameId,
  onClick,
}: {
  expanded: boolean;
  nameId: string;
  onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    setIcon(ref.current!, 'right-triangle');
  }, []);
  return (
    <button
      ref={ref}
      type="button"
      className={
        'ir-bulk-import-collapse collapse-icon' +
        (expanded ? '' : ' is-collapsed')
      }
      aria-expanded={expanded}
      aria-labelledby={nameId}
      onClick={onClick}
    />
  );
}

/**
 * A folder's row: its arrow, its checkbox and name, and a spinner while it is
 * being scanned, then its rows below unless it is collapsed. Collapsed, the
 * spinner shows while anything under it is being scanned too, the spinners
 * under it being hidden.
 */
function FolderRow({
  folder,
  ...props
}: Omit<TreeRowsProps, 'entries'> & { folder: TreeFolder }) {
  const { folderStates, toggleFolder, collapsed, toggleCollapsed } = props;
  // Prefixed: Preact's ids restart at P0-0 in each root, so another root on
  // the page using useId (another plugin's, say) would hand out the same one
  const nameId = `ir-bulk-import-${useId()}`;
  const expanded = !collapsed.has(folder.path);
  const scanning = expanded ? folder.scanning : subtreeScanning(folder);
  return (
    <li className="ir-bulk-import-folder">
      <div className="ir-bulk-import-folder-title">
        <CollapseButton
          expanded={expanded}
          nameId={nameId}
          onClick={() => toggleCollapsed(folder)}
        />
        <label className="ir-bulk-import-folder-label">
          <FolderBox
            state={folderStates.get(folder.path)!}
            onChange={() => toggleFolder(folder)}
          />
          <span
            id={nameId}
            className="ir-bulk-import-name"
            aria-label={folder.name}
          >
            {folder.name}
          </span>
          {scanning && (
            <LoadingSpinner label={`Finding files in ${folder.name}`} />
          )}
        </label>
      </div>
      {expanded && (
        <ul className="ir-bulk-import-children">
          <TreeRows entries={folder.entries} {...props} />
        </ul>
      )}
    </li>
  );
}

/** The rows of `entries`, folders holding theirs below their names. */
function TreeRows({ entries, ...props }: TreeRowsProps) {
  const { unticked, toggle } = props;
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
          <FolderRow key={entry.path} folder={entry} {...props} />
        )
      )}
    </>
  );
}

export interface BulkImportModalContentProps {
  /**
   * Where the files come from; `null` lists nothing, until a filter above
   * makes a source. A new source scans afresh, every row ticked again.
   */
  source: CandidateSource | null;
  /**
   * The filter bar, above the options, for a dialog whose source the user
   * picks there. It is handed the "Include subfolders" toggle to place where
   * a filter that can go deeper wants it, and the toggle shows nowhere else.
   */
  renderFilterBar?: (subfoldersToggle: ComponentChildren) => ComponentChildren;
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
 *
 * Each folder has a checkbox too: ticked while all the files under it are,
 * unticked while none are, partly filled otherwise. Clicking it ticks all of
 * them, or unticks them all once all are ticked, and a file found later is
 * ticked as its folder is (see `ticksReducer`). Each folder starts expanded,
 * and its arrow collapses it: that hides its rows and nothing more, so the
 * ticks, the count and the import still cover them, rows found under it
 * included.
 */
export function BulkImportModalContent({
  source,
  defaults,
  onConfirm,
  onCancel,
  onIncludeSubfoldersChange,
  renderFilterBar,
}: BulkImportModalContentProps) {
  const [includeSubfolders, setIncludeSubfolders] = useState(
    defaults.includeSubfolders
  );
  const canGoDeeper = source?.canIncludeSubfolders === true;
  // A source that cannot go deeper scans its top level whatever the toggle
  const scan = useScan(source, canGoDeeper && includeSubfolders);
  const tree = useMemo(
    () => buildTree(scan.events, scan.done),
    [scan.events, scan.done]
  );
  const topScanning = useMemo(
    () => topLevelScanning(scan.events, scan.done),
    [scan.events, scan.done]
  );
  const files = useMemo(() => treeFiles(tree), [tree]);
  // The ticks, for the source they were set on: a new source starts with
  // every row ticked
  const [ticksOn, dispatchOn] = useReducer(ticksOnReducer, {
    source,
    ticks: NO_TICKS,
  });
  const dispatch = (action: TicksAction) => dispatchOn({ source, action });
  const ticks = ticksOn.source === source ? ticksOn.ticks : NO_TICKS;
  // Before the screen paints, so a file found under an unticked folder never
  // shows ticked
  useLayoutEffect(() => {
    dispatchOn({ source, action: { type: 'found', tree } });
  }, [source, tree]);
  const unticked = useMemo(() => untickedFiles(ticks), [ticks]);
  const states = useMemo(() => folderStates(ticks, tree), [ticks, tree]);
  // The folders collapsed, for the source they were collapsed on, like the
  // ticks: a new source starts with every folder expanded
  const [collapsedOn, setCollapsedOn] = useState<{
    source: CandidateSource | null;
    paths: ReadonlySet<string>;
  }>(() => ({ source, paths: NO_PATHS }));
  const collapsed =
    collapsedOn.source === source ? collapsedOn.paths : NO_PATHS;
  const toggleCollapsed = (folder: TreeFolder) =>
    setCollapsedOn((prev) => {
      const next = new Set(prev.source === source ? prev.paths : NO_PATHS);
      if (!next.delete(folder.path)) next.add(folder.path);
      return { source, paths: next };
    });
  const { values, update, current } = useImportOptions({
    priority: defaults.priority,
    intervalDays: null,
    makeCopy: defaults.makeCopy,
  });
  const canCopy = files.every((file) => isCopyImportable(file));
  const ticked = files.filter((file) => !unticked.has(file));

  const toggle = (file: TFile) => dispatch({ type: 'toggle-file', tree, file });
  const toggleFolder = (folder: TreeFolder) =>
    dispatch({ type: 'toggle-folder', tree, folder });

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

  const subfoldersToggle = (
    <div className="ir-toggle ir-bulk-import-subfolders">
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
  );

  return (
    <div className="ir-scheduling-modal ir-bulk-import">
      {renderFilterBar?.(subfoldersToggle)}
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
      {!renderFilterBar && canGoDeeper && subfoldersToggle}
      <ul className="ir-bulk-import-list">
        <TreeRows
          entries={tree}
          unticked={unticked}
          toggle={toggle}
          folderStates={states}
          toggleFolder={toggleFolder}
          collapsed={collapsed}
          toggleCollapsed={toggleCollapsed}
        />
        {source && topScanning && (
          <li>
            <LoadingSpinner label="Finding files to import" />
          </li>
        )}
      </ul>
      {!source && (
        <div className="ir-bulk-import-prompt">
          Choose what to import above to list its files
        </div>
      )}
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
