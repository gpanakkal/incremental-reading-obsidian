import { useRef, useEffect } from 'preact/compat';
import type { ReviewArticle } from '#/lib/types';
import { useReviewContext } from './ReviewContext';

/** For editing article titles in review */
export function TitleEditor({ item }: { item: ReviewArticle }) {
  const titleRef = useRef<HTMLDivElement>(null);
  const { reviewManager } = useReviewContext();

  // TODO: replace with a listener to handle external rename events
  useEffect(() => {
    if (!titleRef.current) return;
    titleRef.current.textContent = item.file.basename;
  }, [item.file.basename]);

  const handleBlur = async () => {
    if (!titleRef.current) return;

    const newTitle = titleRef.current.textContent?.trim() || '';
    if (!newTitle || newTitle === item.file.basename) {
      // Revert to previous title if empty or unchanged
      if (titleRef.current) {
        titleRef.current.textContent = item.file.basename;
      }
      return;
    }
    try {
      await reviewManager.renameArticle(item, newTitle);
    } catch (error) {
      console.error('Failed to rename file:', error);
      // Revert on error
      if (titleRef.current) {
        titleRef.current.textContent = item.file.basename;
      }
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      titleRef.current?.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Revert to original title
      if (titleRef.current) {
        titleRef.current.textContent = item.file.basename;
      }
      titleRef.current?.blur();
    }
  };

  return (
    <div
      ref={titleRef}
      className="ir-title inline-title"
      contentEditable
      onBlur={() => void handleBlur()}
      onKeyDown={handleKeyDown}
    >
      {item.file.basename}
    </div>
  );
}
