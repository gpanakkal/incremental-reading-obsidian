/**
 * What code reads of an editor's window, `ownerDocument.defaultView`: the
 * events dispatched to it, and its timers, which are the global ones, so
 * `vi.useFakeTimers` fakes them as well.
 */
export function makeWindow() {
  return Object.assign(new EventTarget(), {
    setTimeout: (handler: () => void, ms?: number) => setTimeout(handler, ms),
    clearTimeout: (id?: ReturnType<typeof setTimeout>) => clearTimeout(id),
  });
}

/**
 * Another window plugin UI can open in (see `uiWindow`), a popout or
 * Settings: open, with OS focus or not, and an element in it to ask for UI
 * from. Its document points back at it, as a real one does, and holds only
 * what `uiWindow` reads of it.
 */
export function makeUiWindow({ focused = false } = {}) {
  const win = { closed: false } as unknown as Window;
  const doc = {
    nodeType: 9,
    ownerDocument: null,
    defaultView: win,
    hasFocus: () => focused,
  };
  Object.assign(win, { document: doc });
  const element = { nodeType: 1, ownerDocument: doc } as unknown as HTMLElement;
  return { win, element };
}
