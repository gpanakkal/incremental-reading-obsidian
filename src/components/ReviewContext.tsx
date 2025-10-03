import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type PropsWithChildren,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  isReviewCard,
  type ISnippet,
  type ISRSCardDisplay,
  type ReviewItem,
} from '#/db/types';
import {
  MS_PER_DAY,
  REVIEW_FETCH_COUNT,
  SNIPPET_BASE_REVIEW_INTERVAL,
  SUCCESS_NOTICE_DURATION_MS,
} from '#/lib/constants';
import type ReviewManager from '#/lib/ReviewManager';
import type ReviewView from '#/views/ReviewView';
import type { WorkspaceLeaf } from 'obsidian';
import type IncrementalReadingPlugin from '#/main';
import type { Grade } from 'ts-fsrs';

interface ReviewContextProps {
  plugin: IncrementalReadingPlugin;
  reviewView: ReviewView;
  reviewManager: ReviewManager;
  reviewQueue: {
    all: ReviewItem[];
    cards: ReviewItem[];
    snippets: ReviewItem[];
  } | null;
  currentItem: ReviewItem | null;
  getNext: () => ReviewItem | null;
  reviewSnippet: (snippet: ISnippet, nextInterval?: number) => Promise<void>;
  gradeCard: (card: ISRSCardDisplay, grade: Grade) => Promise<void>;
  dismissItem: (item: ReviewItem) => Promise<void>;
}

const ReviewContext = createContext<ReviewContextProps | null>(null);

export function ReviewContextProvider({
  plugin,
  reviewView,
  reviewManager,
  leaf,
  children,
}: PropsWithChildren<{
  reviewView: ReviewView;
  plugin: IncrementalReadingPlugin;
  leaf: WorkspaceLeaf;
  reviewManager: ReviewManager;
}>) {
  const [currentIndex, setCurrentIndex] = useState<number>(0);

  const queryClient = useQueryClient();
  const {
    isPending,
    isError,
    data: reviewQueue,
  } = useQuery({
    queryKey: ['review-queue'],
    queryFn: async () =>
      await reviewManager.getDue({ limit: REVIEW_FETCH_COUNT }),
  });

  // reset the index when the review queue is updated
  useEffect(() => {
    setCurrentIndex(0);
  }, [reviewQueue]);

  const currentItem = useMemo((): ReviewItem | null => {
    if (!reviewQueue || !reviewQueue.all.length) return null;
    else if (currentIndex >= reviewQueue.all.length) {
      throw new Error(
        `currentIndex ${currentIndex} is out of range ` +
          `for review queue with length ${reviewQueue.all.length}`
      );
    } else {
      const currentItem = reviewQueue.all[currentIndex];
      reviewView.currentItem = currentItem;
      return currentItem;
    }
  }, [currentIndex, reviewQueue]);

  const getNext = () => {
    if (!reviewQueue?.all.length) {
      return null;
    } else if (currentIndex === reviewQueue.all.length - 1) {
      // at end of stored queue, so refresh
      queryClient.invalidateQueries({ queryKey: ['review-queue'] });
      setCurrentIndex(0);
      return reviewQueue?.all[0] ?? null; // TODO: verify this correctly refers to the newly fetched queue
    } else {
      setCurrentIndex((prev: number) => prev + 1);
      return reviewQueue.all[currentIndex]; // TODO: fix so this uses the updated value
    }
  };

  const reviewSnippet = async (snippet: ISnippet, nextInterval?: number) => {
    try {
      await reviewManager.reviewSnippet(snippet, Date.now(), nextInterval);
      if (nextInterval) {
        new Notice(
          `Next snippet review manually scheduled for ` +
            `${Math.round((10 * nextInterval) / MS_PER_DAY) / 10} days from now`,
          SUCCESS_NOTICE_DURATION_MS
        );
      }
      getNext();
    } catch (error) {
      console.error(error);
    }
  };

  const gradeCard = async (card: ISRSCardDisplay, grade: Grade) => {
    new Notice(`Graded as: ${grade}`);
    await reviewManager.reviewCard(card, grade);
    getNext();
  };

  const dismissItem = async (item: ReviewItem) => {
    if (isReviewCard(item)) {
      await reviewManager.dismissCard(item.data);
    } else {
      await reviewManager.dismissSnippet(item.data);
    }
  };

  const value = {
    plugin,
    reviewView,
    reviewManager,
    reviewQueue: reviewQueue ?? null,
    currentItem,
    getNext,
    reviewSnippet,
    gradeCard,
    dismissItem,
  };
  return (
    <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>
  );
}

export function useReviewContext() {
  const ctx = useContext(ReviewContext);
  if (ctx === null) {
    throw new Error('Review context can only be accessed within its provider');
  }
  return ctx;
}
