import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Dispatch } from 'react';
import {
  type PropsWithChildren,
  createContext,
  useContext,
  useState,
} from 'react';
import type { ReviewArticle, ReviewCard, ReviewSnippet } from '#/lib/types';
import { isReviewCard, type ReviewItem } from '#/lib/types';
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
import type { Scope } from 'obsidian';
import { Notice, type WorkspaceLeaf } from 'obsidian';
import type IncrementalReadingPlugin from '#/main';
import type { Grade } from 'ts-fsrs';
import { Rating } from 'ts-fsrs';
import type { StateUpdater } from 'preact/hooks';
import type { EditState } from './types';
import { EditingState } from './types';
import { deepCopy, getContentSlice, splitFrontMatter } from '#/lib/utils';

interface ReviewContextProps {
  plugin: IncrementalReadingPlugin;
  reviewView: ReviewView;
  reviewManager: ReviewManager;
  currentItem: ReviewItem | undefined;
  getNext: () => void;
  reviewArticle: (
    article: ReviewArticle,
    nextInterval?: number
  ) => Promise<void>;
  reviewSnippet: (
    snippet: ReviewSnippet,
    nextInterval?: number
  ) => Promise<void>;
  gradeCard: (card: ReviewCard, grade: Grade) => Promise<void>;
  dismissItem: (item: ReviewItem) => Promise<void>;
  unDismissItem: (item: ReviewItem) => Promise<void>;
  skipItem: (item: ReviewItem) => void;
  showAnswer: boolean;
  setShowAnswer: Dispatch<StateUpdater<boolean>>;
  editState: EditState;
  setEditState: Dispatch<StateUpdater<EditState>>;
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
  const [showAnswer, setShowAnswer] = useState(false);
  const [editState, setEditState] = useState<EditState>(EditingState.cancel);

  const queryClient = useQueryClient();
  const {
    isPending,
    isError,
    data: currentItem,
  } = useQuery({
    queryKey: ['current-review-item'],
    queryFn: async () => {
      setEditState(EditingState.cancel);
      // Check if there's an initial item to display first
      if (reviewView.initialItem) {
        const initialItem = reviewView.initialItem;
        reviewView.initialItem = null; // Clear so next call uses normal queue
        if (isReviewCard(initialItem)) await updateDelimiters(initialItem);
        setShowAnswer(false);
        reviewView.currentItem = initialItem;
        return initialItem;
      }

      const result = await reviewManager.getDue({
        limit: REVIEW_FETCH_COUNT,
      });
      const nextItem =
        result.all.filter(({ data }) => !reviewView.seenIds.has(data.id))[0] ??
        null;
      if (nextItem && isReviewCard(nextItem)) await updateDelimiters(nextItem);
      setShowAnswer(false);
      reviewView.currentItem = nextItem;
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
          (frontmatter: Record<string, any>) => {
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
      reviewView.seenIds.add(article.data.id);
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
      reviewView.seenIds.add(snippet.data.id);
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

  const gradeCard = async (card: ReviewCard, grade: Grade) => {
    await reviewManager.reviewCard(card.data, grade);
    reviewView.seenIds.add(card.data.id);
    new Notice(`Graded as: ${Rating[grade]}`);
    if (card.data.dismissed) {
      await unDismissItem(card);
    }
    getNext();
  };

  const dismissItem = async (item: ReviewItem) => {
    const type = reviewManager.getNoteType(item.file);
    if (!type) {
      console.error(item);
      throw new TypeError(`Item type not recognized`);
    }
    await reviewManager.dismissItem(type, item.data.id);
    reviewView.seenIds.add(item.data.id);

    const [_folder, subRef] = item.data.reference.split('/');
    new Notice(
      `Dismissed ${type} "${getContentSlice(subRef, CONTENT_TITLE_SLICE_LENGTH, true)}"`
    );
    getNext();
  };

  const unDismissItem = async (item: ReviewItem) => {
    const type = reviewManager.getNoteType(item.file);
    if (!type) {
      console.error(item);
      throw new TypeError(`Item type not recognized`);
    }
    await reviewManager.unDismissItem(type, item.data.id);

    const [_folder, subRef] = item.data.reference.split('/');
    new Notice(
      `Restored ${type} "${getContentSlice(subRef, CONTENT_TITLE_SLICE_LENGTH, true)}" to queue`
    );

    // update the local cache instead of invalidating it so it remains open in review
    queryClient.setQueryData(
      ['current-review-item'],
      (currentItem: ReviewItem) => {
        if (!currentItem) return;

        const updated = {
          file: currentItem.file,
          data: {
            ...deepCopy(currentItem.data),
            dismissed: false,
          },
        };
        return updated;
      }
    );
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

  const saveNote = async (item: ReviewItem, newContent: string) => {
    // Save document content and highlight offsets together to avoid race conditions
    const highlights = reviewManager.snippetTracker.getHighlights(
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

    setEditState(EditingState.complete);
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
      const hotkeyStr = `${modifiers ? modifiers.join(' + ') + ' + ' : ''}${key}`;
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
    currentItem,
    getNext,
    reviewArticle,
    reviewSnippet,
    gradeCard,
    dismissItem,
    unDismissItem,
    skipItem,
    showAnswer,
    setShowAnswer,
    editState,
    setEditState,
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
