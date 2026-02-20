import { useState, useRef } from 'react';
import { isReviewCard, isReviewArticle, type ReviewItem } from '#/lib/types';
import { IREditor } from './IREditor';
import { useReviewContext } from './ReviewContext';
import type { EditorView, ViewUpdate } from '@codemirror/view';
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
  const titleRef = useRef<HTMLDivElement | null>(null);

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
          className="ir-editor"
          onEnter={(cm: EditorView, mod: boolean, shift: boolean) => false}
          onEscape={() => {}}
          item={item}
          titleRef={isReviewArticle(item) ? titleRef : undefined}
        />
      )}
    </>
  );
}
