import { isReviewCard, type ReviewItem } from '#/lib/types';
import { IREditor } from './IREditor';
import { useReviewContext } from './ReviewContext';
import type { EditorView } from '@codemirror/view';
import { CardViewer } from './CardViewer';
import { useQuery } from '@tanstack/react-query';

/**
 * TODO:
 * - indicate if the item is a snippet, card, or article
 * - loading spinner and error element
 */
export default function ReviewItem({ item }: { item: ReviewItem }) {
  const { plugin } = useReviewContext();

  const {
    isPending,
    isError,
    data: fileText,
  } = useQuery({
    queryKey: [item.data.reference],
    queryFn: async () => await plugin.app.vault.read(item.file),
  });

  if (!fileText) return <></>;
  return (
    <>
      {isReviewCard(item) && !item.data.showAnswer ? (
        <CardViewer cardText={fileText} key={item.data.id} />
      ) : (
        <IREditor
          key={item.data.id}
          value={fileText}
          className="ir-editor"
          onEnter={(cm: EditorView, mod: boolean, shift: boolean) => false}
          onEscape={() => {}}
          item={item}
        />
      )}
    </>
  );
}
