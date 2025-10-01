import { useState, useEffect } from 'react';
import type { ReviewItem } from '#/db/types';
import type IncrementalReadingPlugin from '#/main';
import type { WorkspaceLeaf } from 'obsidian';
import { TextFileView } from 'obsidian';
import { IREditor } from './IREditor';
import { useReviewContext } from './ReviewContext';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import { searchAll } from '#/lib/utils';
import { clozeDelimiterPattern, CLOZE_DELIMITERS } from '#/lib/constants';

// TODO: either use this or the component below
class ReviewItemView extends TextFileView {
  plugin: IncrementalReadingPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: IncrementalReadingPlugin) {
    super(leaf);
    this.plugin = plugin;
  }
}

const hideAnswer = (cardContent: string) => {
  const match = searchAll(cardContent, clozeDelimiterPattern)[0];
  if (!match) {
    throw new Error(`Valid cloze delimiters not found in ${cardContent}`);
  }
  const pre = cardContent.slice(0, match.index);
  const answer = `${CLOZE_DELIMITERS[0]}__${CLOZE_DELIMITERS[1]}`;
  const post = cardContent.slice(match.index + match.match.length);
  const formattedContent = pre + answer + post;
  return formattedContent;
};

/**
 * TODO:
 * - indicate if the item is a snippet, card, or article
 * - If card, hide answer
 */
export default function ReviewItem({ item }: { item: ReviewItem }) {
  console.log('re-rendering ReviewItem');
  const { plugin } = useReviewContext();
  const [fileText, setFileText] = useState<string>();
  console.log(item);
  console.log(fileText);

  useEffect(() => {
    const readNote = async () => {
      const fileText = await plugin.app.vault.read(item.file);
      setFileText(fileText);
    };

    readNote();
  }, [item]);

  const saveNote = async (update: ViewUpdate) => {
    // TODO
    if (!update.docChanged) {
      return;
    }

    const docText = update.state.doc.toString();
    await plugin.app.vault.process(item.file, (data) => {
      return docText;
    });
    setFileText(docText);
  };
  return (
    <>
      {fileText && (
        <IREditor
          value={fileText}
          onChange={(update) => saveNote(update)}
          className="ir-editor"
          onEnter={(cm: EditorView, mod: boolean, shift: boolean) => false}
          onEscape={() => {}}
          onSubmit={() => {}}
        ></IREditor>
      )}
    </>
  );
}
