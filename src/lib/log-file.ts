import { normalizePath, type DataAdapter } from 'obsidian';
import { LOG_DIRECTORY } from './constants';

/**
 * The slice of the vault adapter a log is written through. The adapter rather
 * than Node's `fs`, so logging works on mobile too; and the adapter rather than
 * the vault, since {@link LOG_DIRECTORY} is a dot-folder the vault never
 * indexes.
 */
export type LogAdapter = Pick<
  DataAdapter,
  'exists' | 'mkdir' | 'write' | 'append'
>;

/**
 * The file a topic's entries made at `at` go to: one per topic per calendar
 * month, by local time, so no single file grows without bound and an old month
 * can be deleted by hand without touching the current one.
 */
export function logFilePath(topic: string, at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, '0');
  return normalizePath(
    `${LOG_DIRECTORY}/${topic}-${at.getFullYear()}-${month}.log`
  );
}

/**
 * The write in progress, which the next one waits on. Checking for a file and
 * then writing it are separate steps, so two writes let run side by side would
 * both find no file and the second would overwrite the first.
 */
let pending: Promise<void> = Promise.resolve();

/**
 * Add `entries` to `topic`'s log, one line each, stamped with `at`. Creates the
 * folder and the month's file as needed. Writes are made one at a time, in the
 * order they were asked for.
 *
 * A log is a record for later, never a step the caller depends on: a failed
 * write is reported to the console and otherwise swallowed.
 */
export function appendLog(
  adapter: LogAdapter,
  topic: string,
  entries: readonly string[],
  at: Date = new Date()
): Promise<void> {
  if (entries.length === 0) return Promise.resolve();
  const stamp = at.toISOString();
  const text = entries
    .map(
      (entry) => `${stamp} ${entry}
`
    )
    .join('');
  const path = logFilePath(topic, at);
  const write = async () => {
    try {
      const folder = normalizePath(LOG_DIRECTORY);
      if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
      if (await adapter.exists(path)) await adapter.append(path, text);
      else await adapter.write(path, text);
    } catch (error) {
      console.error(`Incremental Reading - failed to write to ${path}:`, error);
    }
  };
  pending = pending.then(write);
  return pending;
}
