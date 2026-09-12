import { useReviewContext } from '#/components/ReviewContext';
import type { QueueSubset } from '#/components/types';
import { CURRENT_ITEM_REFETCH_TIME } from '#/lib/constants';
import {
  currentItemQueryFn,
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

export function useCurrentItem() {
  const { reviewManager, reviewView } = useReviewContext();
  // subscribe to currentItemId so that this is re-fetched when it changes
  const currentItemId = useAppSelector((state) => state.currentItemId);
  const result = useQuery({
    refetchInterval: CURRENT_ITEM_REFETCH_TIME,
    queryKey: ['current-review-item'],
    queryFn: async () => {
      const item = await currentItemQueryFn(reviewManager);
      return item;
    },
  });

  useEffect(() => {
    void invalidateCurrentItemQuery();
  }, [currentItemId]);

  useEffect(() => {
    async function viewHandleFileChange() {
      if (reviewView.file) {
        await reviewView.onUnloadFile(reviewView.file);
      }
      reviewView.setFile(result.data?.file ?? null);
      if (result.data?.file) {
        await reviewView.onLoadFile(result.data?.file);
      }
    }
    void viewHandleFileChange();
  }, [result.data?.file, reviewView]);

  return result;
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
