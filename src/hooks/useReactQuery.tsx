import { useQuery } from '@tanstack/react-query';
import { useReviewContext } from '#/components/ReviewContext';
import { useAppSelector } from './useAppSelector';
import {
  currentItemQueryFn,
  invalidateCurrentItemQuery,
} from '#/lib/query-client';
import { useEffect } from 'preact/hooks';

export function useCurrentItem() {
  const { reviewManager, reviewView } = useReviewContext();
  // subscribe to currentItemId so that this is re-fetched when it changes
  const currentItemId = useAppSelector((state) => state.currentItemId);
  const result = useQuery({
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
    reviewView.setFile(result.data?.file ?? null);
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
