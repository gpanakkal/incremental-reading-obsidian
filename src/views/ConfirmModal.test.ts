// @vitest-environment jsdom
import * as UiWindow from '#/lib/ui-window';
import { Modal, Platform } from '#/test/__mocks__/obsidian';
import { makeUiWindow } from '#/test/fake-window';
import fc from 'fast-check';
import type { App } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConfirmModal,
  type ConfirmOptions,
  promptForChoice,
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

/**
 * Options with a third button, and paragraphs that may be lists: any mix of
 * the two, as the modal takes them.
 */
const choiceOptionsArb = fc.record(
  {
    title: fc.string(),
    paragraphs: fc.array(
      fc.oneof(fc.string(), fc.array(fc.string(), { maxLength: 3 })),
      { maxLength: 4 }
    ),
    confirmText: fc.string(),
    destructive: fc.boolean(),
    alternative: fc.record(
      { text: fc.string(), destructive: fc.boolean() },
      { requiredKeys: ['text'] }
    ),
  },
  { requiredKeys: ['title', 'paragraphs', 'confirmText', 'alternative'] }
);

/** The plugin's class that gives each of the modal's buttons the pointer. */
const POINTER = 'ir-confirm-button';

/** The classes of `button` that style it as Obsidian does, all but {@link POINTER}. */
const styleOf = (button: HTMLElement) =>
  [...button.classList].filter((cls) => cls !== POINTER).join(' ');

/** What `contentEl` shows, in order: a paragraph's text, or a list's items. */
const contentOf = (contentEl: HTMLElement) =>
  [...contentEl.children].map((el) =>
    el.tagName === 'UL'
      ? [...el.children].map((item) => [item.tagName, item.textContent])
      : [el.tagName, el.textContent, el.className]
  );

/**
 * The window a prompt asked for by `ask` opens in: Obsidian's `activeWindow`
 * as the modal opens, which it appends the modal to (see `uiWindow`). Asked
 * while Settings, focused, is `activeWindow`, as in the e2e harness, where
 * every window reports focus: the state plugin modals once went to Settings
 * in.
 */
function promptWindow(ask: () => unknown): {
  opened: Window[];
  settings: Window;
} {
  const settings = makeUiWindow({ focused: true }).win;
  vi.stubGlobal('activeWindow', settings);
  vi.stubGlobal('activeDocument', settings.document);
  const opened: Window[] = [];
  vi.spyOn(Modal.prototype, 'open').mockImplementation(() => {
    opened.push(activeWindow);
  });
  ask();
  return { opened, settings };
}

const NO_ALTERNATIVE: ConfirmOptions = {
  title: 'Delete?',
  paragraphs: [],
  confirmText: 'Delete',
};

