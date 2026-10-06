import { useAppSelector } from '#/hooks/useAppSelector';
import type { ReviewArticle } from '#/lib/types';
import { useLayoutEffect, useRef } from 'react';
import { useReviewContext } from './ReviewContext';

/** For editing article titles in review */
export function TitleEditor({ item }: { item: ReviewArticle }) {
  const titleRef = useRef<HTMLDivElement>(null);
  const { reviewManager } = useReviewContext();
  // Selection mode turns editing off for the title as for the body below it.
  const selecting = useAppSelector((state) => state.selectionMode !== null);
  // The item on screen now: review may move on while a rename is pending
  const shownRef = useRef(item);
  shownRef.current = item;

  useLayoutEffect(() => {
    if (!titleRef.current) return;
    titleRef.current.textContent = item.file.basename;
  }, [item.file.basename]);

  const handleBlur = async () => {
    if (!titleRef.current) return;

    const newTitle = titleRef.current.textContent?.trim() || '';
    if (!newTitle || newTitle === item.file.basename) {
      // Revert to previous title if empty or unchanged
      titleRef.current.textContent = item.file.basename;
      return;
    }
    /**
     * Put the note's name back, unless the title has gone, or shows another
     * item since the rename began.
     */
    const revert = () => {
      if (titleRef.current && shownRef.current === item) {
        titleRef.current.textContent = item.file.basename;
      }
    };
    try {
      const renamed = await reviewManager.renameArticle(item, newTitle);
      // Refused or undone: the note keeps its name, so the title must too
      if (!renamed) revert();
    } catch (error) {
      console.error('Failed to rename file:', error);
      revert();
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!titleRef.current) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      titleRef.current.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Revert to original title
      titleRef.current.textContent = item.file.basename;
      titleRef.current.blur();
    }
  };

  return (
    <div
      ref={titleRef}
      className="ir-title inline-title"
      contentEditable={!selecting}
      onBlur={() => void handleBlur()}
      onKeyDown={handleKeyDown}
    >
      {item.file.basename}
    </div>
  );
}
