import type IncrementalReadingPlugin from '#/main';
import type { WorkspaceLeaf } from 'obsidian';
import { ReviewContextProvider, UseReviewContext } from './ReviewContext';
import ReviewItem from './ReviewItem';
import type ReviewManager from '#/lib/ReviewManager';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const client = new QueryClient();

export function createReviewInterface(props: {
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
  const reviewContext = UseReviewContext();
  reviewContext.currentItem = reviewContext.reviewQueue?.[0] ?? null;
  const nextItem = reviewContext.reviewQueue?.[0];
  console.log({ reviewContext });
  return (
    <div className={'ir-review-interface'}>
      {nextItem && <ReviewItem item={nextItem} />}
    </div>
  );
}
