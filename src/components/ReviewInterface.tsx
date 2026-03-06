import type { WorkspaceLeaf } from 'obsidian';
import { Provider as ReduxProvider } from 'react-redux';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import type IncrementalReadingPlugin from '#/main';
import { ReviewContextProvider, useReviewContext } from './ReviewContext';
import ReviewItem from './ReviewItem';
import type ReviewManager from '#/lib/ReviewManager';
import type ReviewView from '#/views/ReviewView';
import { ActionBar } from './ActionBar';
import { queryClient } from '#/lib/queryClient';
import { useAppSelector } from '#/hooks/useAppSelector';

export function createReviewInterface(props: {
  reviewView: ReviewView;
  plugin: IncrementalReadingPlugin;
  leaf: WorkspaceLeaf;
  reviewManager: ReviewManager;
}) {
  return (
    <ReduxProvider store={props.plugin.store}>
      <QueryClientProvider client={queryClient}>
        <ReviewContextProvider {...props}>
          <ReviewInterface />
        </ReviewContextProvider>
      </QueryClientProvider>
    </ReduxProvider>
  );
}

function ReviewInterface() {
  const currentItem = useAppSelector((state) => state.currentItem);
  const { getNext, reviewManager } = useReviewContext();
  if (!currentItem) getNext();
  const { data: item } = useQuery({
    queryKey: [currentItem?.data.id],
    queryFn: async () => {
      if (!currentItem) return;
      const item = await reviewManager.getReviewItemFromFile(currentItem.file);
      return item;
    },
  });

  return (
    <div className={'ir-review-interface view-content'}>
      <ActionBar />
      {item ? (
        <ReviewItem item={item} />
      ) : (
        <div className="ir-review-placeholder">Nothing due for review.</div>
      )}
    </div>
  );
}
