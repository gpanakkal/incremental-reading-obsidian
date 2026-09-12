import { useAppSelector } from '#/hooks/useAppSelector';
import { useCurrentItemFileText } from '#/hooks/useReactQuery';
import { isReviewCard } from '#/lib/types';
import type { EditorView } from '@codemirror/view';
import { CardViewer } from './CardViewer';
import { IREditor } from './IREditor';
import { LoadingSpinner } from './LoadingSpinner';

/**
 * TODO:
 * - indicate if the item is a snippet, card, or article
 * - error element
 */
export default function ReviewItem() {
  const showAnswer = useAppSelector((state) => state.showAnswer);

  const { item, text: fileText, isLoading } = useCurrentItemFileText();

  // Loading comes first, and is its own screen rather than a missing item: the
  // item and its file text settle as two separate queries, and moving between
  // items reads the next file while the previous item is still cached, so there
  // is always a window where there is no text to show yet. Falling through to
  // the placeholder in that window told the user their queue was empty every
  // time it was merely unread — including on the first open of the tab.
  if (isLoading) return <LoadingSpinner label="Loading review item" />;

  if (!item || !fileText)
    return <div className="ir-review-placeholder">Nothing due for review.</div>;
  return (
    <>
      {isReviewCard(item) && !showAnswer ? (
        <CardViewer
          cardText={fileText}
          cardFilePath={item.file.path}
          key={item.data.id}
        />
      ) : (
        <IREditor
          key={item.data.id}
          value={fileText}
          className="ir-editor"
          onEnter={(_cm: EditorView, _mod: boolean, _shift: boolean) => false}
          onEscape={() => {}}
          item={item}
        />
      )}
    </>
  );
}
