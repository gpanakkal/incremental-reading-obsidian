import type { Tasks } from 'obsidian';

/**
 * Hand Obsidian's quit `work` to wait on, settled the same way as the work but
 * never before the task the quit began in has ended.
 *
 * Obsidian's `beforeunload` handler fires `quit`, cancels the unload when any
 * task was added, and calls `window.close()` once every task settles; its main
 * process destroys a closing window still open 3 s after the close began
 * (`registerQuitHook` and the `BrowserWindow` `close` handler, read from
 * obsidian.asar, 1.13; not documented). Tasks that all settle within microtasks
 * make that `window.close()` reach Electron before the cancelled
 * `beforeunload` has been answered. While the page has a `visibilitychange`
 * listener (see `registerPositionFlushes`), Electron answers a close by running
 * the page's unload-time handlers rather than closing outright, that request
 * merges into the `beforeunload` still pending, and the cancel then drops it:
 * every quit sat out the full 3 s (traced in e2e, 0186).
 *
 * A message-channel task rather than a timer: hidden windows throttle timers
 * to one a second.
 */
export function addQuitTask(
  tasks: Pick<Tasks, 'addPromise'>,
  work: Promise<unknown>
): void {
  tasks.addPromise(work.finally(nextTask));
}

/** Resolve in a task of its own, after every microtask queued before it. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(null);
  });
}
