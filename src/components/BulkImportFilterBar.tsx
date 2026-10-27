import type {
  BulkImportOptions,
  CandidateSource,
} from '#/lib/bulk-import/types';
import type { App, TFile, TFolder } from 'obsidian';
import { Fragment, type ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'react';
import {
  BulkImportModalContent,
  type BulkImportModalContentProps,
} from './BulkImportModalContent';
import { FolderSuggest } from './FolderSuggest';

/** What a filter's input row is handed. */
export interface FilterRowProps {
  /**
   * Report the source the row's input now makes, or `null` when it makes
   * none (nothing listed). Called again only for a different choice; each
   * call scans afresh.
   */
  onSource: (source: CandidateSource | null) => void;
  /** The dialog's "Include subfolders" toggle, for a row to place beside its input. */
  subfoldersToggle: ComponentChildren;
}

/**
 * One filter of the bar: a segment of its segmented control, and the input
 * row shown while that segment is pressed.
 */
export interface FilterSegment {
  /**
   * Tells the filters apart, and which one is pressed: segments made afresh
   * on a re-render keep their row as long as their ids stay.
   */
  id: string;
  label: string;
  /** The segment's input row. */
  row: (props: FilterRowProps) => ComponentChildren;
}

/**
 * The filters `segments` as a segmented control, the first pressed to start
 * with, over the pressed one's input row. Pressing another segment drops
 * the source the last one made (`onSource(null)`) and shows a fresh row.
 *
 * Each segment is a `button` with `aria-pressed`, as `ReviewTypeFilter`'s
 * toggles are.
 */
export function BulkImportFilterBar({
  segments,
  onSource,
  subfoldersToggle,
}: {
  segments: readonly FilterSegment[];
  onSource: (source: CandidateSource | null) => void;
  subfoldersToggle: ComponentChildren;
}) {
  const [activeId, setActiveId] = useState(segments[0].id);
  // The first again should the pressed one drop out of the list
  const active =
    segments.find((segment) => segment.id === activeId) ?? segments[0];
  const press = (segment: FilterSegment) => {
    if (segment.id === active.id) return;
    setActiveId(segment.id);
    onSource(null);
  };

  return (
    <div className="ir-bulk-import-filter">
      <div className="ir-segments" role="group">
        {segments.map((segment) => (
          <button
            key={segment.id}
            className={
              'ir-segment' + (segment.id === active.id ? ' is-active' : '')
            }
            aria-pressed={segment.id === active.id}
            onClick={() => press(segment)}
          >
            {segment.label}
          </button>
        ))}
      </div>
      {/* Keyed, so another segment's row starts afresh */}
      <Fragment key={active.id}>
        {active.row({ onSource, subfoldersToggle })}
      </Fragment>
    </div>
  );
}

/**
 * The folder filter: a text input suggesting the vault's folders (`/` is the
 * vault root), with "Include subfolders" beside it. Picking a folder lists
 * what `makeSource` makes of it; picking the same one again changes nothing.
 */
export function folderFilter(
  app: App,
  makeSource: (folder: TFolder) => CandidateSource
): FilterSegment {
  return {
    id: 'folder',
    label: 'Folder',
    row: (props) => <FolderRow app={app} makeSource={makeSource} {...props} />,
  };
}

function FolderRow({
  app,
  makeSource,
  onSource,
  subfoldersToggle,
}: FilterRowProps & {
  app: App;
  makeSource: (folder: TFolder) => CandidateSource;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<TFolder | null>(null);

  // Once per row: Obsidian's suggest listens on the input for good, with no
  // way to stop it
  useLayoutEffect(() => {
    const suggest = new FolderSuggest(app, inputRef.current!);
    suggest.onSelect((folder) => {
      suggest.setValue(folder.path);
      suggest.close();
      setChosen(folder);
    });
    return () => suggest.close();
  }, [app]);

  useLayoutEffect(() => {
    if (chosen) onSource(makeSource(chosen));
  }, [chosen, onSource, makeSource]);

  return (
    <div className="ir-bulk-import-filter-row">
      <input
        ref={inputRef}
        type="text"
        className="ir-bulk-import-folder-input"
        placeholder="Choose a folder"
        // Typing without picking changes nothing listed, so leaving the field
        // puts back the folder that is; Confirm would import that one. A pick
        // never blurs first: Obsidian's popup cancels the item's mousedown.
        onBlur={(e) => {
          if (chosen) e.currentTarget.value = chosen.path;
        }}
      />
      {subfoldersToggle}
    </div>
  );
}

export interface FilteredBulkImportProps
  extends Omit<
    BulkImportModalContentProps,
    'source' | 'renderFilterBar' | 'onConfirm'
  > {
  /** The filters, in the order their segments show. */
  segments: readonly FilterSegment[];
  /** Import `files` from `source`, the source the filters made. */
  onConfirm: (
    files: TFile[],
    options: BulkImportOptions,
    source: CandidateSource
  ) => void;
}

/**
 * The bulk import dialog's content with the filter bar on top: nothing is
 * listed until a filter makes a source, and each source it makes after
 * that scans afresh, every row ticked again.
 */
export function FilteredBulkImport({
  segments,
  onConfirm,
  ...props
}: FilteredBulkImportProps) {
  const [source, setSource] = useState<CandidateSource | null>(null);
  return (
    <BulkImportModalContent
      {...props}
      source={source}
      renderFilterBar={(subfoldersToggle) => (
        <BulkImportFilterBar
          segments={segments}
          onSource={setSource}
          subfoldersToggle={subfoldersToggle}
        />
      )}
      // Confirming takes a ticked row, which only a source lists
      onConfirm={(files, options) => onConfirm(files, options, source!)}
    />
  );
}
