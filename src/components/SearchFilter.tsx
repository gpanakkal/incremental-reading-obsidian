import type { CandidateSource } from '#/lib/bulk-import/types';
import type { VaultSearch } from '#/lib/vault-search';
import type { TFile } from 'obsidian';
import { useEffect, useRef, useState } from 'react';
import type { FilterRowProps, FilterSegment } from './BulkImportFilterBar';

/** How long typing must pause before the query is searched. */
export const SEARCH_DEBOUNCE_MS = 300;

/** What the search row shows under its field. */
type SearchStatus =
  | { kind: 'idle' }
  | { kind: 'searching'; matched: number }
  | { kind: 'failed'; message: string };

/**
 * The search filter: a field taking the queries "Search in all files" takes,
 * searched with Obsidian's own engine once typing pauses. What it matches is
 * listed as `makeSource` lays it out, as it stood when the search ran: a
 * file changed since is listed as it was found. A query the engine can't
 * parse lists nothing and says why under the field, in the engine's words.
 */
export function searchFilter(
  search: VaultSearch,
  makeSource: (files: readonly TFile[]) => CandidateSource
): FilterSegment {
  return {
    id: 'search',
    label: 'Search',
    row: (props) => (
      <SearchRow search={search} makeSource={makeSource} {...props} />
    ),
  };
}

function SearchRow({
  search,
  makeSource,
  onSource,
}: FilterRowProps & {
  search: VaultSearch;
  makeSource: (files: readonly TFile[]) => CandidateSource;
}) {
  const [status, setStatus] = useState<SearchStatus>({ kind: 'idle' });
  const pendingRef = useRef<{ timer?: number; controller?: AbortController }>(
    {}
  );
  // The query whose matches are listed, if any: typed again, it changes
  // nothing, so no tick is lost to a search that would list the same
  const listedRef = useRef<string | null>(null);

  /** Stops the search waiting to start or running, if any. */
  const stop = () => {
    window.clearTimeout(pendingRef.current.timer);
    pendingRef.current.controller?.abort();
  };
  useEffect(() => stop, []);

  const run = async (query: string) => {
    const controller = new AbortController();
    pendingRef.current.controller = controller;
    const { signal } = controller;
    setStatus({ kind: 'searching', matched: 0 });
    try {
      const files = await search.run(query, signal, (n) => {
        if (!signal.aborted) setStatus({ kind: 'searching', matched: n });
      });
      if (signal.aborted) return;
      setStatus({ kind: 'idle' });
      listedRef.current = query;
      // A new source each time, so its rows are all ticked again
      onSource(makeSource(files));
    } catch (error) {
      if (signal.aborted) return;
      setStatus({
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
      listedRef.current = null;
      onSource(null);
    }
  };

  const onInput = (query: string) => {
    stop();
    // What was said is of the query as it was
    setStatus({ kind: 'idle' });
    if (query === listedRef.current) return;
    if (query.trim() === '') {
      listedRef.current = null;
      onSource(null);
      return;
    }
    // The list stays as it is until the new query's matches replace it
    pendingRef.current.timer = window.setTimeout(
      () => void run(query),
      SEARCH_DEBOUNCE_MS
    );
  };

  return (
    <>
      <div className="ir-bulk-import-filter-row">
        <input
          type="text"
          className="ir-bulk-import-search-input"
          placeholder="Search, as in Search in all files"
          spellcheck={false}
          autocomplete="off"
          onInput={(e) => onInput(e.currentTarget.value)}
        />
      </div>
      {status.kind === 'searching' && (
        <div className="ir-bulk-import-search-progress" aria-live="polite">
          Searching… {status.matched} matched
        </div>
      )}
      {status.kind === 'failed' && (
        <div className="ir-bulk-import-search-error" role="alert">
          {status.message}
        </div>
      )}
    </>
  );
}
