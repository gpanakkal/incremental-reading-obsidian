import type { App, MarkdownView } from 'obsidian';
import { Modal } from 'obsidian';
import { render } from 'preact';
import { PriorityModalContent } from '../components/PriorityModalContent';
import type ReviewManager from '#/lib/ReviewManager';

export class PriorityModal extends Modal {
  reviewManager: ReviewManager;
  view: MarkdownView;

  constructor(app: App, reviewManager: ReviewManager, view: MarkdownView) {
    super(app);
    this.reviewManager = reviewManager;
    this.view = view;
  }

  onOpen() {
    const { contentEl } = this;
    render(
      <PriorityModalContent
        reviewManager={this.reviewManager}
        view={this.view}
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
