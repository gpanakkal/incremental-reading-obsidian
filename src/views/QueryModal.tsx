/* eslint-disable no-console */
import { Modal } from 'obsidian';
import type ReviewManager from '#/lib/ReviewManager';
import type { App } from 'obsidian';

export class QueryModal extends Modal {
  reviewManager: ReviewManager;

  constructor(app: App, reviewManager: ReviewManager) {
    super(app);
    this.reviewManager = reviewManager;
  }

  onOpen() {
    const { contentEl } = this;

    // Set modal title
    contentEl.createEl('h2', { text: 'SQL query console' });

    // Create textarea for SQL input
    const textarea = contentEl.createEl('textarea', {
      attr: {
        placeholder: 'Enter SQL query...',
        rows: '10',
        style: 'width: 100%; font-family: monospace; padding: 8px;',
      },
    });

    // Create button container
    const buttonContainer = contentEl.createEl('div', {
      attr: {
        style: 'margin-top: 10px; display: flex; gap: 8px;',
      },
    });

    // Create execute button
    const executeBtn = buttonContainer.createEl('button', {
      text: 'Execute query',
    });
    executeBtn.addEventListener('click', () => {
      const query = textarea.value.trim();
      if (!query) {
        console.info('No query entered');
        return;
      }

      try {
        console.info('Executing query:', query);
        void this.reviewManager.repo.query(query).then((result) => {
          console.info('Query result:');
          console.table(result);
        });
      } catch (error) {
        console.error('Query error:', error);
      }
    });

    // Create close button
    const closeBtn = buttonContainer.createEl('button', { text: 'Close' });
    closeBtn.addEventListener('click', () => {
      this.close();
    });

    // Focus the textarea
    textarea.focus();

    // Add Enter+Ctrl shortcut to execute
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        executeBtn.click();
      }
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
