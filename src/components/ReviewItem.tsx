import { useAppSelector } from '#/hooks/useAppSelector';
import { useCurrentItemFileText } from '#/hooks/useReactQuery';
import { isReviewCard, type ReviewItem } from '#/lib/types';
import type { EditorView } from '@codemirror/view';
import { CardViewer } from './CardViewer';
import { IREditor } from './IREditor';

/**
 * TODO:
 * - indicate if the item is a snippet, card, or article
 * - loading spinner?
 * - error element
 */
export default function ReviewItem({ item }: { item: ReviewItem }) {
  const showAnswer = useAppSelector((state) => state.showAnswer);

  const { data: fileText } = useCurrentItemFileText();

  if (!fileText) return <></>;
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
