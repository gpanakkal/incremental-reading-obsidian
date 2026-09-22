/**
 * Longest a yield waits for the host to go idle before running anyway. Kept
 * short: a caller holding a transaction open across a yield holds it for this.
 */
export const IDLE_TIMEOUT_MS = 100;

/**
 * Let everything else waiting on the thread go first: Obsidian's own work, the
 * editor, other plugins. Waits for an idle period, or the next macrotask where
 * the host has none — WebKit, so iOS, lacks `requestIdleCallback`.
 *
 * The plugin's own `window`, not `activeWindow`: a popout closing mid-run would
 * drop its timers and leave the run suspended for good.
 */
export function yieldToHost(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => resolve(), { timeout: IDLE_TIMEOUT_MS });
    } else {
      window.setTimeout(resolve, 0);
    }
  });
}
