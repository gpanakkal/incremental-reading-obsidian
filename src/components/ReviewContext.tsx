import type { Actions } from '#/lib/Actions';
import { withCompensation } from '#/lib/compensation';
import type ReviewManager from '#/lib/items/ReviewManager';
import { isEditableText } from '#/lib/mime';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { queryClient } from '#/lib/query-client';
import { setReviewViewSaving } from '#/lib/store';
import type { ReviewItem } from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import type ReviewView from '#/views/ReviewView';
import { type PropsWithChildren, createContext, useContext } from 'react';
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
    // The editor never mounts on a PDF, and `editNote` won't write to one, but
    // the cache entry and highlight offsets below are no business of it either
    if (!isEditableText(item.file)) return;
    // Save document content and highlight offsets together to avoid race conditions
    const highlights = reviewManager.snippets.offsetTracker.getHighlights(
      item.file.path
    );
    const { snippets, repo } = reviewManager;

    // As one (see `withCompensation`): the offsets first, all in one database
    // write, then the note, which puts the offsets back as they were when it
    // can't be saved. The note is saved whatever becomes of its offsets: what
    // the user typed comes first. Offsets that can't be written — while
    // saving is paused, say — stay in the tracker, held back to be written
    // once saving resumes (see `SnippetManager.offsetsPending`).
    await withCompensation(async (step) => {
      if (repo.writeRefusal()) {
        snippets.offsetsPending(item.file.path);
      } else {
        await step(
          async () => {
            let before: Awaited<ReturnType<typeof snippets.offsetsOf>> = [];
            try {
              before = await snippets.offsetsOf(highlights.map(({ id }) => id));
              await reviewManager.updateManySnippetOffsets(highlights);
            } catch (error) {
              console.error(error);
              snippets.offsetsPending(item.file.path);
              return before;
            }
            // Saving works: write any held back by a failure that was no
            // refusal, which no resume would come to write
            await snippets.persistPendingOffsets();
            return before;
          },
          (before) => reviewManager.updateManySnippetOffsets(before)
        );
      }
      await withReviewViewSave(async () => {
        await Obsidian.editNote(reviewView.app, item.file, () => newContent);
        queryClient.setQueryData(
          ['item', item.data.id, 'file-text'],
          newContent
        );
      });
    });
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
