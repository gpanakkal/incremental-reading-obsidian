import type IncrementalReadingPlugin from '#/main';
import type { WorkspaceLeaf } from 'obsidian';
import { TextFileView } from 'obsidian';

// TODO: either use this or the component below
class ReviewItemView extends TextFileView {
  plugin: IncrementalReadingPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: IncrementalReadingPlugin) {
    super(leaf);
    this.plugin = plugin;
  }
}

export default function ReviewItem() {
  return <></>;
}
