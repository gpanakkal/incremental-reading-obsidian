// Keyboard focus for the review tab's editor, kept the way a note tab keeps it.
//
// A note tab has one editor for every note it shows, so focus stays put when
// the tab moves to another note. Review builds a new editor for each item, and
// the focused one going takes focus with it. Undo then reaches no editor at
// all: Electron's Edit menu turns the keystroke into the page's native undo,
// which lands on whatever contenteditable Chromium last recorded typing in.

/**
 * Whether ephemeral state asks the view to focus its editor, read as Obsidian's
 * own edit view reads it: `focus` (which `focusLeaf` passes when a tab is
 * brought forward), and on mobile only when `focusOnMobile` asks as well, so
 * opening a note doesn't raise the keyboard.
 *
 * Undocumented: read from obsidian.asar 1.14.5 (the edit view's `setState`,
 * which `MarkdownView.setEphemeralState` calls).
 */
export function asksForFocus(eState: unknown, isMobile: boolean): boolean {
  if (typeof eState !== 'object' || eState === null) return false;
  const { focus, focusOnMobile } = eState as {
    focus?: unknown;
    focusOnMobile?: unknown;
  };
  return Boolean(focus) && (!isMobile || Boolean(focusOnMobile));
}

/**
 * Hands keyboard focus from the editor of the item review leaves to the editor
 * of the item it arrives at. The leaving editor reports whether it held focus;
 * the next one to mount takes it, unless something else took it in between.
 * Never on mobile, where focus raises the keyboard.
 */
export class EditorFocusHandoff {
  #pending = false;

  /** The leaving editor, as it goes: whether it held focus. */
  release(held: boolean, isMobile: boolean): void {
    this.#pending = held && !isMobile;
  }

  /** Focus went somewhere in the tab: there is nothing to hand over. */
  cancel(): void {
    this.#pending = false;
  }

  /**
   * The arriving editor, as it mounts: whether to take focus. Answers yes once
   * per release, and only while nothing in `doc` holds focus, since a reader
   * who has clicked into something else since has put it there.
   */
  claim(doc: Document): boolean {
    const pending = this.#pending;
    this.#pending = false;
    return (
      pending && (doc.activeElement === null || doc.activeElement === doc.body)
    );
  }
}
