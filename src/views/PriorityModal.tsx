import { Modal } from 'obsidian';
import { render } from 'preact';
import { PriorityModalContent } from '../components/PriorityModalContent';
import type { TFile } from 'obsidian';
import type IncrementalReadingPlugin from '#/main';

export class PriorityModal extends Modal {
  plugin: IncrementalReadingPlugin;
  file: TFile;

  constructor(plugin: IncrementalReadingPlugin, file: TFile) {
    super(plugin.app);
    this.plugin = plugin;
    this.file = file;
  }

  onOpen() {
    const { contentEl } = this;
    render(
      <PriorityModalContent
        plugin={this.plugin}
        file={this.file}
        onClose={() => this.close()}
      />,
      contentEl
    );
  }

  onClose() {
    const { contentEl } = this;
    render(null, contentEl);
  }
}
