import { Modal } from 'obsidian';
import { render } from 'preact';
import type ReviewManager from '#/lib/ReviewManager';
import { PriorityModalContent } from '../components/PriorityModalContent';
import type { App, TFile } from 'obsidian';

export class PriorityModal extends Modal {
  reviewManager: ReviewManager;
  file: TFile;

  constructor(app: App, reviewManager: ReviewManager, file: TFile) {
    super(app);
    this.reviewManager = reviewManager;
    this.file = file;
  }

  onOpen() {
    const { contentEl } = this;
    render(
      <PriorityModalContent
        reviewManager={this.reviewManager}
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
