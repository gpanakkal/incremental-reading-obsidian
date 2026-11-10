import { openModal, type UiOrigin } from '#/lib/ui-window';
import { type App, ButtonComponent, Modal, Platform } from 'obsidian';

export interface ConfirmOptions {
  title: string;
  /**
   * The question and anything the user should know first, one per paragraph;
   * one given as several lines is shown as a list of them.
   */
  paragraphs: readonly (string | readonly string[])[];
  /** The text of the button that goes ahead, such as "Delete". */
  confirmText: string;
  /** Style the confirm button as Obsidian styles one that deletes. */
  destructive?: boolean;
  /**
   * A second way to go ahead, on a button between Cancel and the confirm
   * button: see {@link promptForChoice}.
   */
  alternative?: {
    text: string;
    /** Style it as Obsidian styles a button that deletes but isn't the default. */
    destructive?: boolean;
  };
}

/**
 * The class on each of the modal's buttons, which gives them the pointer
 * (styles.css): Obsidian's take `--cursor`, the arrow unless the user changes it.
 */
const BUTTON_CLASS = 'ir-confirm-button';

/** What was chosen in a {@link promptForChoice}. */
export type ConfirmChoice = 'confirm' | 'alternative' | 'cancel';

/**
 * Ask the user to confirm an action.
 * @param origin what it was asked for from (see `uiWindow`)
 * @returns whether they confirmed; closing the modal any way but the confirm
 * button answers no
 */
export function promptForConfirmation(
  app: App,
  // An alternative answers only through `promptForChoice`
  options: Omit<ConfirmOptions, 'alternative'>,
  origin?: UiOrigin
): Promise<boolean> {
  return new Promise((resolve) => {
    openModal(new ConfirmModal(app, options, resolve), origin);
  });
}

/**
 * Ask the user to choose between two ways to go ahead, or neither: the
 * confirm button, the default, or the alternative beside it.
 * @param origin what it was asked for from (see `uiWindow`)
 * @returns what they chose; closing the modal any way but those buttons
 * answers `cancel`
 */
export function promptForChoice(
  app: App,
  options: ConfirmOptions & {
    alternative: NonNullable<ConfirmOptions['alternative']>;
  },
  origin?: UiOrigin
): Promise<ConfirmChoice> {
  return new Promise((resolve) => {
    openModal(
      new ConfirmModal(
        app,
        options,
        (confirmed) => resolve(confirmed ? 'confirm' : 'cancel'),
        () => resolve('alternative')
      ),
      origin
    );
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
  readonly #onAlternative: (() => void) | undefined;
  #buttonsEl: HTMLElement | null = null;
  #confirmEl: HTMLButtonElement | null = null;

  constructor(
    app: App,
    options: ConfirmOptions,
    onAnswer: (confirmed: boolean) => void,
    /** Told instead of `onAnswer` when the alternative is pressed. */
    onAlternative?: () => void
  ) {
    super(app);
    this.#options = options;
    this.#onAnswer = onAnswer;
    this.#onAlternative = onAlternative;
  }

  onOpen() {
    const { title, paragraphs, confirmText, destructive, alternative } =
      this.#options;
    this.containerEl.classList.add('mod-confirmation');
    this.setTitle(title);
    for (const paragraph of paragraphs) {
      if (typeof paragraph === 'string') {
        createEl('p', {
          cls: 'u-break-word',
          text: paragraph,
          parent: this.contentEl,
        });
        continue;
      }
      const list = createEl('ul', { parent: this.contentEl });
      for (const text of paragraph) createEl('li', { text, parent: list });
    }

    const buttons = createDiv({
      cls: 'modal-button-container',
      parent: this.modalEl,
    });
    this.#buttonsEl = buttons;
    new ButtonComponent(buttons)
      .setButtonText('Cancel')
      .setClass('mod-cancel')
      .setClass(BUTTON_CLASS)
      .onClick(() => this.close());
    if (alternative) {
      const other = new ButtonComponent(buttons)
        .setButtonText(alternative.text)
        .setClass(BUTTON_CLASS)
        .onClick(() => {
          // Answered here, so closing answers nothing more
          this.#onAnswer = null;
          this.#onAlternative?.();
          this.close();
        });
      if (alternative.destructive) other.setDestructive();
    }
    const confirm = new ButtonComponent(buttons)
      .setButtonText(confirmText)
      .setClass(BUTTON_CLASS)
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
