import { TYPE_ICONS } from '#/components/icons/typeIcons';
import { NOTE_TYPES, type NoteType } from '#/lib/types';
import { Check, Funnel } from 'lucide-react';
import { type App, Scope } from 'obsidian';
import { createPortal, useLayoutEffect, useRef, useState } from 'react';

/** Row labels, in the plural: each row stands for every item of its type. */
const TYPE_LABELS: Record<NoteType, string> = {
  article: 'Articles',
  snippet: 'Snippets',
  card: 'Cards',
};

/** Gap between the filter icon and the menu hanging off it, in pixels. */
export const MENU_GAP = 4;
/** How far the menu is kept from the window's edges, in pixels. */
export const VIEWPORT_MARGIN = 8;

export interface Size {
  width: number;
  height: number;
}

export interface MenuPlacement {
  top: number;
  left: number;
  /** Which side of the icon the menu opens on; picks its slide direction. */
  side: 'below' | 'above';
}

/**
 * Where the menu goes for an icon at `anchor`, in viewport coordinates.
 *
 * Below the icon and aligned with its left edge, pulled back inside the window
 * when it would run off the right, and flipped above the icon when there is no
 * room under it (a bar near the bottom of a phone screen).
 *
 * `Math.max` on both clamps covers a menu bigger than the window: the upper
 * limit would fall below the lower one, and pinning to the top-left margin at
 * least keeps the start of the menu on screen.
 */
export function placeMenu(
  anchor: Pick<DOMRect, 'top' | 'bottom' | 'left'>,
  menu: Size,
  viewport: Size
): MenuPlacement {
  const rightmost = Math.max(
    VIEWPORT_MARGIN,
    viewport.width - menu.width - VIEWPORT_MARGIN
  );
  const left = Math.min(Math.max(anchor.left, VIEWPORT_MARGIN), rightmost);

  const below = anchor.bottom + MENU_GAP;
  if (below + menu.height + VIEWPORT_MARGIN <= viewport.height) {
    return { top: below, left, side: 'below' };
  }
  const top = Math.max(VIEWPORT_MARGIN, anchor.top - MENU_GAP - menu.height);
  return { top, left, side: 'above' };
}

/** True when some type is left out, i.e. the filter is doing something. */
export function isFiltered(
  enabled: Partial<Record<NoteType, unknown>>
): boolean {
  return NOTE_TYPES.some((type) => !enabled[type]);
}

export interface TypeFilterMenuProps {
  /** Whose keymap takes the menu's Escape while it is open. */
  app: Pick<App, 'keymap' | 'scope'>;
  /** Which types are switched on. A missing or falsy entry is off. */
  enabled: Partial<Record<NoteType, unknown>>;
  /** Asked to flip one type. The menu paints whatever `enabled` says next. */
  onToggle: (type: NoteType) => void;
  /** Accessible name and Obsidian tooltip of the filter icon. */
  tooltip?: string;
}

/**
 * A filter icon that opens a small menu of item types, one toggle row each.
 *
 * Owns only whether it is open; which types are on comes in through `enabled`
 * and every change goes out through `onToggle`, so the same menu can front
 * any filter over item types.
 *
 * The menu stays open while its rows are pressed, and closes on a second press
 * of the icon, a press anywhere outside it, or Escape.
 *
 * It is portalled to the icon's own `body` and placed there from the icon's
 * bounding box. The bars that hold the icon scroll horizontally, which clips
 * anything absolutely positioned inside them, and Obsidian's workspace has a
 * transformed ancestor that makes `position: fixed` resolve against itself
 * rather than the window. Using `ownerDocument` rather than the global
 * `document` keeps it in the right window when the view is in a popout.
 *
 * Escape goes through a keymap scope pushed while the menu is open, the way
 * Obsidian's own menus take it. Obsidian's keymap listens on the window in
 * the capture phase, ahead of anything a plugin can add to the document, and
 * the active view's scope (review's selection mode, a PDF viewer) would
 * otherwise take Escape first and stop it before the menu heard it. With its
 * parent at `app.scope`, the app's own hotkeys still work while it is open.
 *
 * Rows are buttons, so Enter and Space toggle them natively. The tooltip is
 * `aria-label` on the icon's button — the accessible name, and what Obsidian
 * draws its themed tooltip from — never on the SVG, which crashes Obsidian's
 * tooltip handler, and never `title`, which stacks a browser tooltip on top.
 */
