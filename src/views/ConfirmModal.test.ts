// @vitest-environment jsdom
import { Modal, Platform } from '#/test/__mocks__/obsidian';
import fc from 'fast-check';
import type { App } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConfirmModal,
  type ConfirmOptions,
  promptForConfirmation,
} from './ConfirmModal';

// #region HELPERS

const APP = {} as App;

/**
 * Open and close as Obsidian's do: opening puts the modal in the document,
 * nested as Obsidian nests it, runs `onOpen`, and then, with a keyboard,
 * focuses the first thing in the modal that takes focus (read from
 * obsidian.asar); closing takes it out and runs `onClose`, however it closes.
 * The stub's own are no-ops.
 */
function wireModalLifecycle() {
  vi.spyOn(Modal.prototype, 'open').mockImplementation(function (this: Modal) {
    this.modalEl.appendChild(this.contentEl);
    this.containerEl.appendChild(this.modalEl);
    document.body.appendChild(this.containerEl);
    (this as unknown as ConfirmModal).onOpen();
    this.modalEl.querySelector('button')?.focus({ preventScroll: true });
  });
  vi.spyOn(Modal.prototype, 'close').mockImplementation(function (this: Modal) {
    this.containerEl.remove();
    (this as unknown as ConfirmModal).onClose();
  });
}

/** The open modal's parts, read off the document. */
function shown() {
  const container = document.body.lastElementChild as HTMLElement | null;
  const buttons = [
    ...(container?.querySelectorAll<HTMLButtonElement>(
      '.modal-button-container > button'
    ) ?? []),
  ];
  return { container, buttons };
}

const optionsArb: fc.Arbitrary<ConfirmOptions> = fc.record(
  {
    title: fc.string(),
    paragraphs: fc.array(fc.string(), { maxLength: 3 }),
    confirmText: fc.string(),
    destructive: fc.boolean(),
  },
  { requiredKeys: ['title', 'paragraphs', 'confirmText'] }
);

// #endregion

describe('ConfirmModal', () => {
  beforeEach(() => {
    wireModalLifecycle();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    Platform.isMobile = false;
    vi.restoreAllMocks();
  });

  it('shows the title, each paragraph, and Cancel ahead of the confirm button, as Obsidian’s confirmations do', () => {
    fc.assert(
      fc.property(optionsArb, (options) => {
        const modal = new ConfirmModal(APP, options, () => {});
        modal.open();

        const { container, buttons } = shown();
        expect(container?.classList.contains('mod-confirmation')).toBe(true);
        expect(modal.titleEl.textContent).toBe(options.title);
        expect(
          [...modal.contentEl.querySelectorAll('p')].map((p) => [
            p.textContent,
            p.className,
          ])
        ).toStrictEqual(
          options.paragraphs.map((text) => [text, 'u-break-word'])
        );
        expect(
          buttons.map((button) => [button.textContent, button.className])
        ).toStrictEqual([
          ['Cancel', 'mod-cancel'],
          [
            options.confirmText,
            options.destructive ? 'mod-destructive mod-cta' : 'mod-cta',
          ],
        ]);
        modal.close();
      })
    );
  });

  it.each([
    ['confirm button', true, (buttons: HTMLButtonElement[]) => buttons[1]],
    ['Cancel', false, (buttons: HTMLButtonElement[]) => buttons[0]],
  ] as const)(
    'answers once, when the %s is pressed, and closes',
    (_name, answer, pick) => {
      const onAnswer = vi.fn();
      const modal = new ConfirmModal(
        APP,
        { title: 't', paragraphs: [], confirmText: 'Delete' },
        onAnswer
      );
      modal.open();

      pick(shown().buttons).click();

      expect(onAnswer.mock.calls).toStrictEqual([[answer]]);
      expect(modal.containerEl.isConnected).toBe(false);
      expect(modal.contentEl.childElementCount).toBe(0);
      expect(modal.modalEl.querySelector('.modal-button-container')).toBeNull();
    }
  );

  it('answers no when closed any other way, Escape or the close button', () => {
    const onAnswer = vi.fn();
    const modal = new ConfirmModal(
      APP,
      { title: 't', paragraphs: [], confirmText: 'Delete' },
      onAnswer
    );
    modal.open();

    modal.close();

    expect(onAnswer.mock.calls).toStrictEqual([[false]]);
  });

  it.each([
    [false, true],
    [true, false],
  ])(
    'focuses the confirm button for the keyboard (mobile: %s → %s)',
    (isMobile, focused) => {
      Platform.isMobile = isMobile;
      const focus = vi.spyOn(HTMLElement.prototype, 'focus');
      new ConfirmModal(
        APP,
        { title: 't', paragraphs: [], confirmText: 'Delete' },
        () => {}
      ).open();

      const confirm = shown().buttons[1];
      expect(document.activeElement === confirm).toBe(focused);
      // Without scrolling the page under the modal, as Obsidian focuses
      expect(
        focus.mock.contexts
          .map((el, i) => [el, focus.mock.calls[i][0]])
          .filter(([el]) => el === confirm)
      ).toStrictEqual(focused ? [[confirm, { preventScroll: true }]] : []);
    }
  );
});

describe('promptForConfirmation', () => {
  beforeEach(() => {
    wireModalLifecycle();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it.each([
    [true, 1],
    [false, 0],
  ] as const)(
    'resolves to %s for the button pressed',
    async (answer, index) => {
      const answered = promptForConfirmation(APP, {
        title: 'Delete?',
        paragraphs: ['Gone for good.'],
        confirmText: 'Delete',
      });
      expect(shown().buttons).toHaveLength(2);

      shown().buttons[index].click();

      await expect(answered).resolves.toBe(answer);
    }
  );
});
