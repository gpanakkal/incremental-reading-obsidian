import { QueryClient } from '@tanstack/react-query';
import type ReviewManager from './ReviewManager';
import { isReviewCard, type ReviewItem } from './types';
import type { TAbstractFile, TFile } from 'obsidian';
import { deepMerge } from './utils';
import type { DeepPartial } from './utility-types';
import {
  CLOZE_DELIMITERS,
  QUERY_STALE_TIME,
  REVIEW_FETCH_COUNT,
} from './constants';
import { setCurrentItemId, store } from './store';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: QUERY_STALE_TIME,
    },
  },
});

// #region Queries for use outside React only
// see useReactQuery.tsx for React queries

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
 * Deep merges updated fields into local cache on the item ID key.
 *  Note that iterables are overwritten instead of being merged
 * @param updates a partial object containing updates, or an updater function
 */
export function updateQueryCache<T extends ReviewItem, D extends T['data']>(
  id: string,
  updates: DeepPartial<D> | ((cachedData: T) => ReviewItem)
) {
  if (typeof updates === 'function') {
    return queryClient.setQueryData(['item', id], updates);
  }
  return queryClient.setQueryData(['item', id], (prev: T) => ({
    ...prev,
    data: deepMerge(prev.data, updates),
  }));
}
// #endregion

// #region internal helpers

/**
 * Get next due item, reset item state, and update card delimiters
 * TODO: add seenIds arg to reviewManager.getDue and move filtering
 * into SQL query
 */
async function fetchNextItem(
  reviewManager: ReviewManager
): Promise<ReviewItem | null> {
  const result = await reviewManager.getDue({
    limit: REVIEW_FETCH_COUNT,
  });
  const { seenIds } = store.getState();
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
