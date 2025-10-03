import { useState } from 'react';
import { isReviewCard type ReviewItem } from '#/db/types';
import { IREditor } from './IREditor';
import { useReviewContext } from './ReviewContext';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import type { EditState } from './types';
import { EditingState } from './types';
import { CardViewer } from './CardViewer';
import { useQuery } from '@tanstack/react-query';

/**
 * TODO:
 * - indicate if the item is a snippet, card, or article
 * - loading spinner and error element
 */
export default function ReviewItem({ item }: { item: ReviewItem }) {
  console.log('rendering review item');
  console.log(item.data);
  const { plugin, showAnswer } = useReviewContext();
  const {
    isPending,
    isError,
    data: fileText,
  } = useQuery({
    queryKey: [`${item.data.reference}`],
    queryFn: async () => await plugin.app.vault.read(item.file),
  });
  const [editState, setEditState] = useState<EditState>(EditingState.cancel);

  const saveNote = async (newContent: string) => {
    await plugin.app.vault.process(item.file, (data) => {
      return newContent;
    });
    setEditState(EditingState.complete);
  };

  const handleChange = async (update: ViewUpdate) => {
    if (!update.docChanged) {
      return;
    }

    const docText = update.state.doc.toString();
    saveNote(docText);
  };

  if (!fileText) return <></>;
  return (
    <>
      {isReviewCard(item) && !showAnswer ? (
        <CardViewer cardText={fileText} />
      ) : (
        <IREditor
          value={fileText}
          onChange={(update) => handleChange(update)}
          editState={editState}
          className="ir-editor"
          onEnter={(cm: EditorView, mod: boolean, shift: boolean) => false}
          onEscape={() => {}}
          onSubmit={() => {}}
          item={item}
        />
      )}
    </>
  );
}
