// @vitest-environment jsdom
import type { ItemChild } from '#/lib/items/item-children';
import { Modal } from '#/test/__mocks__/obsidian';
import { makeUiWindow } from '#/test/fake-window';
import fc from 'fast-check';
import type { App } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ChildrenChoice,
  promptForChildren,
  type RemovedItems,
} from './ChildrenPrompt';
import type { ConfirmModal } from './ConfirmModal';

// lucide-react's icons use hooks, which under Vitest resolve against another
// preact instance than the one rendering here (see the react→preact aliasing
// TODO in vitest.config.ts): stand-ins that draw an SVG, as the real ones do
vi.mock('lucide-react', async () => {
  const { h } = await import('preact');
  return {
    FileText: () => h('svg', { 'data-icon': 'file-text' }),
    Scissors: () => h('svg', { 'data-icon': 'scissors' }),
  };
});

// #region HELPERS

const APP = {} as App;

/** The modal opened last. */
let opened: ConfirmModal | null = null;

/** Open and close as Obsidian's do (see `ConfirmModal.test.ts`). */
function wireModalLifecycle() {
  vi.spyOn(Modal.prototype, 'open').mockImplementation(function (this: Modal) {
    opened = this as unknown as ConfirmModal;
    this.modalEl.appendChild(this.contentEl);
    this.containerEl.appendChild(this.modalEl);
    document.body.appendChild(this.containerEl);
    opened.onOpen();
  });
  vi.spyOn(Modal.prototype, 'close').mockImplementation(function (this: Modal) {
    this.containerEl.remove();
    (this as unknown as ConfirmModal).onClose();
  });
}

/** The open modal's parts: its buttons, title, paragraphs and child rows. */
function shown() {
  const modal = opened!;
  const buttons = [
    ...modal.modalEl.querySelectorAll<HTMLButtonElement>(
      '.modal-button-container > button'
    ),
  ];
  const title = modal.titleEl.textContent ?? '';
  const paragraphs = [...modal.contentEl.querySelectorAll(':scope > p')].map(
    (el) => el.textContent ?? ''
  );
  const rows = [
    ...modal.contentEl.querySelectorAll<HTMLElement>('.ir-children-row'),
  ];
  return { modal, buttons, title, paragraphs, rows };
}

const titleArb = fc.string({ minLength: 1, maxLength: 20 });

const removedArb: fc.Arbitrary<RemovedItems> = fc.record({
  kind: fc.constantFrom<RemovedItems['kind']>('article', 'snippet', 'card'),
  titles: fc.array(titleArb, { minLength: 1, maxLength: 4 }),
});

/** A part of a vault path: a folder's name or a file's, without a slash. */
const segmentArb = fc
  .string({ minLength: 1, maxLength: 8 })
  .filter((segment) => !segment.includes('/'));

/**
 * A note's path, in a folder or at the root, with a `.md` or without, and
 * the name the user knows it by: its file name, less the `.md`.
 */
const noteArb = fc
  .record({
    folders: fc.array(segmentArb, { maxLength: 3 }),
    // Ending in `.md`, it would read as a name with one, given none
    name: segmentArb.filter((name) => !name.endsWith('.md')),
    md: fc.boolean(),
  })
  .map(({ folders, name, md }) => ({
    name,
    path: [...folders, md ? `${name}.md` : name].join('/'),
  }));

/**
 * Snippets and cards under what an undo removes, deepest first as
 * `childrenOf` lists them: at least one, of either kind, any of them trashed.
 */
const childrenArb: fc.Arbitrary<ItemChild[]> = fc.uniqueArray(
  fc.record({
    table: fc.constantFrom<ItemChild['table']>('snippet', 'srs_card'),
    id: fc.uuid(),
    trashed: fc.boolean(),
    reference: noteArb.map(({ path }) => path),
    highlightedIn: fc.constant(null),
  }),
  { minLength: 1, maxLength: 6, selector: ({ id }) => id }
);

const CARD: ItemChild = {
  table: 'srs_card',
  id: 'card-1',
  trashed: false,
  reference: 'cards/A card.md',
  highlightedIn: 'snippets/Extract.md',
};

/** Ask, and the modal it opened. */
function ask(
  removing: RemovedItems = { kind: 'snippet', titles: ['Extract'] },
  children: readonly ItemChild[] = [CARD],
  description = 'creating snippet "Extract"'
) {
  const answered = promptForChildren(APP, {
    description,
    removing,
    children,
  });
  return { answered, ...shown() };
}

// #endregion

