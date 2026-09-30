import { useAppSelector } from '#/hooks/useAppSelector';
import { useCurrentItemFileText } from '#/hooks/useReactQuery';
import { getMimeType, isEditableText } from '#/lib/mime';
import { type ReviewItem as TReviewItem, isReviewCard } from '#/lib/types';
import type { EditorView } from '@codemirror/view';
import { CardViewer } from './CardViewer';
import { IREditor } from './IREditor';
import { LoadingSpinner } from './LoadingSpinner';
import { useReviewContext } from './ReviewContext';
import { ReviewSummary } from './ReviewSummary';

/**
 * An item whose file isn't text, a PDF article, in place of the editor: the
 * review tab can't show it yet, so it offers to open it where Obsidian can.
 * The action bar still reviews it; only its content lives in the other tab.
 */
function BinaryItem({ item }: { item: TReviewItem }) {
  const { actions } = useReviewContext();
  return (
    <div className="ir-binary-item">
      <p className="ir-binary-item-name">{item.file.name}</p>
      <button
        className="mod-cta"
        onClick={() => void actions._openInNewTab(item.file, null)}
      >
        {getMimeType(item.file) === 'application/pdf'
          ? 'Open in PDF tab'
          : 'Open in new tab'}
      </button>
    </div>
  );
}

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

  // Before the summary: such an item's text is never read, and an item with
  // no text would otherwise read as an empty queue.
  if (item && !isEditableText(item.file)) return <BinaryItem item={item} />;
  if (!item || !fileText) return <ReviewSummary />;
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
