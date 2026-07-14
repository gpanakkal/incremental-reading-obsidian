import { useAppSelector } from '#/hooks/useAppSelector';
import { useCurrentItem } from '#/hooks/useReactQuery';
import type ReviewManager from '#/lib/items/ReviewManager';
import { queryClient } from '#/lib/query-client';
import type IncrementalReadingPlugin from '#/main';
import type ReviewView from '#/views/ReviewView';
import { QueryClientProvider } from '@tanstack/react-query';
import { Provider as ReduxProvider } from 'react-redux';
import { ActionBar } from './action-bar/ActionBar';
import { ReviewContextProvider } from './ReviewContext';
import { ReviewHome } from './ReviewHome';
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
  const page = useAppSelector((state) => state.page);

  return (
    <div className={'ir-review-interface view-content'}>
      <ActionBar />
      {page === 'home' ? <ReviewHome /> : <ReviewItemView />}
    </div>
  );
}

/** The single-item review flow, reached by clicking a queue row. */
function ReviewItemView() {
  const { data: item } = useCurrentItem();

  return item ? (
    <ReviewItem item={item} />
  ) : (
    <div className="ir-review-placeholder">Nothing due for review.</div>
  );
}
