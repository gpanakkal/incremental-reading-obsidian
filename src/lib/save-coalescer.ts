/**
 * Runs `save` whenever asked, but never two at once: a request that arrives
 * while a save is running is folded into a single follow-up that starts once
 * the running one settles, however many requests arrived in between.
 *
 * `save` is expected to read whatever it persists at the moment it is called,
 * not when it was requested, so the follow-up writes the newest state and the
 * requests it absorbed lose nothing.
 *
 * This is what keeps typing in the review editor from saving the note once per
 * keystroke. Each save writes the note and its highlight offsets to disk and
 * sets off everything that reacts to a write (Obsidian's metadata re-parse,
 * the plugin's own `modify` and `changed` handlers, a re-render of the review
 * pane). Fired per keystroke, those overlap and pile up whenever a save takes
 * longer than the gap between keys — the common case on mobile — and the
 * keys typed meanwhile wait behind them on the main thread. Coalesced, the
 * number of saves tracks how long a save takes rather than how fast the user
 * types, and the note on disk is never more than one save behind the editor.
 *
 * A failing `save` is reported to `onError` and does not stop a follow-up.
 */
export function createSaveCoalescer(
  save: () => Promise<void>,
  onError: (error: unknown) => void
) {
  let running: Promise<void> | null = null;
  let requested = false;

  const drain = async () => {
    while (requested) {
      requested = false;
      try {
        await save();
      } catch (error) {
        onError(error);
      }
    }
    running = null;
  };

  return {
    /**
     * Ask for a save. Resolves once a save that started after this request
     * has settled.
     */
    request(): Promise<void> {
      requested = true;
      // Started a microtask later so `running` is already set by the time
      // `save` runs: a request made from inside `save` joins this run rather
      // than starting a second one alongside it.
      running ??= Promise.resolve().then(drain);
      return running;
    },
  };
}
