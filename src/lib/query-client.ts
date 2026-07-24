import type { QueuePage, QueueRow } from '#/components/types';
import { QueryClient } from '@tanstack/react-query';
import type { TAbstractFile, TFile } from 'obsidian';
import { CLOZE_DELIMITERS, QUERY_STALE_TIME } from './constants';
import type ReviewManager from './items/ReviewManager';
import { getSeenIds, resetCurrentItem, setCurrentItemId, store } from './store';
import type { DataChangeEvent } from './types';
import { isReviewCard, type ReviewItem } from './types';
import type { DeepPartial } from './utility-types';
import { deepMerge } from './utils';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: QUERY_STALE_TIME,
    },
  },
});

// #region Queries for use outside React only
// see useReactQuery.tsx for React queries

/** Does not auto-refetch */
export async function fetchCurrentItem(
  reviewManager: ReviewManager
): Promise<ReviewItem | null> {
  const { currentItemId } = store.getState();
  return queryClient.fetchQuery({
    queryKey: ['current-review-item'],
    queryFn: async () => {
      if (currentItemId === null) return null;
      return reviewManager.getReviewItemFromId(currentItemId);
    },
  });
}

export const getCurrentItemSync = (): ReviewItem | undefined =>
  queryClient.getQueryData(['current-review-item']);

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

export const currentItemQueryFn = async (
  reviewManager: ReviewManager
): Promise<ReviewItem | null> => {
  const { currentItemId } = store.getState();
  if (currentItemId) {
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

export async function refetchCurrentItem() {
  return queryClient.refetchQueries({
    queryKey: ['current-review-item'],
  });
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
    // console.log('review view is saving; skipping invalidation');
    return;
  }

  const currentItem = await fetchCurrentItem(reviewManager);
  if (!currentItem || currentItem.file.path !== file.path) {
    // console.log(
    //   `modified file doesn't match current item; skipping invalidation`
    // );
    return;
  }
  // console.log('invalidating item cache');

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
      queryClient.setQueryData(['current-review-item'], updates);
  } else {
    queryClient.setQueryData(['item', id], (prev: T) => ({
      ...prev,
      data: deepMerge(prev.data, updates),
    }));
    if (id === currentItemId)
      queryClient.setQueryData(['current-review-item'], (prev: T) => ({
        ...prev,
        data: deepMerge(prev.data, updates),
      }));
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
    result.all.filter(({ data }) => !(data.id in seenIds))[0] ?? null;

  if (nextItem) {
    queryClient.setQueryData(['item', nextItem.data.id], nextItem);

    // update card delimiters
    if (isReviewCard(nextItem)) {
      await reviewManager.cards.updateDelimiters(nextItem, CLOZE_DELIMITERS);
    }
  }
  store.dispatch(setCurrentItemId(nextItem?.data.id ?? null));
  return nextItem;
}
// #endregion
