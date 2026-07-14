import { useReviewContext } from '#/components/ReviewContext';
import type { QueueSubset } from '#/components/types';
import { CURRENT_ITEM_REFETCH_TIME } from '#/lib/constants';
import {
  currentItemQueryFn,
  invalidateCurrentItemQuery,
} from '#/lib/query-client';
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

export function useCurrentItemFileText() {
  const { plugin } = useReviewContext();
  const { data: currentItem } = useCurrentItem();

  return useQuery({
    enabled: !!currentItem,
    queryKey: ['item', currentItem?.data.id, 'file-text'],
    queryFn: async () => {
      if (!currentItem) return;
      return plugin.app.vault.read(currentItem.file);
    },
  });
}
