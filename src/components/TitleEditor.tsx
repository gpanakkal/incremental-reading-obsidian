import { useRef, useState, forwardRef, useEffect } from 'preact/compat';
import type { ReviewArticle } from '#/lib/types';
import type ReviewManager from '#/lib/ReviewManager';

interface TitleEditorProps {
  item: ReviewArticle;
  reviewManager: ReviewManager;
}
/** For editing article titles in review */
export const TitleEditor = forwardRef<HTMLDivElement, TitleEditorProps>(
  ({ item, reviewManager }, ref) => {
    const titleRef = useRef<HTMLDivElement>(null);
    const [title, setTitle] = useState(item.file.basename);

    // TODO: replace with a listener to handle external rename events
    useEffect(() => {
      setTitle(item.file.basename);
    }, [item.file.basename]);

    const handleBlur = async () => {
      if (!titleRef.current) return;

      const newTitle = titleRef.current.textContent?.trim() || '';
      if (!newTitle || newTitle === title) {
        // Revert to previous title if empty or unchanged
        if (titleRef.current) {
          titleRef.current.textContent = title;
        }
        return;
      }
      try {
        await reviewManager.renameArticle(item, newTitle);
      } catch (error) {
        console.error('Failed to rename file:', error);
        // Revert on error
        if (titleRef.current) {
          titleRef.current.textContent = title;
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
          titleRef.current.textContent = title;
        }
        titleRef.current?.blur();
      }
    };

    return (
      <div
        ref={(el) => {
          titleRef.current = el;
          if (typeof ref === 'function') {
            ref(el);
          } else if (ref) {
            ref.current = el;
          }
        }}
        className="ir-title inline-title"
        contentEditable
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
      >
        {title}
      </div>
    );
  }
);
