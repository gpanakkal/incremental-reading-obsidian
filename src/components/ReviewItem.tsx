import { useState, useRef } from 'react';
import { isReviewCard, isReviewArticle, type ReviewItem } from '#/lib/types';
import { IREditor } from './IREditor';
import { useReviewContext } from './ReviewContext';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import type { EditState } from './types';
import { EditingState } from './types';
import { CardViewer } from './CardViewer';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { TitleEditor } from './TitleEditor';

/**
 * TODO:
 * - indicate if the item is a snippet, card, or article
 * - loading spinner and error element
 */
export default function ReviewItem({ item }: { item: ReviewItem }) {
  // console.log(
  //   `[ReviewItem] Rendering item: ${item.data.reference} (id: ${item.data.id})`
  // );
  const { plugin, showAnswer, reviewManager } = useReviewContext();
  const queryClient = useQueryClient();
  const {
    isPending,
    isError,
    data: fileText,
  } = useQuery({
    queryKey: [item.data.reference],
    queryFn: async () => await plugin.app.vault.read(item.file),
  });
  const [editState, setEditState] = useState<EditState>(EditingState.cancel);
  const titleRef = useRef<HTMLDivElement | null>(null);

  const saveNote = async (newContent: string) => {
    // Save document content and highlight offsets together to avoid race conditions
    const highlights = reviewManager.snippetTracker.getHighlights(item.file.path);

    // Wrap in withReviewViewSave to prevent external modification detection
    await plugin.withReviewViewSave(async () => {
      // Save document content
      await plugin.app.vault.process(item.file, () => newContent);

      // Save highlight offsets (they're already body-relative in the tracker)
      for (const h of highlights) {
        await reviewManager.updateSnippetOffsets(h.id, h.start_offset, h.end_offset);
      }
    });

    // Invalidate the file content cache so reopening shows fresh content
    queryClient.setQueryData([item.data.reference], newContent);

    setEditState(EditingState.complete);
  };

  const handleChange = async (update: ViewUpdate) => {
    if (!update.docChanged) {
      return;
    }

    const docText = update.state.doc.toString();
    await saveNote(docText);
  };

  if (!fileText) return <></>;
  return (
    <>
      {isReviewArticle(item) && (
        <div>
          <TitleEditor
            item={item}
            reviewManager={reviewManager}
            ref={titleRef}
          />
        </div>
      )}
      {isReviewCard(item) && !showAnswer ? (
        <CardViewer cardText={fileText} key={item.data.id} />
      ) : (
        <IREditor
          key={item.data.id}
          value={fileText}
          onChange={(update) => handleChange(update)}
          editState={editState}
          className="ir-editor"
          onEnter={(cm: EditorView, mod: boolean, shift: boolean) => false}
          onEscape={() => {}}
          onSubmit={() => {}}
          item={item}
          titleRef={isReviewArticle(item) ? titleRef : undefined}
        />
      )}
    </>
  );
}
