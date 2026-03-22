import { useQuery } from '@tanstack/react-query';
import { useReviewContext } from '#/components/ReviewContext';
import { useAppSelector } from './useAppSelector';
import {
  currentItemQueryFn,
  invalidateCurrentItemQuery,
} from '#/lib/queryClient';
import { useEffect } from 'preact/hooks';

export function useCurrentItem() {
  const { reviewManager, reviewView } = useReviewContext();
  // subscribe to currentItemId so that this is re-fetched when it changes
  const currentItemId = useAppSelector((state) => state.currentItemId);
  const result = useQuery({
    queryKey: ['current-review-item'],
    queryFn: async () => {
      const item = await currentItemQueryFn(reviewManager);
      reviewView.setFile(item?.file ?? null);
      return item;
    },
  });

  useEffect(() => {
    void invalidateCurrentItemQuery();
  }, [currentItemId]);
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
