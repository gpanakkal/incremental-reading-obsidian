import { useQuery } from '@tanstack/react-query';
import { type PropsWithChildren, createContext, useContext } from 'react';
import type { ReviewItem } from '#/db/types';
import { SNIPPET_BASE_REVIEW_INTERVAL } from '#/lib/constants';
import type ReviewManager from '#/lib/ReviewManager';
import ReviewView from '#/views/ReviewView';
import type { WorkspaceLeaf } from 'obsidian';
import type IncrementalReadingPlugin from '#/main';

interface ReviewContextProps {
  reviewView: ReviewView;
  reviewManager: ReviewManager;
  reviewQueue: ReviewItem[] | null;
  currentItem: ReviewItem | null;
}

const ReviewContext = createContext<ReviewContextProps | null>(null);

export function ReviewContextProvider({
  plugin,
  reviewManager,
  leaf,
  children,
}: PropsWithChildren<{
  plugin: IncrementalReadingPlugin;
  leaf: WorkspaceLeaf;
  reviewManager: ReviewManager;
}>) {
  const dueTime = Date.now() + 7 * SNIPPET_BASE_REVIEW_INTERVAL;
  const { isPending, isError, data } = useQuery({
    queryKey: ['review-queue'],
    queryFn: async () => await reviewManager.getDue({ dueBy: dueTime }),
  });

  const reviewQueue = data?.all ?? null;
  const value = {
    reviewView: new ReviewView(leaf, plugin, reviewManager),
    reviewManager,
    reviewQueue,
    currentItem: null,
  };
  return (
    <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>
  );
}

export function UseReviewContext() {
  const ctx = useContext(ReviewContext);
  if (ctx === null) {
    throw new Error('Review context can only be accessed within its provider');
  }
  return ctx;
}
