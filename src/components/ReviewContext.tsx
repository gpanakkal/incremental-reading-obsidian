import { useAppStore } from '#/hooks/useAppSelector';
import {
  CLOZE_DELIMITERS,
  CONTENT_TITLE_SLICE_LENGTH,
  ERROR_NOTICE_DURATION_MS,
  LEGACY_CLOZE_DELIMITERS,
  MS_PER_DAY,
  REVIEW_FETCH_COUNT,
  SUCCESS_NOTICE_DURATION_MS,
} from '#/lib/constants';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import type ReviewManager from '#/lib/ReviewManager';
import {
  addSeenId,
  setCurrentItem,
  setDismissed,
  setEditState,
  setShowAnswer,
} from '#/lib/store';
import type {
  ReviewArticle,
  ReviewCard,
  ReviewItem,
  ReviewSnippet,
} from '#/lib/types';
import { isReviewCard } from '#/lib/types';
import { deepCopy, getContentSlice, transformPriority } from '#/lib/utils';
import type IncrementalReadingPlugin from '#/main';
import type ReviewView from '#/views/ReviewView';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Scope, WorkspaceLeaf } from 'obsidian';
import { Notice } from 'obsidian';
import type { PropsWithChildren } from 'react';
import { createContext, useContext } from 'react';
import { useDispatch } from 'react-redux';
import type { Grade } from 'ts-fsrs';
import { Rating } from 'ts-fsrs';
import { EditingState } from './types';

interface ReviewContextProps {
  plugin: IncrementalReadingPlugin;
  reviewView: ReviewView;
  reviewManager: ReviewManager;
  getNext: () => void;
  reviewArticle: (
    article: ReviewArticle,
    nextInterval?: number
  ) => Promise<void>;
  reviewSnippet: (
    snippet: ReviewSnippet,
    nextInterval?: number
  ) => Promise<void>;
  reprioritize: (
    item: ReviewArticle | ReviewSnippet,
    newPriority: number
  ) => Promise<void>;
  gradeCard: (card: ReviewCard, grade: Grade) => Promise<void>;
  dismissItem: (item: ReviewItem) => Promise<void>;
  unDismissItem: (item: ReviewItem) => Promise<void>;
  skipItem: (item: ReviewItem) => void;
  saveNote: (item: ReviewItem, newContent: string) => Promise<void>;
  registerActionBarHotkey: Scope['register'];
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
  const queryClient = useQueryClient();
  const dispatch = useDispatch();
  const store = useAppStore();

  const { isPending, isError, data } = useQuery({
    queryKey: ['current-review-item'],
    queryFn: async () => {
      dispatch(setEditState(EditingState.cancel));
      dispatch(setShowAnswer(false));
      // Check if there's an initial item to display first
      if (reviewView.initialItem) {
        const initialItem = reviewView.initialItem;
        reviewView.initialItem = null; // Clear so next call uses normal queue
        if (isReviewCard(initialItem)) await updateDelimiters(initialItem);
        dispatch(setCurrentItem(initialItem));
        return initialItem;
      }

      const result = await reviewManager.getDue({
        limit: REVIEW_FETCH_COUNT,
      });
      const { seenIds } = plugin.store.getState();
      const nextItem: ReviewItem | null =
        result.all.filter(({ data }) => !seenIds.has(data.id))[0] ?? null;

      if (nextItem && isReviewCard(nextItem)) await updateDelimiters(nextItem);

      dispatch(setCurrentItem(nextItem));
      queryClient.setQueryData<ReviewItem>([nextItem.data.id], () => nextItem);
      return nextItem;
    },
  });

