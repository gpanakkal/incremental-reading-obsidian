// @vitest-environment jsdom

import {
  historyCommandFor,
  historyCommandForInput,
  historyInputReachesEditor,
  historyKeyReachesEditor,
  isEditableTarget,
  type HistoryKey,
} from '#/lib/review-undo-keys';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';

// #region HELPERS

/** A key press: any key, any modifiers. */
const keyArb: fc.Arbitrary<HistoryKey> = fc.record({
  key: fc.oneof(
    fc.constantFrom('z', 'Z', 'y', 'Y', 'x', 'Enter', 'Escape'),
    fc.string({ maxLength: 3 })
  ),
  ctrlKey: fc.boolean(),
  metaKey: fc.boolean(),
  altKey: fc.boolean(),
  shiftKey: fc.boolean(),
});

/**
 * A review tab as the predicate sees it: the view's container, holding its
 * header and content, in the document.
 */
function makeTab() {
  const tab = document.body.appendChild(document.createElement('div'));
  const header = tab.appendChild(document.createElement('div'));
  const content = tab.appendChild(document.createElement('div'));
  return { tab, header, content };
}

type Tab = ReturnType<typeof makeTab>;

/**
 * Where focus can be when a key is pressed, each with whether the editor
 * should answer it there.
 */
const FOCUS_TARGETS: Record<
  string,
  { reaches: boolean; make: (tab: Tab) => EventTarget | null }
> = {
  'nothing at all': { reaches: true, make: () => null },
  'the body': { reaches: true, make: () => document.body },
  'the document element': {
    reaches: true,
    make: () => document.documentElement,
  },
  'an action bar button': {
    reaches: true,
    make: ({ content }) => {
      const bar = content.appendChild(document.createElement('div'));
      return bar.appendChild(document.createElement('button'));
    },
  },
  'an icon inside an action bar button': {
    reaches: true,
    make: ({ content }) => {
      const button = content.appendChild(document.createElement('button'));
      return button.appendChild(
        document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      );
    },
  },
  'a view header button': {
    reaches: true,
    make: ({ header }) => header.appendChild(document.createElement('button')),
  },
  'the editor in selection mode': {
    reaches: true,
    make: ({ content }) => {
      const editor = content.appendChild(document.createElement('div'));
      editor.setAttribute('contenteditable', 'false');
      return editor.appendChild(document.createElement('span'));
    },
  },
  'the priority field': {
    reaches: false,
    make: ({ content }) => content.appendChild(document.createElement('input')),
  },
  'a select': {
    reaches: false,
    make: ({ content }) =>
      content.appendChild(document.createElement('select')),
  },
  'a textarea': {
    reaches: false,
    make: ({ content }) =>
      content.appendChild(document.createElement('textarea')),
  },
  'the title field': {
    reaches: false,
    make: ({ header }) => {
      const title = header.appendChild(document.createElement('div'));
      title.setAttribute('contenteditable', 'plaintext-only');
      return title;
    },
  },
  'text in the editor': {
    reaches: false,
    make: ({ content }) => {
      const editor = content.appendChild(document.createElement('div'));
      editor.setAttribute('contenteditable', 'true');
      const line = editor.appendChild(document.createElement('div'));
      return line.appendChild(document.createElement('span'));
    },
  },
  'a widget inside the editor': {
    reaches: false,
    make: ({ content }) => {
      const editor = content.appendChild(document.createElement('div'));
      editor.setAttribute('contenteditable', 'true');
      const widget = editor.appendChild(document.createElement('div'));
      widget.setAttribute('contenteditable', 'false');
      return widget;
    },
  },
  'a button in another tab': {
    reaches: false,
    make: () => {
      const other = document.body.appendChild(document.createElement('div'));
      return other.appendChild(document.createElement('button'));
    },
  },
  'a button not in the document': {
    reaches: false,
    make: () => document.createElement('button'),
  },
  'the window': { reaches: false, make: () => window },
};

const focusTargetArb = fc.constantFrom(...Object.keys(FOCUS_TARGETS));

/**
 * The `inputType` of a `beforeinput` event: the two history ones, the editing
 * ones a native undo is not, and anything else.
 */
const inputTypeArb = fc.oneof(
  fc.constantFrom(
    'historyUndo',
    'historyRedo',
    'insertText',
    'insertReplacementText',
    'deleteContentBackward',
    'formatBold',
    ''
  ),
  fc.string()
);

// #endregion

afterEach(() => {
  document.body.replaceChildren();
});

