import { Notice } from 'obsidian';
import { createContext, useContext } from 'react';
import { useDispatch } from 'react-redux';
import { Rating } from 'ts-fsrs';
import { useAppStore } from '#/hooks/useAppSelector';
import {
  CONTENT_TITLE_SLICE_LENGTH,
  ERROR_NOTICE_DURATION_MS,
  MS_PER_DAY,
  SUCCESS_NOTICE_DURATION_MS,
} from '#/lib/constants';
import type ReviewManager from '#/lib/ReviewManager';
import {
  addSeenId,
  resetCurrentItem,
  setEditState,
  setReviewViewSaving,
} from '#/lib/store';
import type {
  ReviewArticle,
  ReviewCard,
  ReviewItem,
  ReviewSnippet,
} from '#/lib/types';
import { getContentSlice, transformPriority } from '#/lib/utils';
import type IncrementalReadingPlugin from '#/main';
import type ReviewView from '#/views/ReviewView';
import { EditingState } from './types';
import type { Scope, WorkspaceLeaf } from 'obsidian';
import type { PropsWithChildren } from 'react';
import type { Grade } from 'ts-fsrs';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { updateQueryCache } from '#/lib/query-client';

// work around "Cannot call impure function during render"
const getNow = () => Date.now();

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
  children,
}: PropsWithChildren<{
  reviewView: ReviewView;
  plugin: IncrementalReadingPlugin;
  leaf: WorkspaceLeaf;
  reviewManager: ReviewManager;
}>) {
  const dispatch = useDispatch();
  const store = useAppStore();
  /**
   * Wrap a file-modifying operation to prevent external modification detection.
   * The vault 'modify' event handler will ignore changes while this is active.
   */
  async function withReviewViewSave<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    dispatch(setReviewViewSaving(true));
    try {
      return await operation();
    } finally {
      dispatch(setReviewViewSaving(false));
    }
  }

  /** Call this after reviewing, skipping, or dismissing an item */
  const getNext = () => {
    dispatch(resetCurrentItem());
  };

  const reviewArticle = async (
    article: ReviewArticle,
    nextInterval?: number
  ) => {
    try {
      await reviewManager.reviewArticle(article.data, getNow(), nextInterval);
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
      await reviewManager.reviewSnippet(snippet.data, getNow(), nextInterval);
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
    } catch (_error) {
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
    updateQueryCache(item.data.id, { dismissed: true });

    const [_folder, subRef] = item.data.reference.split('/');
    new Notice(
      `Dismissed "${getContentSlice(subRef, CONTENT_TITLE_SLICE_LENGTH, true)}"`
    );
    getNext();
  };

  const unDismissItem = async (item: ReviewItem) => {
    await reviewManager.unDismissItem(item);
    updateQueryCache(item.data.id, { dismissed: false });
    const { currentItemId } = store.getState();
    // TODO: check if we're in a review session once that state is added
    if (currentItemId === null) {
      getNext();
    }

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

    await withReviewViewSave(async () => {
      await Obsidian.editNote(reviewView.app, item.file, () => newContent);
    });
    // Save body-relative highlight offsets
    for (const h of highlights) {
      await reviewManager.updateSnippetOffsets(
        h.id,
        h.start_offset,
        h.end_offset
      );
    }

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
