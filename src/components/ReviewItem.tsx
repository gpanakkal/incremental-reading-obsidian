import { useState, useEffect } from 'react';
import type { ReviewItem } from '#/db/types';
import type IncrementalReadingPlugin from '#/main';
import type { WorkspaceLeaf } from 'obsidian';
import { TextFileView } from 'obsidian';
import { IREditor } from './IREditor';
import { UseReviewContext } from './ReviewContext';
import type { ViewUpdate } from '@codemirror/view';

// TODO: either use this or the component below
class ReviewItemView extends TextFileView {
  plugin: IncrementalReadingPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: IncrementalReadingPlugin) {
    super(leaf);
    this.plugin = plugin;
  }
}

export default function ReviewItem({ item }: { item: ReviewItem }) {
  const { plugin } = UseReviewContext();
  const [fileText, setFileText] = useState<string>();

  useEffect(() => {
    const readNote = async () => {
      const fileText = await plugin.app.vault.read(item.file);
      setFileText(fileText);
    };

    readNote();
  }, []);

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
        ></IREditor>
      )}
    </>
  );
}
