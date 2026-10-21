import { refusedAction } from './readiness';
import type { SQLiteRepository } from './types';

/**
 * Run one step of a compensated operation: `run`, and once it has succeeded,
 * remember `undo` to take it back with what it returned, should a later step
 * fail.
 */
export type CompensatedStep = <T>(
  run: () => T | Promise<T>,
  undo: (result: T) => unknown
) => Promise<T>;

/**
 * Run an operation that touches both vault files and the database as ordered
 * steps, each with its undo. When a step, or the work between steps, throws,
 * the steps that completed are undone in reverse order and the error is
 * rethrown. Files and the database can't share a transaction; this is the
 * compensating kind instead.
 *
 * The database commit is the operation's last step and its commit point: once
 * it succeeds, nothing is undone. Work that may fail without undoing the
 * operation — fetching what was made, telling the user — runs after this
 * resolves, never inside `work` after the commit. The commit takes no undo of
 * its own: nothing follows it to fail. Several database writes for one
 * operation go in one `transaction`, so they commit as one.
 *
 * A crash between steps skips the undos. With the commit last, the most it can
 * leave is the files made before it, with no row.
 *
 * @param onUndoError told of each undo that fails; the others are still run,
 *   and the error rethrown is still the one that stopped the operation
 * @throws whatever stopped `work`, once its completed steps are undone
 */
export async function withCompensation<T>(
  work: (step: CompensatedStep) => Promise<T>,
  onUndoError: (error: unknown) => void = console.error
): Promise<T> {
  const undos: (() => unknown)[] = [];
  const step: CompensatedStep = async (run, undo) => {
    const result = await run();
    undos.push(() => undo(result));
    return result;
  };
  try {
    return await work(step);
  } catch (error) {
    for (const undo of undos.reverse()) {
      try {
        await undo();
      } catch (undoError) {
        onUndoError(undoError);
      }
    }
    throw error;
  }
}

/**
 * Check, before an operation touches any file, that the repository is ready
 * for it (see `refusedAction` in `readiness.ts`) — that its database write
 * won't be refused while saving is paused, nor dropped by a merge under way,
 * which it waits out for a moment first — and say so when it isn't. A refusal found only at the commit would have
 * the operation make its note and then take it back again.
 * @param action what was not done, as in "Couldn't {action}"
 * @returns whether the operation must not start
 */
export function refusedWrite(
  repo: SQLiteRepository,
  action: string
): Promise<boolean> {
  return refusedAction(repo, action);
}
