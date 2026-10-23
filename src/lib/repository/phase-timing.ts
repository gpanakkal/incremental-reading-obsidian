/**
 * A hook a benchmark sets to time the phases of a reload (0184), told the
 * name of each phase as it ends. Unset, as the plugin leaves it, each mark
 * costs one property read.
 *
 * A reload marks `start` before it reads the file and `end` once it is over;
 * every database save marks `export`, then `save` as it calls `writeBinary`
 * and `write` once that resolves, inside a reload or not.
 */
export const phaseTiming: { mark: ((phase: string) => void) | null } = {
  mark: null,
};

/** Tell {@link phaseTiming} that `phase` just ended. */
export function markPhase(phase: string) {
  phaseTiming.mark?.(phase);
}

/**
 * A developer switch, read once at load: `'1'` in this device's localStorage
 * under this key logs a line per reload of the database file (see
 * {@link reloadTimingLog}). Turn it on from the dev console with
 * `localStorage.setItem('incremental-reading-debug-timing', '1')`, then
 * reload the plugin.
 */
export const DEBUG_TIMING_FLAG = 'incremental-reading-debug-timing';

/** How long saves must stop for after a reload before its line is logged. */
export const QUIET_AFTER_RELOAD_MS = 2000;

/** Marks that are saves, which run alongside a reload's phases. */
const SAVE_MARKS: readonly string[] = ['export', 'save', 'write'];

interface Clock {
  now: () => number;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
}

const realClock: Clock = {
  now: () => performance.now(),
  setTimeout: (run, ms) => window.setTimeout(run, ms),
  clearTimeout: (timer) => window.clearTimeout(timer as number),
};

/**
 * A {@link phaseTiming} hook that logs one line per reload: how long each of
 * its phases took, its total, and when each database write was asked for,
 * counted from the reload's start until saves have stopped for
 * {@link QUIET_AFTER_RELOAD_MS} (each one a file Sync must upload again).
 * A reload that starts meanwhile, as the read of the merge's own save coming
 * back does, gets a line of its own, and a write then counts in both. Marks
 * outside a reload are ignored.
 */
export function reloadTimingLog(
  log: (line: string) => void,
  clock: Clock = realClock
): (phase: string) => void {
  interface Reload {
    started: number;
    last: number;
    phases: [string, number][];
    total: number | null;
    writes: number[];
    timer: unknown;
  }
  /** Reloads not yet logged, oldest first; only the newest can be running. */
  const open: Reload[] = [];

  const report = (reload: Reload) => {
    open.splice(open.indexOf(reload), 1);
    const { phases, total, writes } = reload;
    const ms = (n: number) => (n < 10 ? n.toFixed(1) : Math.round(n));
    const table = phases.map(([name, took]) => `${name} ${ms(took)}`);
    const at = writes.map((w) => `+${Math.round(w)}`).join(', ');
    log(
      `Incremental Reading - reload ${ms(total ?? 0)} ms ` +
        `(${table.join(', ')}); ${writes.length} database ` +
        `${writes.length === 1 ? 'write' : 'writes'}` +
        (writes.length > 0 ? ` at ${at} ms` : '')
    );
  };

  const waitForQuiet = (reload: Reload) => {
    clock.clearTimeout(reload.timer);
    reload.timer = clock.setTimeout(
      () => report(reload),
      QUIET_AFTER_RELOAD_MS
    );
  };

  return (phase) => {
    const now = clock.now();
    if (phase === 'start') {
      open.push({
        started: now,
        last: now,
        phases: [],
        total: null,
        writes: [],
        timer: null,
      });
      return;
    }
    // Counted as the write is asked for: the modify event it raises can
    // start the next reload before it resolves
    if (phase === 'save') {
      for (const reload of open) {
        reload.writes.push(now - reload.started);
        if (reload.total !== null) waitForQuiet(reload);
      }
      return;
    }
    const running = open[open.length - 1];
    if (!running || running.total !== null || SAVE_MARKS.includes(phase)) {
      return;
    }
    if (phase === 'end') {
      running.total = now - running.started;
      waitForQuiet(running);
      return;
    }
    running.phases.push([phase, now - running.last]);
    running.last = now;
  };
}

/**
 * Log reload timings (see {@link reloadTimingLog}) with `console.debug` when
 * {@link DEBUG_TIMING_FLAG} is on. Called once at load; off, it sets nothing.
 * @param storage where the switch is read from
 * @returns what turns the logging off again, for unload
 */
export function enableDebugTiming(
  storage: () => Pick<Storage, 'getItem'> = () => window.localStorage
): () => void {
  let on = false;
  try {
    on = storage().getItem(DEBUG_TIMING_FLAG) === '1';
  } catch {
    // Storage that throws (blocked site data) leaves the switch off
  }
  if (!on) return () => {};
  const mark = reloadTimingLog((line) => console.debug(line));
  phaseTiming.mark = mark;
  return () => {
    if (phaseTiming.mark === mark) phaseTiming.mark = null;
  };
}
