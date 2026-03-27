import type { Actions } from '#/lib/Actions';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import type ReviewManager from '#/lib/ReviewManager';
import { setReviewViewSaving } from '#/lib/store';
import type { ReviewItem } from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import type ReviewView from '#/views/ReviewView';
import type { PropsWithChildren } from 'react';
import { createContext, useContext } from 'react';
import { useDispatch } from 'react-redux';

interface ReviewContextProps {
  plugin: IncrementalReadingPlugin;
  reviewView: ReviewView;
  reviewManager: ReviewManager;
  actions: Actions;
  saveNote: (item: ReviewItem, newContent: string) => Promise<void>;
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
  reviewManager: ReviewManager;
}>) {
  const dispatch = useDispatch();
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
  };

  const value = {
    plugin,
    reviewView,
    reviewManager,
    actions: plugin.actions,
    saveNote,
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
