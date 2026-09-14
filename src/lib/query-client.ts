import type { QueuePage, QueueRow } from '#/components/types';
import { type Query, QueryClient } from '@tanstack/react-query';
import type { TAbstractFile, TFile } from 'obsidian';
import { CLOZE_DELIMITERS, QUERY_STALE_TIME } from './constants';
import type ReviewManager from './items/ReviewManager';
import { getSeenIds, resetCurrentItem, setCurrentItemId, store } from './store';
import { type DataChangeEvent, isReviewCard, type ReviewItem } from './types';
import type { DeepPartial } from './utility-types';
import { deepMerge } from './utils';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: QUERY_STALE_TIME,
    },
  },
});

/**
 * The cache key for the item review is showing.
 *
 * Keyed by the id rather than shared by every item, because react-query hands
 * back a key's cached value the instant a component asks for it: under one
 * constant key, moving between items serves the *previous* item as settled data
 * until a refetch lands, and the review pane paints it. The id in the key makes
 * that a cache miss instead, so a new item can only ever arrive as loading —
 * including one review has shown before, whose entry
 * {@link startItemCacheEviction} dropped when review left it.
 *
 * `null` is not an identity — it means "whatever comes next", and its entry ends
 * up holding whatever the last advance resolved to. Only `useCurrentItem` may
 * read it, and only under the rule documented there.
 */
export const currentItemQueryKey = (id: string | null) =>
  ['current-review-item', id] as const;

// #region Cache lifetime

/**
 * Drop everything cached for an item once review moves off it, until the
 * returned cleanup is called. Hand that to `Plugin.register`.
 *
 * Left alone, an item's entries outlive it by react-query's whole `gcTime`, and
 * nothing keeps them current meanwhile: the invalidations that follow a write
 * only reach the item review is on. Coming back inside that window — from the
 * queue table, `learn`, a resumed session — serves the item as it was when
 * review left it, as settled data rather than loading, and whatever acts on it
 * acts on that: an article reviewed and reopened a moment later would be
 * reviewed again from its pre-review state. Evicted, the way back is a miss.
 *
 * Watches the store rather than wrapping any one of those paths, since each of
 * them ends in `currentItemId`; and evicts in the cache rather than guarding
 * each reader, so the hooks, `getCurrentItemSync` and `fetchCurrentItem` all
 * find the same nothing.
 *
 * The `null` entry belongs to no item and is left to `useCurrentItem`.
 */
export function startItemCacheEviction(): () => void {
  const cache = queryClient.getQueryCache();
  /** Cancels each wait on an entry that was still held when its item was left. */
  const waits = new Set<() => void>();
  let shownId = store.getState().currentItemId;

  /**
   * Remove `query` unless something still holds it, and say whether it is done
   * with: removed, or kept because review is back on `id`.
   *
   * Held is watched or fetching. Review's hooks go on watching the item they
   * left until they re-render onto the next one, and a query removed under a
   * watcher strands it on an entry the cache no longer has. Removing one
   * mid-fetch cancels the fetch, rejecting whoever awaits it through
   * `fetchQuery` — `setCardsOnly` would never get as far as its toggle.
   */
  const tryRemove = (query: Query, id: string): boolean => {
    if (store.getState().currentItemId === id) return true;
    if (query.getObserversCount() > 0 || query.state.fetchStatus !== 'idle') {
      return false;
    }
    cache.remove(query);
    return true;
  };

  /** Remove `query` now, or once nothing holds it any more. */
  const release = (query: Query, id: string) => {
    if (tryRemove(query, id)) return;
    function stopWaiting() {
      unsubscribe();
      waits.delete(stopWaiting);
    }
    const unsubscribe = cache.subscribe((event) => {
      if (event.query !== query) return;
      if (event.type === 'removed' || tryRemove(query, id)) stopWaiting();
    });
    waits.add(stopWaiting);
  };

  const unsubscribeStore = store.subscribe(() => {
    const { currentItemId } = store.getState();
    if (currentItemId === shownId) return;
    const leftId = shownId;
    shownId = currentItemId;
    if (leftId === null) return;
    const entries = [
      ...cache.findAll({ queryKey: currentItemQueryKey(leftId) }),
      ...cache.findAll({ queryKey: ['item', leftId] }),
    ];
    for (const query of entries) release(query, leftId);
  });

  return () => {
    unsubscribeStore();
    for (const stopWaiting of waits) stopWaiting();
  };
}
// #endregion

// #region Queries for use outside React only
// see useReactQuery.tsx for React queries

