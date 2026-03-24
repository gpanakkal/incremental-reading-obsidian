import { QueryClientProvider } from '@tanstack/react-query';
import { Provider as ReduxProvider } from 'react-redux';
import { useCurrentItem } from '#/hooks/useReactQuery';
import { queryClient } from '#/lib/query-client';
import type ReviewManager from '#/lib/ReviewManager';
import type IncrementalReadingPlugin from '#/main';
import type ReviewView from '#/views/ReviewView';
import { ActionBar } from './ActionBar';
import { ReviewContextProvider } from './ReviewContext';
import ReviewItem from './ReviewItem';

export function createReviewInterface(props: {
  reviewView: ReviewView;
  plugin: IncrementalReadingPlugin;
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
  const { data: item } = useCurrentItem();

  return (
    <div className={'ir-review-interface view-content'}>
      {item ? (
        <>
          <ActionBar />
          <ReviewItem item={item} />
        </>
      ) : (
        <div className="ir-review-placeholder">Nothing due for review.</div>
      )}
    </div>
  );
}
