import { useReviewContext } from '#/components/ReviewContext';
import type { QueueSubset } from '#/components/types';
import { CURRENT_ITEM_REFETCH_TIME } from '#/lib/constants';
import {
  currentItemQueryFn,
  currentItemQueryKey,
  invalidateCurrentItemQuery,
} from '#/lib/query-client';
import type { ReviewItem } from '#/lib/types';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useAppSelector } from './useAppSelector';

/**
 * Fetch a review-queue subset as a flat, sorted array of `QueueRow`
 */
export function useQueue(subset: QueueSubset) {
  const { reviewManager } = useReviewContext();
  return useQuery({
    queryKey: ['queue', subset],
    queryFn: async () => reviewManager.getQueue(subset),
  });
}

/**
 * The item review is showing, or nothing while it is still being resolved.
 *
 * Narrower than the query result it is built from, deliberately: the two fields
 * here are corrected below for the cache holding an item the store has already
 * moved off, and the rest of a react-query result would go on describing the
 * uncorrected query — `isSuccess` true beside an undefined `data`. Spreading
 * the result would also read every one of its fields, which is how react-query
 * decides what to re-render on, and so would wake this hook on each five-second
 * refetch whether or not the item changed.
 */
export function useCurrentItem(): {
  data: ReviewItem | null | undefined;
  isLoading: boolean;
} {
  const { reviewManager, reviewView } = useReviewContext();
  // In the key, not merely subscribed to: see `currentItemQueryKey`. Picking a
  // different item has to be a different query, or react-query answers with the
  // one before it.
  const currentItemId = useAppSelector((state) => state.currentItemId);
  const query = useQuery({
    refetchInterval: CURRENT_ITEM_REFETCH_TIME,
    queryKey: currentItemQueryKey(currentItemId),
    queryFn: async () => currentItemQueryFn(reviewManager, currentItemId),
  });

  // A null id is review between items: the queue has not named the next one
  // yet, so the entry under that key is whatever the *last* advance resolved
  // to — the item just finished — and returning it would put it straight back
  // on screen. The one value it can be trusted for is `null`, which is the
  // advance having come back empty and is how an exhausted queue reports
  // itself; treating that as unresolved would leave the empty queue spinning.
  const advancing = currentItemId === null && query.data !== null;

  const data = advancing ? undefined : query.data;
  const isLoading = advancing || query.isLoading;

  // Still needed with the id in the key, for the one transition the key cannot
  // drive: arriving back on the `null` key with a cached, still-fresh advance
  // in it, where react-query would otherwise serve it without refetching and
  // leave `advancing` above stuck true.
  useEffect(() => {
    void invalidateCurrentItemQuery();
  }, [currentItemId]);

  useEffect(() => {
    async function viewHandleFileChange() {
      if (reviewView.file) {
        await reviewView.onUnloadFile(reviewView.file);
      }
      reviewView.setFile(data?.file ?? null);
      if (data?.file) {
        await reviewView.onLoadFile(data.file);
      }
    }
    void viewHandleFileChange();
  }, [data?.file, reviewView]);

  return { data, isLoading };
}

/**
 * The current item's file text, together with the item it was read from.
 * The text is cached per item id, so the returned `item` is always the one
 * this render keyed the fetch on; pairing the text with an item taken from
 * anywhere else (a prop, an earlier render) can put one item's content in
 * front of another item's file, and the review editor writes back what it
 * displays.
 */
export function useCurrentItemFileText(): {
  item: ReviewItem | null;
  text: string | undefined;
  isLoading: boolean;
} {
  const { plugin } = useReviewContext();
  const { data: currentItem, isLoading: itemLoading } = useCurrentItem();

  const { data: text, isLoading: textLoading } = useQuery({
    enabled: !!currentItem,
    queryKey: ['item', currentItem?.data.id, 'file-text'],
    queryFn: async () => {
      if (!currentItem) return;
      return plugin.app.vault.read(currentItem.file);
    },
  });

  return {
    item: currentItem ?? null,
    text,
    // Both flags, because each query is only ever loading on its own leg of
    // the chain: the item is still being resolved, or it has been and its file
    // is still being read. The text query is disabled until an item exists and
    // a disabled query never reports loading, so an absent item cannot leave
    // this stuck true — once the item resolves to null, neither leg is loading
    // and the caller is free to say nothing is due.
    isLoading: itemLoading || textLoading,
  };
}
