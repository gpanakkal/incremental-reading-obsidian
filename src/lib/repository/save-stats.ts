/**
 * A developer aid that counts database saves, to make a writer that saves too
 * often visible. Off unless this device's localStorage holds `'1'` under
 * {@link SAVE_STATS_FLAG}; turn it on from the dev console with
 * `localStorage.setItem('incremental-reading-save-stats', '1')`.
 *
 * Each save, and each write skipped because it changed nothing, is logged with
 * `console.debug` along with where it came from and how many the last minute
 * saw, and kept in `window.__irSaveStats`.
 */
export const SAVE_STATS_FLAG = 'incremental-reading-save-stats';

/** How far back {@link SaveStats.recent} reaches. */
export const SAVE_STATS_WINDOW_MS = 60_000;

export type SaveKind = 'saved' | 'skipped';

export interface SaveRecord {
  at: number;
  kind: SaveKind;
  /** The first stack frame outside the repository: the write's caller. */
  site: string;
}

export interface SaveStats {
  /** Records from the last {@link SAVE_STATS_WINDOW_MS}, oldest first. */
  recent: SaveRecord[];
  /** Counts since the stats were turned on, by kind then by site. */
  totals: Record<SaveKind, Record<string, number>>;
}

declare global {
  interface Window {
    __irSaveStats?: SaveStats;
  }
}

function enabled(): boolean {
  try {
    return window.localStorage.getItem(SAVE_STATS_FLAG) === '1';
  } catch {
    return false;
  }
}

/**
 * Frames that are the repository's own, or this module's. Matched loosely
 * since a minified build renames them; the counter is for dev builds.
 */
const OWN_FRAME = /Repository\.|ContentWatch|\brecordSave\b|^Error/;

/** The first frame of `stack` that isn't the repository's own. */
export function callSite(stack: string | undefined): string {
  const frame = (stack ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '' && !OWN_FRAME.test(line));
  return frame?.replace(/^at /, '') ?? 'unknown';
}

/** Note a save or a skipped one, when the counter is on. */
export function recordSave(kind: SaveKind, now = Date.now()): void {
  if (!enabled()) return;
  const stats = (window.__irSaveStats ??= {
    recent: [],
    totals: { saved: {}, skipped: {} },
  });
  const site = callSite(new Error().stack);
  stats.recent = stats.recent.filter(
    ({ at }) => now - at < SAVE_STATS_WINDOW_MS
  );
  stats.recent.push({ at: now, kind, site });
  stats.totals[kind][site] = (stats.totals[kind][site] ?? 0) + 1;
  const lastMinute = stats.recent.filter((record) => record.kind === kind);
  console.debug(`Incremental Reading - database write ${kind}`, {
    site,
    lastMinute: lastMinute.length,
  });
}
