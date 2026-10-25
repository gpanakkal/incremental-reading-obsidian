// @vitest-environment jsdom
import { NOTE_TYPES, type NoteType } from '#/lib/types';
import fc from 'fast-check';
import { type App, Scope } from 'obsidian';
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isFiltered,
  MENU_GAP,
  placeMenu,
  TypeFilterMenu,
  VIEWPORT_MARGIN,
} from './TypeFilterMenu';

// #region HELPERS

/**
 * Obsidian's keymap, far enough for the menu: scopes pushed over a base one
 * standing in for the workspace and the view behind the menu, fed by a window
 * capture listener as Obsidian's is (undocumented; see `Keymap.onKeyEvent` in
 * the app bundle), so a handler answering `false` stops the key before the
 * document sees it. Installed once; `unmount` empties the stack.
 */
const viewScope = new Scope();
const keymap = {
  stack: [] as Scope[],
  pushScope(scope: Scope) {
    keymap.stack.push(scope);
  },
  popScope(scope: Scope) {
    const index = keymap.stack.indexOf(scope);
    if (index >= 0) keymap.stack.splice(index, 1);
  },
};
window.addEventListener(
  'keydown',
  (event) => {
    const scope = keymap.stack[keymap.stack.length - 1] ?? viewScope;
    if (scope.handleKey(event, { modifiers: '', key: event.key }) === false) {
      event.preventDefault();
      event.stopPropagation();
    }
  },
  true
);
const app = { scope: new Scope(), keymap } as unknown as Pick<
  App,
  'keymap' | 'scope'
>;

type Enabled = Partial<Record<NoteType, boolean>>;

/** Every set of types the filter can be left at, the empty one included. */
const typesArb = fc.subarray([...NOTE_TYPES]);

function enabledOf(types: readonly NoteType[]): Enabled {
  return Object.fromEntries(types.map((type) => [type, true]));
}

/**
 * Holds the filter state the way a real owner does: a toggle flips the type,
 * and the menu repaints from what comes back down.
 */
function Harness({
  initial,
  onToggle,
}: {
  initial: Enabled;
  onToggle: (type: NoteType) => void;
}) {
  const [enabled, setEnabled] = useState(initial);
  return (
    <TypeFilterMenu
      app={app}
      enabled={enabled}
      onToggle={(type) => {
        onToggle(type);
        setEnabled((prev) => ({ ...prev, [type]: !prev[type] }));
      }}
    />
  );
}

/** The root mounted last, unmounted before the next so no listener leaks. */
let mounted: HTMLElement | null = null;

function unmount() {
  const root = mounted;
  mounted = null;
  if (root) void act(() => render(null, root));
  document.body.innerHTML = '';
  keymap.stack.length = 0;
}

/**
 * Mount a menu into a fresh document. Mocks are made here rather than shared,
 * since the properties below mount many times per `it`.
 */
function mountMenu(
  enabled: Enabled = enabledOf(NOTE_TYPES),
  {
    controlled = false,
    tooltip,
  }: { controlled?: boolean; tooltip?: string } = {}
) {
  unmount();
  const container = document.createElement('div');
  document.body.appendChild(container);
  mounted = container;
  const onToggle = vi.fn();
  void act(() => {
    render(
      controlled ? (
        <Harness initial={enabled} onToggle={onToggle} />
      ) : (
        <TypeFilterMenu
          app={app}
          enabled={enabled}
          onToggle={onToggle}
          tooltip={tooltip}
        />
      ),
      container
    );
  });
  return { container, onToggle };
}

function filterButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    '.ir-type-filter-button'
  );
  if (!button) throw new Error('filter button not rendered');
  return button;
}

function menu(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.ir-type-filter-menu');
}

function rows(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('.ir-type-filter-row')
  );
}

function row(type: NoteType): HTMLButtonElement {
  const found = rows().find((el) => el.dataset.type === type);
  if (!found) throw new Error(`no row for ${type}`);
  return found;
}

/** A click with a pointer behind it (`detail` counts the presses). */
function clickWithMouse(element: Element) {
  void act(() => {
    element.dispatchEvent(
      new MouseEvent('click', { bubbles: true, detail: 1 })
    );
  });
}

/** A click the keyboard made: Enter or Space on a button fires `detail: 0`. */
function clickWithKeyboard(element: Element) {
  void act(() => {
    element.dispatchEvent(
      new MouseEvent('click', { bubbles: true, detail: 0 })
    );
  });
}

