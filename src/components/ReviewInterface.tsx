import type { WorkspaceLeaf } from 'obsidian';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type IncrementalReadingPlugin from '#/main';
import { ReviewContextProvider, useReviewContext } from './ReviewContext';
import ReviewItem from './ReviewItem';
import type ReviewManager from '#/lib/ReviewManager';
import type ReviewView from '#/views/ReviewView';
import { ActionBar } from './ActionBar';

const client = new QueryClient();

export function createReviewInterface(props: {
  reviewView: ReviewView;
  plugin: IncrementalReadingPlugin;
  leaf: WorkspaceLeaf;
  reviewManager: ReviewManager;
}) {
  return (
    <QueryClientProvider client={client}>
      <ReviewContextProvider {...props}>
        <ReviewInterface />
      </ReviewContextProvider>
    </QueryClientProvider>
  );
}

function ReviewInterface() {
  const reviewContext = useReviewContext();
  const currentItem = reviewContext.currentItem ?? reviewContext.getNext();

  return (
    <div className={'ir-review-interface view-content'}>
      <ActionBar />
      {currentItem ? (
        <ReviewItem item={currentItem} />
      ) : (
        <div className="ir-review-placeholder">Nothing due for review.</div>
      )}
    </div>
  );
}