describe('historyCommandFor', () => {
  it('reads undo and redo as CodeMirror and Electron bind them, with Cmd on macOS and Ctrl elsewhere', () => {
    fc.assert(
      fc.property(keyArb, fc.boolean(), (evt, isMac) => {
        const mod = isMac
          ? evt.metaKey && !evt.ctrlKey
          : evt.ctrlKey && !evt.metaKey;
        const key = evt.key.toLowerCase();
        let expected: string | null = null;
        if (mod && !evt.altKey) {
          if (key === 'z') expected = evt.shiftKey ? 'redo' : 'undo';
          else if (key === 'y' && !isMac && !evt.shiftKey) expected = 'redo';
        }

        expect(historyCommandFor(evt, isMac)).toBe(expected);
      })
    );
  });

  it.each([
    ['Ctrl+Z off macOS', { key: 'z', ctrlKey: true }, false, 'undo'],
    [
      'Ctrl+Shift+Z off macOS',
      { key: 'Z', ctrlKey: true, shiftKey: true },
      false,
      'redo',
    ],
    ['Ctrl+Y off macOS', { key: 'y', ctrlKey: true }, false, 'redo'],
    ['Cmd+Z on macOS', { key: 'z', metaKey: true }, true, 'undo'],
    [
      'Cmd+Shift+Z on macOS',
      { key: 'Z', metaKey: true, shiftKey: true },
      true,
      'redo',
    ],
    ['Cmd+Y on macOS', { key: 'y', metaKey: true }, true, null],
    ['Ctrl+Z on macOS', { key: 'z', ctrlKey: true }, true, null],
    ['Win+Z off macOS', { key: 'z', metaKey: true }, false, null],
    [
      'Ctrl+Shift+Y off macOS',
      { key: 'Y', ctrlKey: true, shiftKey: true },
      false,
      null,
    ],
    ['Ctrl+Alt+Z', { key: 'z', ctrlKey: true, altKey: true }, false, null],
    ['Z alone', { key: 'z' }, false, null],
    ['Z alone on macOS', { key: 'z' }, true, null],
  ] as const)('%s', (_name, partial, isMac, expected) => {
    const evt = {
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...partial,
    };

    expect(historyCommandFor(evt, isMac)).toBe(expected);
  });
});

describe('historyKeyReachesEditor', () => {
  it('sends the key to the editor from anywhere in the review tab that edits no text of its own, or from nowhere', () => {
    fc.assert(
      fc.property(focusTargetArb, (where) => {
        document.body.replaceChildren();
        const tab = makeTab();
        const { reaches, make } = FOCUS_TARGETS[where];

        expect(historyKeyReachesEditor(make(tab), tab.tab)).toBe(reaches);
      })
    );
  });
});

describe('historyCommandForInput', () => {
  it('reads a native undo and redo, and nothing else, as the editor history command', () => {
    fc.assert(
      fc.property(inputTypeArb, (inputType) => {
        const expected =
          inputType === 'historyUndo'
            ? 'undo'
            : inputType === 'historyRedo'
              ? 'redo'
              : null;

        expect(historyCommandForInput(inputType)).toBe(expected);
      })
    );
  });
});

describe('historyInputReachesEditor', () => {
  it('sends a native undo to the editor from where a key would reach it, short of nowhere', () => {
    fc.assert(
      fc.property(focusTargetArb, (where) => {
        document.body.replaceChildren();
        const tab = makeTab();
        const target = FOCUS_TARGETS[where].make(tab);
        // A `beforeinput` always has a node to land on: never nothing at all.
        const reaches = target !== null && FOCUS_TARGETS[where].reaches;

        expect(historyInputReachesEditor(target, tab.tab)).toBe(reaches);
      })
    );
  });

  it("leaves a native undo landing on another window's body alone", () => {
    const tab = makeTab();
    const other = document.implementation.createHTMLDocument('');

    expect(historyInputReachesEditor(other.body, tab.tab)).toBe(false);
    expect(historyInputReachesEditor(other.documentElement, tab.tab)).toBe(
      false
    );
  });
});

describe('isEditableTarget', () => {
  it('is true exactly where keys edit text', () => {
    fc.assert(
      fc.property(focusTargetArb, (where) => {
        document.body.replaceChildren();
        const tab = makeTab();
        const target = FOCUS_TARGETS[where].make(tab);
        const editsText =
          !FOCUS_TARGETS[where].reaches &&
          target instanceof Element &&
          tab.tab.contains(target);

        expect(isEditableTarget(target)).toBe(editsText);
      })
    );
  });
});

describe('a review tab in a popout window', () => {
  /**
   * A review tab built in another window's document, whose nodes come from
   * that window's own realm: `instanceof Element` here is false for them, as
   * it is for a popout window's nodes in the main window's code.
   */
  function makePopoutTab() {
    const frame = document.body.appendChild(document.createElement('iframe'));
    const doc = frame.contentDocument;
    if (!doc) throw new Error('No document in the frame');
    const tab = doc.body.appendChild(doc.createElement('div'));
    return { doc, tab };
  }

  it('sends the key to the editor from the popout’s body, its document element, or a button in the tab', () => {
    const { doc, tab } = makePopoutTab();
    const button = tab.appendChild(doc.createElement('button'));

    expect(button instanceof Element).toBe(false);
    expect(historyKeyReachesEditor(doc.body, tab)).toBe(true);
    expect(historyKeyReachesEditor(doc.documentElement, tab)).toBe(true);
    expect(historyKeyReachesEditor(button, tab)).toBe(true);
  });

  it('sends a native undo to the editor from the popout’s body, its document element, or a button in the tab', () => {
    const { doc, tab } = makePopoutTab();
    const button = tab.appendChild(doc.createElement('button'));

    expect(historyInputReachesEditor(doc.body, tab)).toBe(true);
    expect(historyInputReachesEditor(doc.documentElement, tab)).toBe(true);
    expect(historyInputReachesEditor(button, tab)).toBe(true);
  });

  it('leaves the key to a text field in the popout’s tab', () => {
    const { doc, tab } = makePopoutTab();
    const field = tab.appendChild(doc.createElement('input'));

    expect(isEditableTarget(field)).toBe(true);
    expect(historyKeyReachesEditor(field, tab)).toBe(false);
  });
});