/** Built from `MouseEvent`: jsdom does not construct `PointerEvent`. */
function press(element: Element) {
  void act(() => {
    element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  });
}

function key(element: Element, name: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: name,
    bubbles: true,
    cancelable: true,
  });
  void act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

function openMenu() {
  clickWithMouse(filterButton());
  if (!menu()) throw new Error('menu did not open');
}

/** Something on the page that is neither the icon nor the menu. */
function outsider(): HTMLElement {
  const el = document.createElement('button');
  document.body.appendChild(el);
  return el;
}

const sizeArb = fc.record({
  width: fc.integer({ min: 0, max: 2000 }),
  height: fc.integer({ min: 0, max: 2000 }),
});

const anchorArb = fc
  .record({
    top: fc.integer({ min: -100, max: 2100 }),
    left: fc.integer({ min: -100, max: 2100 }),
    height: fc.integer({ min: 0, max: 60 }),
  })
  .map(({ top, left, height }) => ({ top, left, bottom: top + height }));

// #endregion

// lucide-react resolves `useContext` against its own preact copy, which is not
// the instance rendering here (see the react→preact aliasing TODO in
// vitest.config.ts). The glyphs are not this component's behavior.
vi.mock('lucide-react', () => ({
  Check: () => null,
  FileText: () => null,
  Funnel: () => null,
  Scissors: () => null,
}));

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe('placeMenu', () => {
  it('never puts the menu past the left margin', () => {
    fc.assert(
      fc.property(anchorArb, sizeArb, sizeArb, (anchor, size, viewport) => {
        expect(placeMenu(anchor, size, viewport).left).toBeGreaterThanOrEqual(
          VIEWPORT_MARGIN
        );
      })
    );
  });

  it('keeps a menu that fits the window inside its right margin', () => {
    fc.assert(
      fc.property(anchorArb, sizeArb, sizeArb, (anchor, size, viewport) => {
        fc.pre(size.width + 2 * VIEWPORT_MARGIN <= viewport.width);
        const { left } = placeMenu(anchor, size, viewport);
        expect(left + size.width + VIEWPORT_MARGIN).toBeLessThanOrEqual(
          viewport.width
        );
      })
    );
  });

  it('lines the menu up with the icon whenever there is room to', () => {
    fc.assert(
      fc.property(anchorArb, sizeArb, sizeArb, (anchor, size, viewport) => {
        fc.pre(anchor.left >= VIEWPORT_MARGIN);
        fc.pre(anchor.left + size.width + VIEWPORT_MARGIN <= viewport.width);
        expect(placeMenu(anchor, size, viewport).left).toBe(anchor.left);
      })
    );
  });

  it('pins a menu wider than the window to the left margin', () => {
    expect(
      placeMenu(
        { top: 0, bottom: 20, left: 300 },
        { width: 500, height: 10 },
        { width: 400, height: 800 }
      ).left
    ).toBe(VIEWPORT_MARGIN);
  });

  it('opens below the icon exactly when it fits there', () => {
    fc.assert(
      fc.property(anchorArb, sizeArb, sizeArb, (anchor, size, viewport) => {
        const placed = placeMenu(anchor, size, viewport);
        const fitsBelow =
          anchor.bottom + MENU_GAP + size.height + VIEWPORT_MARGIN <=
          viewport.height;
        expect(placed.side).toBe(fitsBelow ? 'below' : 'above');
        if (fitsBelow) expect(placed.top).toBe(anchor.bottom + MENU_GAP);
      })
    );
  });

  it('still opens below when the menu fits with nothing to spare', () => {
    const anchor = { top: 80, bottom: 100, left: 20 };
    const size = { width: 100, height: 50 };
    const exact = 100 + MENU_GAP + 50 + VIEWPORT_MARGIN;

    expect(placeMenu(anchor, size, { width: 800, height: exact }).side).toBe(
      'below'
    );
    expect(
      placeMenu(anchor, size, { width: 800, height: exact - 1 }).side
    ).toBe('above');
  });

  it('flipped above, ends a gap short of the icon, or at the top margin', () => {
    fc.assert(
      fc.property(anchorArb, sizeArb, sizeArb, (anchor, size, viewport) => {
        const placed = placeMenu(anchor, size, viewport);
        fc.pre(placed.side === 'above');
        expect(placed.top).toBe(
          Math.max(VIEWPORT_MARGIN, anchor.top - MENU_GAP - size.height)
        );
      })
    );
  });

  it('flipped above an icon near the top, stops at the top margin', () => {
    expect(
      placeMenu(
        { top: 10, bottom: 30, left: 20 },
        { width: 100, height: 200 },
        { width: 800, height: 100 }
      ).top
    ).toBe(VIEWPORT_MARGIN);
  });
});

