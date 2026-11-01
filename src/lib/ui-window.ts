import type { App, Menu, MenuPositionDef, Modal } from 'obsidian';

/**
 * What a modal or menu was asked for from: an element in the window the user
 * acted in, or the event of that action. Null or undefined when there is
 * neither, as for a command or a prompt nobody asked for.
 */
export type UiOrigin = Node | UIEvent | null | undefined;

/**
 * The window `origin` is in, or null when it names none. Read off the node's
 * document or the event's `view` rather than by `instanceof`, which fails
 * across windows: a popout's nodes come from its own realm.
 */
function originWindow(origin: UiOrigin): Window | null {
  if (!origin) return null;
  if ('nodeType' in origin) {
    // A document has no owner document; it is its own
    return (origin.ownerDocument ?? (origin as Document)).defaultView;
  }
  return origin.view;
}

function hasFocus(win: Window): boolean {
  return !win.closed && win.document.hasFocus();
}

/** The main window and the window of every leaf, popouts included. */
function workspaceWindows(app: App): Window[] {
  const windows = new Set<Window>([window]);
  app.workspace.iterateAllLeaves((leaf) => {
    windows.add(leaf.getContainer().win);
  });
  return [...windows];
}

/**
 * The window plugin UI asked for from `origin` belongs in: the window of
 * `origin` while it is open; failing that, Obsidian's `activeWindow` while it
 * is the main window or has focus; failing that, whichever of the main window
 * and the workspace's popouts has focus; and failing all of those,
 * `activeWindow`, or the main window should `activeWindow` have closed.
 *
 * Obsidian opens a `Modal`, a `Notice`, and a `Menu` shown without a
 * document on `activeWindow`, and routes keys by it (undocumented, read from
 * obsidian.asar 1.14: `Modal.open` takes `this.win = activeWindow` and
 * appends there; `Keymap.onKeyEvent` reads the scope stack of
 * `activeWindow`). It moves `activeWindow` only on a window's `focus` event
 * and when Settings (1.13+, a window of its own) opens. When the main window
 * gets the user back without a `focus` event, `activeWindow` stays on
 * Settings, and without this the plugin's modals would open there. Only a
 * window other than the main one is second-guessed: the main window is
 * Obsidian's own fallback, and where everything opens on mobile.
 */
export function uiWindow(app: App, origin?: UiOrigin): Window {
  const from = originWindow(origin);
  if (from && !from.closed) return from;
  const current = activeWindow;
  if (current === window || hasFocus(current)) return current;
  const focused = workspaceWindows(app).find(hasFocus);
  if (focused) return focused;
  return current.closed ? window : current;
}

/**
 * Make the window plugin UI asked for from `origin` belongs in (see
 * {@link uiWindow}) Obsidian's `activeWindow` and `activeDocument`, as its
 * own `focus` handler would have, and return it. Left so afterwards: the
 * user is in that window, and the keys of a modal or menu opened there
 * reach it only while `activeWindow` is its window.
 *
 * Writes Obsidian's globals (documented for reading only). Seen by the user:
 * besides the plugin's modal or menu opening in that window, Obsidian's
 * hotkeys work there again, and Escape there stops closing Settings.
 */
export function adoptWindow(app: App, origin?: UiOrigin): Window {
  const win = uiWindow(app, origin);
  // eslint-disable-next-line no-global-assign, no-implicit-globals -- Obsidian's own global, assigned as its focus handler assigns it
  activeWindow = win;
  // eslint-disable-next-line no-global-assign, no-implicit-globals -- as above
  activeDocument = win.document;
  return win;
}

/** Open `modal` in the window it belongs in (see {@link adoptWindow}). */
export function openModal(modal: Modal, origin?: UiOrigin): void {
  adoptWindow(modal.app, origin);
  modal.open();
}

/**
 * Show `menu` at `position` in the window it belongs in (see
 * {@link adoptWindow}).
 */
export function showMenu(
  app: App,
  menu: Menu,
  position: MenuPositionDef,
  origin?: UiOrigin
): Menu {
  return menu.showAtPosition(position, adoptWindow(app, origin).document);
}
