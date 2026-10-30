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