/** Does not auto-refetch */
export async function fetchCurrentItem(
  reviewManager: ReviewManager
): Promise<ReviewItem | null> {
  const { currentItemId } = store.getState();
  // Hoisted out of the query function so this never reads or creates the `null`
  // entry, which belongs to the review hook's advance and holds the next item
  // rather than the nothing this branch means.
  if (currentItemId === null) return null;
  return queryClient.fetchQuery({
    queryKey: currentItemQueryKey(currentItemId),
    queryFn: async () => reviewManager.getReviewItemFromId(currentItemId),
  });
}

/**
 * The item on screen, or nothing while review is between items — which the
 * commands that call this already treat as "not applicable right now", and is
 * the honest answer: acting on the item an advance just finished with is the
 * same mistake as rendering it.
 */
export const getCurrentItemSync = (): ReviewItem | undefined => {
  const { currentItemId } = store.getState();
  if (currentItemId === null) return undefined;
  return queryClient.getQueryData(currentItemQueryKey(currentItemId));
};

export async function fetchById(
  itemId: string,
  reviewManager: ReviewManager
): Promise<ReviewItem | null> {
  const result = await queryClient.fetchQuery({
    queryKey: ['item', itemId],
    queryFn: async () => reviewManager.getReviewItemFromId(itemId),
  });
  return result;
}

/** Doesn't check the cache, so prefer fetching by ID */
export async function fetchByFile(
  file: TFile,
  reviewManager: ReviewManager
): Promise<ReviewItem | null> {
  const result = await reviewManager.getReviewItemFromFile(file);
  if (!result) return null;
  queryClient.setQueryData(['item', result.data.id], () => result);
  return result;
}
// #endregion

// #region Functions used inside and outside React

/**
 * Resolve the item a {@link currentItemQueryKey} names, picking the next one in
 * the queue when the key names none.
 *
 * Takes the id rather than reading it back off the store, so it stays a
 * function of the key it is fetching for. Read here, a fetch started for one
 * item could finish after the user has picked another and write that other
 * item's data into this item's cache entry.
 */
export const currentItemQueryFn = async (
  reviewManager: ReviewManager,
  currentItemId: string | null
): Promise<ReviewItem | null> => {
  // `null`, not falsiness: the key's absent id is null and nothing else, and
  // every other reader of it says so too. Under a truthiness check an id that
  // is merely falsy would quietly advance past the item it names instead of
  // looking it up and coming back empty.
  if (currentItemId !== null) {
    return reviewManager.getReviewItemFromId(currentItemId);
  }
  return fetchNextItem(reviewManager);
};

/**
 * Invalidate item data and file text queries
 * Will invalidate current-review-item if ID matches
 */
export const invalidateItemQuery = async (itemId: string) => {
  const { currentItemId } = store.getState();
  const queries = [];
  if (currentItemId === itemId) {
    queries.push(
      queryClient.invalidateQueries({ queryKey: ['current-review-item'] })
    );
  }
  queries.push(
    queryClient.invalidateQueries({
      queryKey: ['item', itemId],
    })
  );

  await Promise.all(queries);
};

export async function invalidateCurrentItemQuery() {
  const { currentItemId } = store.getState();
  const queries = [];
  queries.push(
    queryClient.invalidateQueries({ queryKey: ['current-review-item'] })
  );
  if (currentItemId) {
    queries.push(
      queryClient.invalidateQueries({
        queryKey: ['item', currentItemId],
      })
    );
  }
  await Promise.all(queries);
}

/**
 * Invalidates the React Query cache when the passed file is also open in
 * review. Used to keep review in sync with other editor panes.
 */
export async function invalidateCacheOnMatch(
  file: TAbstractFile,
  reviewManager: ReviewManager
) {
  // Skip cache invalidation if the modification came from the review view itself
  if (store.getState().isReviewViewSaving) {
    return;
  }

  const currentItem = await fetchCurrentItem(reviewManager);
  if (!currentItem || currentItem.file.path !== file.path) {
    return;
  }

  await invalidateItemQuery(currentItem.data.id);
}
/**
 * Resets the current item if it matches the passed file. Use when deleting files.
 */
export async function resetCurrentOnMatch(
  file: TAbstractFile,
  reviewManager: ReviewManager
) {
  const currentItem = await fetchCurrentItem(reviewManager);
  if (!currentItem || currentItem.file.path !== file.path) {
    return;
  }

  store.dispatch(resetCurrentItem());
}

/**
 * Deep merges updated fields into locally cached item data.
 * Iterables are overwritten instead of being merged.
 * @param updates a partial object containing updates, or an updater function
 */
