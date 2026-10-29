import { type App, ButtonComponent, Modal, Platform } from 'obsidian';

export interface ConfirmOptions {
  title: string;
  /** The question and anything the user should know first, one per paragraph. */
  paragraphs: readonly string[];
  /** The text of the button that goes ahead, such as "Delete". */
  confirmText: string;
  /** Style the confirm button as Obsidian styles one that deletes. */
  destructive?: boolean;
}

/**
 * Ask the user to confirm an action.
 * @returns whether they confirmed; closing the modal any way but the confirm
 * button answers no
 */
export function promptForConfirmation(
  app: App,
  options: ConfirmOptions
): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmModal(app, options, resolve).open();
  });
}

/**
 * A yes-or-no question, laid out as Obsidian lays out its own (its "Delete
 * file" prompt, say): a `.mod-confirmation` modal with the buttons in a
 * `.modal-button-container` under the content, Cancel first. Obsidian keeps
 * its confirmation modal to itself, so this rebuilds it from what its class
 * was read to do in obsidian.asar (undocumented).
 */
export class ConfirmModal extends Modal {
  readonly #options: ConfirmOptions;
  #onAnswer: ((confirmed: boolean) => void) | null;
  #buttonsEl: HTMLElement | null = null;
  #confirmEl: HTMLButtonElement | null = null;

  constructor(
    app: App,
    options: ConfirmOptions,
    onAnswer: (confirmed: boolean) => void
  ) {
    super(app);
    this.#options = options;
    this.#onAnswer = onAnswer;
  }

  onOpen() {
    const { title, paragraphs, confirmText, destructive } = this.#options;
    this.containerEl.classList.add('mod-confirmation');
    this.setTitle(title);
    for (const text of paragraphs) {
      createEl('p', { cls: 'u-break-word', text, parent: this.contentEl });
    }

    const buttons = createDiv({
      cls: 'modal-button-container',
      parent: this.modalEl,
    });
    this.#buttonsEl = buttons;
    new ButtonComponent(buttons)
      .setButtonText('Cancel')
      .setClass('mod-cancel')
      .onClick(() => this.close());
    const confirm = new ButtonComponent(buttons)
      .setButtonText(confirmText)
      .onClick(() => {
        this.#answer(true);
        this.close();
      });
    if (destructive) confirm.setDestructive().setCta();
    else confirm.setCta();
    this.#confirmEl = confirm.buttonEl;
  }

  /**
   * Focus the confirm button, as Obsidian's confirmation does, so Enter
   * confirms. After `super.open`, which runs `onOpen` and then focuses the
   * first button in the modal, Cancel (undocumented, read from
   * obsidian.asar). Obsidian focuses it only with a physical keyboard, by an
   * internal check; not being on mobile is the nearest public one.
   */
  open() {
    super.open();
    if (!Platform.isMobile) this.#confirmEl?.focus({ preventScroll: true });
  }

  onClose() {
    this.contentEl.replaceChildren();
    this.#buttonsEl?.remove();
    this.#buttonsEl = null;
    this.#confirmEl = null;
    this.#answer(false);
  }

  /** Answer once; whatever comes after is too late. */
  #answer(confirmed: boolean) {
    this.#onAnswer?.(confirmed);
    this.#onAnswer = null;
  }
}