describe('isFiltered', () => {
  it('is true exactly when some type is left out', () => {
    fc.assert(
      fc.property(typesArb, (types) => {
        expect(isFiltered(enabledOf(types))).toBe(
          types.length < NOTE_TYPES.length
        );
      })
    );
  });

  it('counts a type set to false as left out', () => {
    expect(isFiltered({ article: true, snippet: true, card: false })).toBe(
      true
    );
  });
});

describe('TypeFilterMenu', () => {
  it('starts closed', () => {
    mountMenu();

    expect(menu()).toBeNull();
    expect(filterButton().getAttribute('aria-expanded')).toBe('false');
    expect(filterButton().getAttribute('aria-haspopup')).toBe('menu');
  });

  it('labels the icon button, never the glyph, and never with `title`', () => {
    // `aria-label` is what Obsidian draws its tooltip from; `title` would stack
    // a browser tooltip on it, and a label on an SVG crashes the handler.
    mountMenu(enabledOf(NOTE_TYPES), { tooltip: 'Pick types' });
    openMenu();

    expect(filterButton().getAttribute('aria-label')).toBe('Pick types');
    expect(document.querySelector('[title]')).toBeNull();
    expect(document.querySelector('svg[aria-label]')).toBeNull();
  });

  it('has a label of its own when the owner gives none', () => {
    mountMenu();

    expect(filterButton().getAttribute('aria-label')).toMatch(/\S/);
  });

  it('opens on the icon, outside the bar that holds it', () => {
    // Portalled: the bar scrolls sideways and would clip it.
    const { container } = mountMenu();

    openMenu();

    expect(filterButton().getAttribute('aria-expanded')).toBe('true');
    expect(menu()?.parentElement).toBe(document.body);
    expect(container.contains(menu())).toBe(false);
    expect(menu()?.getAttribute('role')).toBe('menu');
  });

  it('lists one row per type, in reading order', () => {
    mountMenu();
    openMenu();

    expect(rows().map((el) => el.dataset.type)).toEqual([...NOTE_TYPES]);
    for (const el of rows()) {
      expect(el.getAttribute('role')).toBe('menuitemcheckbox');
      expect(el.type).toBe('button');
      expect(el.textContent).toMatch(/\S/);
    }
  });

  it('checks a row exactly when its type is on', () => {
    fc.assert(
      fc.property(typesArb, (types) => {
        mountMenu(enabledOf(types));
        openMenu();

        for (const type of NOTE_TYPES) {
          const on = types.includes(type);
          expect(row(type).getAttribute('aria-checked')).toBe(String(on));
          expect(Array.from(row(type).classList)).toEqual(
            on ? ['ir-type-filter-row', 'is-enabled'] : ['ir-type-filter-row']
          );
        }
      })
    );
  });

  it('marks the icon while the filter leaves any type out', () => {
    fc.assert(
      fc.property(typesArb, (types) => {
        mountMenu(enabledOf(types));

        expect(Array.from(filterButton().classList)).toEqual([
          'ir-review-button',
          'clickable-icon',
          'ir-type-filter-button',
          ...(types.length < NOTE_TYPES.length ? ['is-filtered'] : []),
        ]);
      })
    );
  });

  it('hands the pressed row to its owner and stays open', () => {
    fc.assert(
      fc.property(
        typesArb,
        fc.constantFrom(...NOTE_TYPES),
        (types, clicked) => {
          const { onToggle } = mountMenu(enabledOf(types));
          openMenu();

          press(row(clicked));
          clickWithMouse(row(clicked));

          expect(onToggle.mock.calls).toEqual([[clicked]]);
          expect(menu()).not.toBeNull();
        }
      )
    );
  });

  it('changes nothing on its own — a row only asks', () => {
    // What is on comes from the owner, so a row that painted itself would
    // disagree with it the moment a change was refused.
    mountMenu(enabledOf(['article']));
    openMenu();

    clickWithMouse(row('article'));
    clickWithMouse(row('card'));

    expect(row('article').getAttribute('aria-checked')).toBe('true');
    expect(row('card').getAttribute('aria-checked')).toBe('false');
  });

  it('closes on a second press of the icon', () => {
    mountMenu();
    openMenu();

    // The press lands before the click; it must not close the menu by itself
    // or the click that follows would open it again.
    press(filterButton());
    expect(menu()).not.toBeNull();
    clickWithMouse(filterButton());

    expect(menu()).toBeNull();
    expect(filterButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on a press outside it, and not on one inside', () => {
    mountMenu();
    openMenu();

    press(menu() as HTMLElement);
    expect(menu()).not.toBeNull();

    press(outsider());
    expect(menu()).toBeNull();
  });

  it('closes on Escape, keeping it from the view behind', () => {
    mountMenu();
    openMenu();
    // A view scope that takes Escape, as review's selection mode does.
    const viewEscape = vi.fn(() => false);
    const handler = viewScope.register([], 'Escape', viewEscape);
    const behind = vi.fn();
    document.addEventListener('keydown', behind);

    const event = key(document.body, 'Escape');

    expect(menu()).toBeNull();
    expect(event.defaultPrevented).toBe(true);
    expect(viewEscape).not.toHaveBeenCalled();
    expect(behind).not.toHaveBeenCalled();
    document.removeEventListener('keydown', behind);
    viewScope.unregister(handler);
  });

  it('lets other keys through and stays open', () => {
    mountMenu();
    openMenu();

    const event = key(document.body, 'a');

    expect(menu()).not.toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  it('stops listening once closed', () => {
    // A leaked Escape handler would swallow the key for every view after it.
    mountMenu();
    openMenu();
    clickWithMouse(filterButton());
    const viewEscape = vi.fn();
    const handler = viewScope.register([], 'Escape', viewEscape);

    expect(key(document.body, 'Escape').defaultPrevented).toBe(false);
    expect(viewEscape).toHaveBeenCalledTimes(1);
    viewScope.unregister(handler);
  });

  it('removes every listener it added, on close and on unmount', () => {
    const added = vi.spyOn(document, 'addEventListener');
    const removed = vi.spyOn(document, 'removeEventListener');
    const winAdded = vi.spyOn(window, 'addEventListener');
    const winRemoved = vi.spyOn(window, 'removeEventListener');
    const { container } = mountMenu();

    openMenu();
    expect(keymap.stack).toHaveLength(1);
    clickWithMouse(filterButton());
    expect(keymap.stack).toEqual([]);
    openMenu();
    void act(() => render(null, container));
    expect(keymap.stack).toEqual([]);

    const ours = (calls: unknown[][]) =>
      calls.filter(([type]) =>
        ['scroll', 'pointerdown', 'resize'].includes(type as string)
      );
    expect(ours(added.mock.calls).length).toBeGreaterThan(0);
    expect(ours(removed.mock.calls)).toEqual(ours(added.mock.calls));
    expect(ours(winAdded.mock.calls).length).toBeGreaterThan(0);
    expect(ours(winRemoved.mock.calls)).toEqual(ours(winAdded.mock.calls));
  });

  it('hands focus back to the icon when Escape closes it from inside', () => {
    mountMenu();
    openMenu();
    row('snippet').focus();

    key(row('snippet'), 'Escape');

    expect(document.activeElement).toBe(filterButton());
  });

  it('leaves focus alone when Escape closes it from elsewhere', () => {
    mountMenu();
    const elsewhere = outsider();
    openMenu();
    elsewhere.focus();

    key(elsewhere, 'Escape');

    expect(document.activeElement).toBe(elsewhere);
  });

  it('moves focus to the first row when opened from the keyboard', () => {
    // The menu sits at the end of `body`, so Tab alone would never reach it.
    mountMenu();
    filterButton().focus();

    clickWithKeyboard(filterButton());

    expect(document.activeElement).toBe(rows()[0]);
  });

  it('leaves focus on the icon when opened with a pointer', () => {
    mountMenu();
    filterButton().focus();

    openMenu();

    expect(document.activeElement).toBe(filterButton());
  });

  it('walks the rows with the arrow keys, wrapping at both ends', () => {
    mountMenu();
    openMenu();
    const order = rows();
    order[0].focus();

    const down = key(order[0], 'ArrowDown');
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(order[1]);

    key(order[1], 'ArrowDown');
    key(order[2], 'ArrowDown');
    expect(document.activeElement).toBe(order[0]);

    const up = key(order[0], 'ArrowUp');
    expect(up.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(order[2]);
    key(order[2], 'ArrowUp');
    expect(document.activeElement).toBe(order[1]);
  });

  it('ignores other keys on the rows', () => {
    mountMenu();
    openMenu();
    rows()[1].focus();

    const event = key(rows()[1], 'ArrowRight');

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(rows()[1]);
  });

  describe('placement', () => {
    function wireGeometry(rect: { top: number; bottom: number; left: number }) {
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(
        120
      );
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(
        90
      );
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(400);
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
      return vi
        .spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect')
        .mockReturnValue(rect as DOMRect);
    }

    function expectAt(rect: { top: number; bottom: number; left: number }) {
      const want = placeMenu(
        rect,
        { width: 120, height: 90 },
        { width: 400, height: 800 }
      );
      expect(menu()?.style.top).toBe(`${want.top}px`);
      expect(menu()?.style.left).toBe(`${want.left}px`);
      expect(menu()?.dataset.side).toBe(want.side);
    }

    it('hangs the menu off the icon as soon as it opens', () => {
      const rect = { top: 20, bottom: 50, left: 30 };
      wireGeometry(rect);
      mountMenu();

      openMenu();

      expectAt(rect);
    });

    it('flips above an icon too close to the bottom', () => {
      const rect = { top: 760, bottom: 790, left: 30 };
      wireGeometry(rect);
      mountMenu();

      openMenu();

      expect(menu()?.dataset.side).toBe('above');
      expectAt(rect);
    });

    it('follows the icon when anything scrolls', () => {
      // Captured, since the bar scrolling sideways does not bubble.
      const rect = wireGeometry({ top: 20, bottom: 50, left: 30 });
      mountMenu();
      openMenu();
      const moved = { top: 20, bottom: 50, left: 140 };
      rect.mockReturnValue(moved as DOMRect);

      void act(() => {
        outsider().dispatchEvent(new Event('scroll'));
      });

      expectAt(moved);
    });

    it('follows the icon when the window resizes', () => {
      const rect = wireGeometry({ top: 20, bottom: 50, left: 30 });
      mountMenu();
      openMenu();
      const moved = { top: 300, bottom: 330, left: 60 };
      rect.mockReturnValue(moved as DOMRect);

      void act(() => {
        window.dispatchEvent(new Event('resize'));
      });

      expectAt(moved);
    });
  });

  it('agrees with a simple model under any sequence of presses and keys', () => {
    type Op =
      | { kind: 'icon' }
      | { kind: 'row'; type: NoteType }
      | { kind: 'inside' }
      | { kind: 'outside' }
      | { kind: 'escape' }
      | { kind: 'otherKey' };
    const opArb: fc.Arbitrary<Op> = fc.oneof(
      fc.constant({ kind: 'icon' } as const),
      fc
        .constantFrom(...NOTE_TYPES)
        .map((type) => ({ kind: 'row', type }) as const),
      fc.constant({ kind: 'inside' } as const),
      fc.constant({ kind: 'outside' } as const),
      fc.constant({ kind: 'escape' } as const),
      fc.constant({ kind: 'otherKey' } as const)
    );

    fc.assert(
      fc.property(
        typesArb,
        fc.array(opArb, { maxLength: 25 }),
        (types, ops) => {
          const { onToggle } = mountMenu(enabledOf(types), {
            controlled: true,
          });
          const model = {
            open: false,
            on: new Set(types),
            toggled: [] as NoteType[],
          };

          for (const op of ops) {
            switch (op.kind) {
              case 'icon':
                press(filterButton());
                clickWithMouse(filterButton());
                model.open = !model.open;
                break;
              case 'row':
                // A row can only be pressed while the menu shows it.
                if (!model.open) continue;
                press(row(op.type));
                clickWithMouse(row(op.type));
                model.toggled.push(op.type);
                if (model.on.has(op.type)) model.on.delete(op.type);
                else model.on.add(op.type);
                break;
              case 'inside':
                if (!model.open) continue;
                press(menu() as HTMLElement);
                break;
              case 'outside':
                press(outsider());
                model.open = false;
                break;
              case 'escape':
                key(document.body, 'Escape');
                model.open = false;
                break;
              case 'otherKey':
                key(document.body, 'Tab');
                break;
            }

            expect(menu() !== null).toBe(model.open);
            expect(filterButton().getAttribute('aria-expanded')).toBe(
              String(model.open)
            );
            expect(filterButton().classList.contains('is-filtered')).toBe(
              model.on.size < NOTE_TYPES.length
            );
            if (model.open) {
              for (const type of NOTE_TYPES) {
                expect(row(type).getAttribute('aria-checked')).toBe(
                  String(model.on.has(type))
                );
              }
            }
          }
          expect(onToggle.mock.calls).toEqual(model.toggled.map((t) => [t]));
        }
      )
    );
  });
});