export function updateQueryCache<T extends ReviewItem, D extends T['data']>(
  id: string,
  updates: DeepPartial<D> | ((cachedData: T) => ReviewItem)
) {
  const { currentItemId } = store.getState();
  if (typeof updates === 'function') {
    queryClient.setQueryData(['item', id], updates);
    if (id === currentItemId)
      queryClient.setQueryData(currentItemQueryKey(currentItemId), updates);
  } else {
    queryClient.setQueryData(['item', id], (prev: T) => ({
      ...prev,
      data: deepMerge(prev.data, updates),
    }));
    if (id === currentItemId)
      queryClient.setQueryData(
        currentItemQueryKey(currentItemId),
        (prev: T) => ({
          ...prev,
          data: deepMerge(prev.data, updates),
        })
      );
  }
}
/**
 * Apply a repository data-change event to the cached review-queue pages.
 *
 * `update` events are patched in place for instant feedback: each affected row
 * that is currently displayed is refetched and either replaced (still due) or
 * removed (dismissed / deleted / no longer due). Because a change can also
 * reorder rows or move them across pages, the queue is then invalidated so
 * react-query reconciles order and totals.
 *
 * `insert` events (a new row whose page position is unknown) just invalidate.
 *
 * `refetchType: 'all'` is required: imports and card/snippet creation happen
 * while the review-queue tab is closed, so its query is inactive. The default
 * (`'active'`) would only mark it stale, leaving the added/changed row hidden
 * until the tab is reopened and refetched. Refetching all cached pages keeps
 * the queue correct even while it is not on screen.
 */
export async function applyQueueChange(
  event: DataChangeEvent,
  reviewManager: ReviewManager
): Promise<void> {
  if (event.op === 'update') {
    await patchQueuePages(event.ids, reviewManager);
  }
  await queryClient.invalidateQueries({
    queryKey: ['queue'],
    refetchType: 'all',
  });
}

/**
 * Refetch each changed id and splice it into every cached queue page: replace
 * the row where still due, drop it (adjusting `totalRows`) where it has left
 * the queue. Ids not currently on a page are ignored — the trailing invalidate
 * picks up any that should newly appear.
 */
async function patchQueuePages(
  ids: string[],
  reviewManager: ReviewManager
): Promise<void> {
  const entries = queryClient.getQueriesData<QueuePage>({
    queryKey: ['queue'],
  });
  if (entries.length === 0) return;

  // Resolve each changed id once, then reuse across every cached page.
  const resolved = new Map<string, QueueRow | null>();
  for (const id of ids) {
    resolved.set(id, await reviewManager.getQueueRow(id));
  }

  for (const [queryKey, page] of entries) {
    if (!page) continue;
    let changed = false;
    let removed = 0;
    const rows: QueueRow[] = [];
    for (const row of page.rows) {
      if (!resolved.has(row.id)) {
        rows.push(row);
        continue;
      }
      const next = resolved.get(row.id) ?? null;
      changed = true;
      if (next === null) {
        removed += 1; // row left the queue
      } else {
        rows.push(next); // row updated in place
      }
    }
    if (!changed) continue;
    queryClient.setQueryData<QueuePage>(queryKey, {
      rows,
      totalRows: Math.max(0, page.totalRows - removed),
      // The span is carried forward rather than recomputed: it describes the
      // whole queue, and this patch sees only the cached pages, so it cannot
      // tell what the new extent is when a boundary item leaves. A slightly
      // stale bound self-corrects on the next fetch; dropping it would
      // un-clamp the date field in the meantime.
      firstDue: page.firstDue,
      lastDue: page.lastDue,
    });
  }
}
// #endregion

// #region internal helpers

/**
 * Get next due item, reset item state, and update card delimiters
 */
async function fetchNextItem(
  reviewManager: ReviewManager
): Promise<ReviewItem | null> {
  const storeState = store.getState();
  const seenIds = getSeenIds(storeState);
  const { typesToReview } = storeState;
  const excludeIds = Object.keys(seenIds);
  const result = await reviewManager.getDue({
    ...(excludeIds.length && { excludeIds }),
    typesToInclude: typesToReview,
  });
  const nextItem: ReviewItem | null =
    result.all.filter(({ data }) => !Object.hasOwn(seenIds, data.id))[0] ??
    null;

  if (nextItem) {
    queryClient.setQueryData(['item', nextItem.data.id], nextItem);
    // Seed the key the dispatch below is about to move the view onto, so it
    // lands on this item rather than on a miss and a second spinner. The item
    // is still read twice: `useCurrentItem` invalidates on every id change, so
    // it refetches straight away, but behind the seeded data instead of in
    // place of it.
    queryClient.setQueryData(currentItemQueryKey(nextItem.data.id), nextItem);

    // update card delimiters
    if (isReviewCard(nextItem)) {
      await reviewManager.cards.updateDelimiters(nextItem, CLOZE_DELIMITERS);
    }
  }
  store.dispatch(setCurrentItemId(nextItem?.data.id ?? null));
  return nextItem;
}
// #endregion
