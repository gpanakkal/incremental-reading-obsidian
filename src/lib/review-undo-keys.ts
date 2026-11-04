// Undo and redo keys pressed in the review tab outside its editor.
//
// In a note tab those keys reach CodeMirror's own keymap only while its editor
// has focus. Anywhere else Electron's Edit menu turns them into the page's
// native undo, which lands on whatever contenteditable Chromium last recorded
// typing in: often a background tab of the same note. Review answers them for
// its editor instead, from wherever in the tab focus is, short of a field that
// edits text of its own.

/** What an undo or redo key asks the editor for. */
export type HistoryCommand = 'undo' | 'redo';

/** The parts of a key event {@link historyCommandFor} reads. */
export type HistoryKey = Pick<
  KeyboardEvent,
  'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
>;

/**
 * Whether keys pressed at `target` edit text: a form field, or anything inside
 * an element made editable. The review editor in selection mode is not one —
 * its `contenteditable` is `false`.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    asElement(target)?.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
    ) != null
  );
}

/**
 * `target` as an element, whichever window it belongs to. Not `instanceof
 * Element`, which is false for the nodes of a popout window: each window has
 * its own `Element`.
 */
function asElement(target: EventTarget | null): Element | null {
  return typeof (target as Partial<Element> | null)?.closest === 'function'
    ? (target as Element)
    : null;
}

/**
 * The editor history command `evt` is bound to, by CodeMirror's history keymap
 * as Obsidian's editor has it: Mod+Z undoes; Mod+Y redoes off macOS, and
 * Mod+Shift+Z everywhere (it is CodeMirror's redo on macOS and Linux, and the
 * accelerator of Electron's Edit > Redo, which re-sends it to the page, on
 * Windows). Mod is Cmd on macOS and Ctrl elsewhere. Obsidian's own undo and
 * redo commands exist only on mobile, so there are no remapped hotkeys to
 * follow on desktop.
 */
export function historyCommandFor(
  evt: HistoryKey,
  isMac: boolean
): HistoryCommand | null {
  const mod = isMac ? evt.metaKey && !evt.ctrlKey : evt.ctrlKey && !evt.metaKey;
  if (!mod || evt.altKey) return null;
  const key = evt.key.toLowerCase();
  if (key === 'z') return evt.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && !isMac && !evt.shiftKey) return 'redo';
  return null;
}

/**
 * Whether a key pressed at `target` is the review editor's to answer: nothing
 * has focus (the body, as after review moves on from a button that went with
 * the item), or focus is somewhere in the review tab `tab` that doesn't edit
 * text of its own — the action bar, the view header's buttons. The editor
 * answers its own keys, and a text field (the priority, the title, the find
 * bar) keeps its own undo.
 */
export function historyKeyReachesEditor(
  target: EventTarget | null,
  tab: Element
): boolean {
  if (target === null) return true;
  const element = asElement(target);
  if (!element) return false;
  const doc = element.ownerDocument;
  if (element === doc.body || element === doc.documentElement) return true;
  return tab.contains(element) && !isEditableTarget(element);
}

/**
 * The editor history command a `beforeinput` of `inputType` asks for: the
 * page's native undo and redo, as iOS's shake to undo and a browser's Edit
 * menu send them. CodeMirror's history answers these itself, but only for
 * events that reach the editor on screen.
 */
export function historyCommandForInput(
  inputType: string
): HistoryCommand | null {
  if (inputType === 'historyUndo') return 'undo';
  if (inputType === 'historyRedo') return 'redo';
  return null;
}

/**
 * Whether a native undo or redo landing on `target` is the review editor's to
 * answer: where {@link historyKeyReachesEditor} would send a key, in the
 * document the review tab `tab` is in. Unlike a key, which Obsidian hands only
 * to the active tab of the focused window, the event reaches a listener on
 * every window; another window's body is not this tab's.
 */
export function historyInputReachesEditor(
  target: EventTarget | null,
  tab: Element
): boolean {
  return (
    asElement(target)?.ownerDocument === tab.ownerDocument &&
    historyKeyReachesEditor(target, tab)
  );
}