export function TypeFilterMenu({
  app,
  enabled,
  onToggle,
  tooltip = 'Filter item types',
}: TypeFilterMenuProps) {
  /**
   * `null` while closed. While open, `host` is the `body` the menu is
   * portalled into, taken from the icon's document when it is pressed so a
   * popout window gets the menu in itself; `fromKeyboard` says the open came
   * from the keyboard, which moves focus into the menu.
   */
  const [open, setOpen] = useState<{
    host: HTMLElement;
    fromKeyboard: boolean;
  } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /**
   * Place the menu, and keep it on its icon while the bar scrolls or the
   * window resizes. A layout effect, so the menu is in place before the first
   * paint and the listeners below are live from the moment it is shown.
   */
  useLayoutEffect(() => {
    if (!open) return;
    // Both refs are attached whenever the menu is open: the button always
    // renders, and the menu renders exactly then. A document holding a mounted
    // element always has a window.
    const button = buttonRef.current!;
    const menu = menuRef.current!;
    const doc = button.ownerDocument;
    const win = doc.defaultView!;

    function place() {
      const { top, left, side } = placeMenu(
        button.getBoundingClientRect(),
        { width: menu.offsetWidth, height: menu.offsetHeight },
        { width: win.innerWidth, height: win.innerHeight }
      );
      menu.style.top = `${top}px`;
      menu.style.left = `${left}px`;
      menu.dataset.side = side;
    }

    function handlePressOutside(event: Event) {
      const target = event.target as Node;
      // The icon is excluded so that pressing it while open closes the menu
      // once, through its own click, rather than closing here and reopening.
      if (menu.contains(target) || button.contains(target)) return;
      setOpen(null);
    }

    // `false` has Obsidian's keymap prevent the key's default and stop it, so
    // the view behind the menu doesn't take the Escape too.
    const scope = new Scope(app.scope);
    scope.register([], 'Escape', () => {
      if (menu.contains(doc.activeElement)) button.focus();
      setOpen(null);
      return false;
    });

    place();
    if (open.fromKeyboard) {
      menu.querySelector<HTMLElement>('.ir-type-filter-row')?.focus();
    }
    // Capture, so a scroll in any container (the bar itself included) is
    // heard, and so a press is seen even if its target stops propagation.
    doc.addEventListener('scroll', place, true);
    win.addEventListener('resize', place);
    doc.addEventListener('pointerdown', handlePressOutside, true);
    app.keymap.pushScope(scope);
    return () => {
      doc.removeEventListener('scroll', place, true);
      win.removeEventListener('resize', place);
      doc.removeEventListener('pointerdown', handlePressOutside, true);
      app.keymap.popScope(scope);
    };
  }, [open, app]);

  /** Up and down walk the rows, wrapping at either end. */
  function handleMenuKeyDown(event: KeyboardEvent) {
    const step =
      event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const rows = Array.from(
      (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
        '.ir-type-filter-row'
      )
    );
    const current = rows.indexOf(event.target as HTMLElement);
    const next = (current + step + rows.length) % rows.length;
    rows[next].focus();
  }

  const filtered = isFiltered(enabled);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={
          'ir-review-button clickable-icon ir-type-filter-button' +
          (filtered ? ' is-filtered' : '')
        }
        aria-label={tooltip}
        aria-haspopup="menu"
        aria-expanded={open !== null}
        onClick={(event) => {
          setOpen(
            open
              ? null
              : {
                  host: event.currentTarget.ownerDocument.body,
                  // A click the keyboard made has no pointer presses behind it.
                  fromKeyboard: event.detail === 0,
                }
          );
        }}
      >
        <Funnel />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="ir-type-filter-menu"
            role="menu"
            onKeyDown={handleMenuKeyDown}
          >
            {NOTE_TYPES.map((type) => {
              const Icon = TYPE_ICONS[type];
              const on = Boolean(enabled[type]);
              return (
                <button
                  key={type}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  className={'ir-type-filter-row' + (on ? ' is-enabled' : '')}
                  data-type={type}
                  onClick={() => onToggle(type)}
                >
                  <span className="ir-type-filter-row-icon">
                    <Icon />
                  </span>
                  <span className="ir-type-filter-row-label">
                    {TYPE_LABELS[type]}
                  </span>
                  <span className="ir-type-filter-row-check">
                    <Check />
                  </span>
                </button>
              );
            })}
          </div>,
          open.host
        )}
    </>
  );
}
