import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Dispatch } from 'react';
import {
  type PropsWithChildren,
  createContext,
  useContext,
  useState,
} from 'react';
import type { IArticleActive, ReviewCard } from '#/lib/types';
import {
  isReviewCard,
  isReviewSnippet,
  type ISnippetActive,
  type ISRSCardDisplay,
  type ReviewItem,
} from '#/lib/types';
import {
  CLOZE_DELIMITERS,
  CONTENT_TITLE_SLICE_LENGTH,
  LEGACY_CLOZE_DELIMITERS,
  MS_PER_DAY,
  REVIEW_FETCH_COUNT,
  SUCCESS_NOTICE_DURATION_MS,
} from '#/lib/constants';
import type ReviewManager from '#/lib/ReviewManager';
import type ReviewView from '#/views/ReviewView';
import type { WorkspaceLeaf } from 'obsidian';
import type IncrementalReadingPlugin from '#/main';
import type { Grade } from 'ts-fsrs';
import { Rating } from 'ts-fsrs';
import type { StateUpdater } from 'preact/hooks';
import { getContentSlice, splitFrontMatter } from '#/lib/utils';

interface ReviewContextProps {
  plugin: IncrementalReadingPlugin;
  reviewView: ReviewView;
  reviewManager: ReviewManager;
  currentItem: ReviewItem | undefined;
  getNext: () => void;
  reviewArticle: (
    article: IArticleActive,
    nextInterval?: number
  ) => Promise<void>;
  reviewSnippet: (
    snippet: ISnippetActive,
    nextInterval?: number
  ) => Promise<void>;
  gradeCard: (card: ISRSCardDisplay, grade: Grade) => Promise<void>;
  dismissItem: (item: ReviewItem) => Promise<void>;
  skipItem: (item: ReviewItem) => void;
  showAnswer: boolean;
  setShowAnswer: Dispatch<StateUpdater<boolean>>;
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
  const [showAnswer, setShowAnswer] = useState(false);

  const queryClient = useQueryClient();
  const {
    isPending,
    isError,
    data: currentItem,
  } = useQuery({
    queryKey: ['current-review-item'],
    queryFn: async () => {
      const result = await reviewManager.getDue({
        dueBy: Date.now() + MS_PER_DAY * 2,
        limit: REVIEW_FETCH_COUNT,
      });
      const nextItem =
        result.all.filter(({ data }) => !reviewView.seenIds.has(data.id))[0] ??
        null;
      if (isReviewCard(nextItem)) await updateDelimiters(nextItem);
      setShowAnswer(false);
      reviewView.currentItem = nextItem ?? null;
      return nextItem;
    },
  });

  const updateDelimiters = async (reviewCard: ReviewCard) => {
    try {
      let currentDelimiters = LEGACY_CLOZE_DELIMITERS;
      let delimitersChanged = true;
      const [left, right] = CLOZE_DELIMITERS;

      await plugin.app.fileManager.processFrontMatter(
        reviewCard.file,
        (frontmatter: Record<string, any>) => {
          if ('delimiters' in frontmatter) {
            currentDelimiters = frontmatter.delimiters as [string, string];
          }
          if (!Array.isArray(currentDelimiters)) {
            throw new TypeError(
              `Delimiters stored on note "${reviewCard.data.reference}" were not a list`
            );
          }
          if (currentDelimiters[0] === left && currentDelimiters[1] === right) {
            delimitersChanged = false;
          } else {
            frontmatter.delimiters = CLOZE_DELIMITERS;
          }
        }
      );
      if (!delimitersChanged) return;

      await plugin.app.vault.process(reviewCard.file, (fileText) => {
        const split = splitFrontMatter(fileText);
        if (!split)
          throw new Error(
            `Failed to parse frontmatter from note "${reviewCard.data.reference}, but note has frontmatter`
          );
        const { start, answer, end } = reviewManager.parseCloze(
          split.body,
          currentDelimiters
        );
        return split.frontMatter + start + `${left}${answer}${right}` + end;
      });
    } catch (error) {
      if (error instanceof Error) {
        const refMessage = `\nThis error occurred in "${reviewCard.data.reference}"`;
        throw new Error(error.message + refMessage);
      }
    }
  };

  const getNext = () => {
    queryClient.invalidateQueries({ queryKey: ['current-review-item'] });
  };

  const reviewArticle = async (
    article: IArticleActive,
    nextInterval?: number
  ) => {
    try {
      await reviewManager.reviewArticle(article, Date.now(), nextInterval);
      reviewView.seenIds.add(article.id);
      if (nextInterval) {
        new Notice(
          `Next article review manually scheduled for ` +
            `${Math.round((10 * nextInterval) / MS_PER_DAY) / 10} days from now`,
          SUCCESS_NOTICE_DURATION_MS
        );
      }
      getNext();
    } catch (error) {
      console.error(error);
    }
  };

  const reviewSnippet = async (
    snippet: ISnippetActive,
    nextInterval?: number
  ) => {
    try {
      await reviewManager.reviewSnippet(snippet, Date.now(), nextInterval);
      reviewView.seenIds.add(snippet.id);
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
    await reviewManager.reviewCard(card, grade);
    reviewView.seenIds.add(card.id);
    new Notice(`Graded as: ${Rating[grade]}`);
    getNext();
  };

  const dismissItem = async (item: ReviewItem) => {
    if (isReviewCard(item)) {
      await reviewManager.dismissCard(item.data);
    } else if (isReviewSnippet(item)) {
      await reviewManager.dismissSnippet(item.data);
    } else {
      await reviewManager.dismissArticle(item.data);
    }
    reviewView.seenIds.add(item.data.id);

    const { reference } = item.data;
    const [folder, subRef] = reference.split('/');
    const type = folder.slice(0, -1);
    new Notice(
      `Dismissed ${type} "${getContentSlice(subRef, CONTENT_TITLE_SLICE_LENGTH, true)}"`
    );
    getNext();
  };

  const skipItem = (item: ReviewItem) => {
    reviewView.seenIds.add(item.data.id);

    const { reference } = item.data;
    const [folder, subRef] = reference.split('/');
    new Notice(
      `Skipping ${folder}/${getContentSlice(subRef, CONTENT_TITLE_SLICE_LENGTH + 5, true)} until next session`
    );
    getNext();
  };

  const value = {
    plugin,
    reviewView,
    reviewManager,
    currentItem,
    getNext,
    reviewArticle,
    reviewSnippet,
    gradeCard,
    dismissItem,
    skipItem,
    showAnswer,
    setShowAnswer,
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