  const updateDelimiters = async (reviewCard: ReviewCard) => {
    try {
      let currentDelimiters = LEGACY_CLOZE_DELIMITERS;
      let delimitersChanged = true;
      const [left, right] = CLOZE_DELIMITERS;

      // Wrap file modifications in withReviewViewSave to prevent external modification detection
      await plugin.withReviewViewSave(async () => {
        await plugin.app.fileManager.processFrontMatter(
          reviewCard.file,
          (frontmatter: Record<string, unknown>) => {
            if ('delimiters' in frontmatter) {
              currentDelimiters = frontmatter.delimiters as [string, string];
            }
            if (!Array.isArray(currentDelimiters)) {
              throw new TypeError(
                `Delimiters stored on note "${reviewCard.data.reference}" were not a list`
              );
            }
            if (
              currentDelimiters[0] === left &&
              currentDelimiters[1] === right
            ) {
              delimitersChanged = false;
            } else {
              frontmatter.delimiters = CLOZE_DELIMITERS;
            }
          }
        );
        if (!delimitersChanged) return;

        await plugin.app.vault.process(reviewCard.file, (fileText) => {
          const split = Obsidian.splitFrontMatter(fileText);
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
    article: ReviewArticle,
    nextInterval?: number
  ) => {
    try {
      await reviewManager.reviewArticle(article.data, Date.now(), nextInterval);
      if (article.data.dismissed) {
        await unDismissItem(article);
      }
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
    snippet: ReviewSnippet,
    nextInterval?: number
  ) => {
    try {
      await reviewManager.reviewSnippet(snippet.data, Date.now(), nextInterval);
      if (snippet.data.dismissed) {
        await unDismissItem(snippet);
      }
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

  /**
   * @param newPriority decimal number from 1.0 to 5.0, inclusive
   */
  const reprioritize = async (
    item: ReviewArticle | ReviewSnippet,
    newPriority: number
  ) => {
    const priority = transformPriority(newPriority);
    try {
      await reviewManager.reprioritize(item.data, priority);
      new Notice(
        `Priority set to ${priority / 10}`,
        SUCCESS_NOTICE_DURATION_MS
      );
    } catch (error) {
      new Notice(
        `Failed to update priority for "${item.data.reference}"`,
        ERROR_NOTICE_DURATION_MS
      );
    }
  };

  const gradeCard = async (card: ReviewCard, grade: Grade) => {
    await reviewManager.reviewCard(card.data, grade);
    new Notice(`Graded as: ${Rating[grade]}`);
    if (card.data.dismissed) {
      await unDismissItem(card);
    }
    getNext();
  };

  const dismissItem = async (item: ReviewItem) => {
    await reviewManager.dismissItem(item);
    if (store.getState().currentItem?.data.id === item.data.id) {
      // update item in Redux store
      dispatch(setDismissed(true));
    }
    queryClient.setQueryData([item.data.id], (prev: ReviewItem) => {
      const updatedData = deepCopy(prev.data);
      return {
        data: {
          ...updatedData,
          dismissed: true,
        },
        file: prev.file,
      };
    });

    const [_folder, subRef] = item.data.reference.split('/');
    new Notice(
      `Dismissed "${getContentSlice(subRef, CONTENT_TITLE_SLICE_LENGTH, true)}"`
    );
    getNext();
  };

  const unDismissItem = async (item: ReviewItem) => {
    await reviewManager.unDismissItem(item);
    if (store.getState().currentItem?.data.id === item.data.id) {
      // update item in Redux store
      dispatch(setDismissed(false));
    }
    queryClient.setQueryData([item.data.id], (prev: ReviewItem) => {
      const updatedData = deepCopy(prev.data);
      return {
        data: {
          ...updatedData,
          dismissed: false,
        },
        file: prev.file,
      };
    });

    const [_folder, subRef] = item.data.reference.split('/');
    new Notice(
      `Restored "${getContentSlice(subRef, CONTENT_TITLE_SLICE_LENGTH, true)}" to queue`
    );
  };

  const skipItem = (item: ReviewItem) => {
    dispatch(addSeenId(item.data.id));

    const { reference } = item.data;
    const [folder, subRef] = reference.split('/');
    new Notice(
      `Skipping ${folder}/${getContentSlice(subRef, CONTENT_TITLE_SLICE_LENGTH + 5, true)} until next session`
    );
    getNext();
  };

  const saveNote = async (item: ReviewItem, newContent: string) => {
    // Save document content and highlight offsets together to avoid race conditions
    const highlights = reviewManager.snippets.offsetTracker.getHighlights(
      item.file.path
    );

    // Wrap in withReviewViewSave so it's recognized as an internal change
    await plugin.withReviewViewSave(async () => {
      await plugin.app.vault.process(item.file, () => newContent);

      // Save body-relative highlight offsets
      for (const h of highlights) {
        await reviewManager.updateSnippetOffsets(
          h.id,
          h.start_offset,
          h.end_offset
        );
      }
    });

    dispatch(setEditState(EditingState.complete));
  };

  const inEditMode = () => {
    const el = document.activeElement as HTMLElement | null;
    return (
      el &&
      (el.isContentEditable ||
        el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA')
    );
  };
  /**
   * Create a keybind that verifies we're not editing text
   */
  const registerActionBarHotkey: Scope['register'] = (modifiers, key, func) => {
    return reviewView.scope.register(modifiers, key, async (evt, ctx) => {
      // prevent other keybinds listeners from firing
      evt.stopImmediatePropagation();
      // const hotkeyStr = `${modifiers ? modifiers.join(' + ') + ' + ' : ''}${key}`;
      if (inEditMode()) {
        // console.log(`Ignoring keybind "${hotkeyStr}" since we're in edit mode`);
        return;
      }
      // console.log(`Triggered hotkey "${hotkeyStr}"`);
      await func(evt, ctx);
    });
  };

  const value = {
    plugin,
    reviewView,
    reviewManager,
    getNext,
    reviewArticle,
    reviewSnippet,
    reprioritize,
    gradeCard,
    dismissItem,
    unDismissItem,
    skipItem,
    saveNote,
    registerActionBarHotkey,
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
