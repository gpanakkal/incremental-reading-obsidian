import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { type TextBounds, trackSelection } from '#/lib/text-selection';
import { type App, Modal } from 'obsidian';

/**
 * Ask which part of a card's text is its answer: the second step of making a
 * card in selection mode, once the card's text has been chosen in the note.
 *
 * @returns offsets of the answer within `text`, or `null` if the user cancelled
 */
export function promptForCardAnswer(
  app: App,
  text: string
): Promise<TextBounds | null> {
  return new Promise((resolve) => {
    new CardAnswerModal(app, text, resolve).open();
  });
}

/**
 * Shows the card's text, raw, for the answer to be selected in. Enter or the
 * confirm button accepts the selection; Escape, the cancel button, or closing
 * the modal any other way answers `null`.
 *
 * The text is one text node in an element of its own, so an offset into the
 * node's text is an offset into the card's.
 */
class CardAnswerModal extends Modal {
  readonly #text: string;
  #resolve: ((answer: TextBounds | null) => void) | null;
  /**
   * The answer as last selected. Kept from `selectionchange` rather than read
   * when confirming, since pressing the confirm button can move the selection
   * off the text first — see `trackSelection`.
   */
  #answer: TextBounds | null = null;
  #teardown: (() => void) | null = null;

  constructor(
    app: App,
    text: string,
    resolve: (answer: TextBounds | null) => void
  ) {
    super(app);
    this.#text = text;
    this.#resolve = resolve;
  }

  onOpen() {
    const { contentEl } = this;
    this.setTitle('Select the answer');
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Select the part of the card to initially hide in review.',
    });
    const textEl = contentEl.createDiv({
      cls: 'ir-card-answer-text',
      text: this.#text,
    });

    const doc = textEl.doc;
    const onSelectionChange = () => {
      this.#answer = trackSelection(this.#answer, textEl, doc.getSelection());
    };
    doc.addEventListener('selectionchange', onSelectionChange);
    this.#teardown = () =>
      doc.removeEventListener('selectionchange', onSelectionChange);

    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    buttons
      .createEl('button', { cls: 'mod-cta', text: 'Confirm' })
      .addEventListener('click', () => this.confirm());
    buttons
      .createEl('button', { text: 'Cancel' })
      .addEventListener('click', () => this.close());

    // Escape is already the modal's own: it closes, which answers `null`.
    this.scope.register([], 'Enter', (evt) => {
      evt.preventDefault();
      this.confirm();
      return false;
    });
  }

  confirm() {
    if (!this.#answer) {
      Obsidian.notify('Select the answer first');
      return;
    }
    this.#settle(this.#answer);
    this.close();
  }

  onClose() {
    this.#teardown?.();
    this.#teardown = null;
    this.contentEl.empty();
    this.#settle(null);
  }

  /** Answer the prompt once; whatever comes after is too late. */
  #settle(answer: TextBounds | null) {
    this.#resolve?.(answer);
    this.#resolve = null;
  }
}