describe('promptForChildren', () => {
  beforeEach(() => {
    wireModalLifecycle();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['cancel', 0],
    ['remove', 1],
    ['keep', 2],
  ] as [ChildrenChoice, number][])(
    'resolves to %s for the button pressed',
    async (choice, index) => {
      const { answered, buttons } = ask();
      expect(buttons).toHaveLength(3);

      buttons[index].click();

      await expect(answered).resolves.toBe(choice);
    }
  );

  it('resolves to cancel when closed any other way, as Escape closes it', async () => {
    const { answered, modal } = ask();

    modal.close();

    await expect(answered).resolves.toBe('cancel');
  });

  it('styles removing the children as a delete, and keeping them as the default', () => {
    const { buttons } = ask();

    expect(buttons[1].classList.contains('mod-destructive')).toBe(true);
    expect(buttons[2].classList.contains('mod-cta')).toBe(true);
    expect(buttons[2].classList.contains('mod-destructive')).toBe(false);
  });

  it('property: names the undo, and each child on a row of its own, shallowest first, by its type, its note and whether it is in the trash', () => {
    fc.assert(
      fc.property(
        removedArb,
        childrenArb,
        fc.string({ minLength: 1 }),
        (removing, children, description) => {
          document.body.innerHTML = '';
          const listed = [...children];
          const { title, rows } = ask(removing, children, description);

          expect(title).toContain(description);
          const shallowestFirst = [...children].reverse();
          expect(rows).toHaveLength(children.length);
          rows.forEach((row, i) => {
            const child = shallowestFirst[i];
            const icon = row.querySelector('.ir-item-icon');
            const name = row.querySelector('.ir-item-name');
            expect(icon?.getAttribute('data-type')).toBe(
              child.table === 'snippet' ? 'snippet' : 'card'
            );
            expect(icon?.querySelector('svg')).not.toBeNull();
            expect(icon?.hasAttribute('aria-label')).toBe(false);
            expect(name?.getAttribute('aria-label')).toBe(child.reference);
            expect(row.classList.contains('is-trashed')).toBe(child.trashed);
            // Said beside its name, after it
            const trash = row.querySelector('.ir-children-trashed');
            expect(trash !== null).toBe(child.trashed);
            if (trash) {
              expect(
                name!.compareDocumentPosition(trash) &
                  Node.DOCUMENT_POSITION_FOLLOWING
              ).toBeTruthy();
            }
          });
          // The undo deletes them in the order given, after it asks
          expect(children).toStrictEqual(listed);
        }
      )
    );
  });

  it("property: names each child by its note's file name, less a .md", () => {
    fc.assert(
      fc.property(noteArb, ({ name, path }) => {
        document.body.innerHTML = '';
        const { rows } = ask(undefined, [{ ...CARD, reference: path }]);

        expect(rows[0].querySelector('.ir-item-name')?.textContent).toBe(name);
      })
    );
  });

  it('says what hangs under the item in one paragraph, its rows in a list after it', () => {
    const { modal, paragraphs, rows } = ask();

    expect(paragraphs).toHaveLength(1);
    const lead = modal.contentEl.querySelector(':scope > p')!;
    const list = modal.contentEl.querySelector('.ir-children-list')!;
    expect(
      lead.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(rows.every((row) => row.parentElement === list)).toBe(true);
  });

  it.each([
    [1, /^This /, 'article'],
    [2, /^These /, 'articles'],
    [4, /^These /, 'articles'],
  ])('speaks of %s item(s) removed as such', (count, opening, kind) => {
    const { paragraphs } = ask({
      kind: 'article',
      titles: Array.from({ length: count }, (_, i) => `a${i}`),
    });

    expect(paragraphs[0]).toMatch(opening);
    expect(paragraphs[0].split(/\W+/)).toContain(kind);
  });
});

describe('promptForChildren asked for from a window', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** The windows a prompt asked for from `origin` opened in, Settings focused behind. */
  function opened(origin?: HTMLElement) {
    const settings = makeUiWindow({ focused: true }).win;
    vi.stubGlobal('activeWindow', settings);
    vi.stubGlobal('activeDocument', settings.document);
    const windows: Window[] = [];
    vi.spyOn(Modal.prototype, 'open').mockImplementation(() => {
      windows.push(activeWindow);
    });
    void promptForChildren(
      APP,
      {
        description: 'creating snippet "Extract"',
        removing: { kind: 'snippet', titles: ['Extract'] },
        children: [CARD],
      },
      origin
    );
    return { windows, settings };
  }

  it('opens once, in the window it was asked for from', () => {
    const popout = makeUiWindow();

    expect(opened(popout.element).windows).toEqual([popout.win]);
  });

  it('opens once where plugin UI otherwise goes when asked for from nowhere', () => {
    const { windows, settings } = opened();

    expect(windows).toEqual([settings]);
  });
});