/** Each prompt, asked from `origin`. */
const PROMPTS = [
  [
    'promptForConfirmation',
    (origin?: UiWindow.UiOrigin) =>
      void promptForConfirmation(APP, NO_ALTERNATIVE, origin),
  ],
  [
    'promptForChoice',
    (origin?: UiWindow.UiOrigin) =>
      void promptForChoice(
        APP,
        { ...NO_ALTERNATIVE, alternative: { text: 'Erase' } },
        origin
      ),
  ],
] as const;

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
        expect(buttons.map(styleOf)).toStrictEqual([
          'mod-cancel',
          options.destructive ? 'mod-destructive mod-cta' : 'mod-cta',
        ]);
        expect(buttons[1].textContent).toBe(options.confirmText);
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

  it('shows a list for each paragraph given as one, in place, and the alternative between Cancel and the confirm button', () => {
    fc.assert(
      fc.property(choiceOptionsArb, (options) => {
        const modal = new ConfirmModal(
          APP,
          options,
          () => {},
          () => {}
        );
        modal.open();

        const { buttons } = shown();
        expect(contentOf(modal.contentEl)).toStrictEqual(
          options.paragraphs.map((paragraph) =>
            typeof paragraph === 'string'
              ? ['P', paragraph, 'u-break-word']
              : paragraph.map((item) => ['LI', item])
          )
        );
        expect(buttons.map(styleOf)).toStrictEqual([
          'mod-cancel',
          options.alternative.destructive ? 'mod-destructive' : '',
          options.destructive ? 'mod-destructive mod-cta' : 'mod-cta',
        ]);
        expect(buttons[1].textContent).toBe(options.alternative.text);
        expect(buttons[2].textContent).toBe(options.confirmText);
        modal.close();
      })
    );
  });

  it.each([
    ['confirm button', [[true]], 0, 2],
    ['alternative', [], 1, 1],
    ['Cancel', [[false]], 0, 0],
  ] as const)(
    'with an alternative, answers once when the %s is pressed, and closes',
    (_name, answers, alternatives, index) => {
      const onAnswer = vi.fn();
      const onAlternative = vi.fn();
      const modal = new ConfirmModal(
        APP,
        {
          title: 't',
          paragraphs: [],
          confirmText: 'Keep',
          alternative: { text: 'Erase' },
        },
        onAnswer,
        onAlternative
      );
      modal.open();

      shown().buttons[index].click();

      expect(onAnswer.mock.calls).toStrictEqual(answers);
      expect(onAlternative).toHaveBeenCalledTimes(alternatives);
      expect(modal.containerEl.isConnected).toBe(false);
      expect(modal.modalEl.querySelector('.modal-button-container')).toBeNull();
    }
  );

  it('gives every button the pointer, with an alternative or without', () => {
    fc.assert(
      fc.property(fc.oneof(optionsArb, choiceOptionsArb), (options) => {
        const modal = new ConfirmModal(
          APP,
          options,
          () => {},
          () => {}
        );
        modal.open();

        const { buttons } = shown();
        expect(buttons).toHaveLength(options.alternative ? 3 : 2);
        for (const button of buttons) {
          expect(button.classList.contains(POINTER)).toBe(true);
        }
        modal.close();
      })
    );
  });

  it('focuses the confirm button, not the alternative, for the keyboard', () => {
    new ConfirmModal(
      APP,
      {
        title: 't',
        paragraphs: [],
        confirmText: 'Keep',
        alternative: { text: 'Erase' },
      },
      () => {},
      () => {}
    ).open();

    expect(document.activeElement).toBe(shown().buttons[2]);
  });

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

describe('promptForChoice', () => {
  beforeEach(() => {
    wireModalLifecycle();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it.each([
    ['confirm', 2],
    ['alternative', 1],
    ['cancel', 0],
  ] as const)(
    'resolves to %s for the button pressed',
    async (answer, index) => {
      const answered = promptForChoice(APP, {
        title: 'Keep?',
        paragraphs: ['Or erase.'],
        confirmText: 'Keep',
        alternative: { text: 'Erase', destructive: true },
      });
      expect(shown().buttons).toHaveLength(3);

      shown().buttons[index].click();

      await expect(answered).resolves.toBe(answer);
    }
  );

  it('opens in the window the plugin answers from, not over a settings window behind it', () => {
    const openModal = vi.spyOn(UiWindow, 'openModal');

    void promptForChoice(APP, {
      title: 'Keep?',
      paragraphs: [],
      confirmText: 'Keep',
      alternative: { text: 'Erase' },
    });

    expect(openModal).toHaveBeenCalledOnce();
    expect(openModal.mock.calls[0][0]).toBeInstanceOf(ConfirmModal);
    expect(shown().buttons).toHaveLength(3);
  });

  it('resolves to cancel when closed any other way', async () => {
    const onOpen = vi.spyOn(ConfirmModal.prototype, 'onOpen');
    const answered = promptForChoice(APP, {
      title: 'Keep?',
      paragraphs: [],
      confirmText: 'Keep',
      alternative: { text: 'Erase' },
    });

    // As Escape or the close button closes it
    (onOpen.mock.contexts[0] as ConfirmModal).close();

    await expect(answered).resolves.toBe('cancel');
  });
});

describe.each(PROMPTS)('%s asked for from a window', (_, ask) => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens once, in the window it was asked for from, over a focused window behind it', () => {
    const popout = makeUiWindow();

    const { opened } = promptWindow(() => ask(popout.element));

    expect(opened).toEqual([popout.win]);
  });

  it('opens once where plugin UI otherwise goes when asked for from nowhere', () => {
    const { opened, settings } = promptWindow(() => ask());

    expect(opened).toEqual([settings]);
  });
});
