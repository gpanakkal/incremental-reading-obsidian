import { ObsidianHelpers as Obsidian } from './ObsidianHelpers';
import type { Readiness, SQLiteRepository } from './types';

export type { Readiness } from './types';

/**
 * What an action does, as far as the readiness gate cares:
 * - `multi-step` writes notes or other files as well as rows (import,
 *   un-import, snippet and card creation, delete, undo), so one let through
 *   while the database is not ready could be left half-applied: a note
 *   written without its row.
 * - `db-write` writes rows and nothing else before them (grade, mark
 *   reviewed, dismiss, priority and scheduling edits), or follows something
 *   that already happened to a file (a rename), so waiting it out costs
 *   nothing on disk.
 */
export type ActionKind = 'multi-step' | 'db-write';

/**
 * What the gate makes of an action: go ahead, refuse it, or hold it until the
 * merge under way is over and ask again, once.
 */
export type GateDecision = 'allow' | 'refuse' | 'retry-after';

/**
 * The readiness gate: whether an action of `kind` may start while the
 * repository is `state`. Pure reads never ask.
 *
 * A merge lasts tens of milliseconds, so a plain database write is held over
 * it rather than refused; anything that writes files is refused, as its first
 * file write can't wait on the merge without leaving the action part done
 * (its entry check waits a short merge out first, see `refusedAction`).
 * `starting` can last indefinitely (a file that won't load, a migration
 * failure), so it refuses everything.
 */
export function gate(state: Readiness, kind: ActionKind): GateDecision {
  if (state === 'ready') return 'allow';
  if (state === 'merging' && kind === 'db-write') return 'retry-after';
  return 'refuse';
}

/**
 * Why an action can't start in `state`, in brief, for a batch whose outcomes
 * each carry a reason. Anything but `merging` reads as saving being paused,
 * the wording of the write block (see `SQLJSRepository.blockWrites`).
 */
export function refusalReason(state: Readiness): string {
  return state === 'merging'
    ? 'the review database is taking in changes from another device'
    : 'saving to the database is paused';
}

/**
 * What the user is told when an action is refused.
 * @param state why it was refused (see {@link refusalReason})
 * @param action what was not done, as in "Couldn't {action}"
 * @param refusal why writes are refused, if they are
 */
export function refusalMessage(
  state: Readiness,
  action: string,
  refusal: Error | null
): string {
  const why = `Couldn't ${action}: ${refusalReason(state)}.`;
  if (state === 'merging') return `${why} Try again in a moment.`;
  return refusal ? `${why} ${refusal.message}` : why;
}

/** Thrown by {@link assertReady} for an action the gate refused. */
export class ActionRefusedError extends Error {
  constructor(action: string) {
    super(`Refused: ${action}`);
    this.name = 'ActionRefusedError';
  }
}

/** Whether `error` is the gate's refusal, the user already told why. */
export function isRefusal(error: unknown): error is ActionRefusedError {
  return error instanceof ActionRefusedError;
}

type ReadinessSource = Pick<
  SQLiteRepository,
  'readiness' | 'onReadinessChange' | 'writeRefusal'
>;

function tellRefused(repo: ReadinessSource, state: Readiness, action: string) {
  Obsidian.notify(refusalMessage(state, action, repo.writeRefusal()), {
    kind: 'error',
  });
}

/**
 * How long, in milliseconds, an action that writes files waits for a merge
 * under way to end before it is refused (see {@link refusedAction}). Every
 * save of this device's own is read back from disk as a merge would be, so a
 * merge is often under way just after a grade, when the user's next click
 * comes; it lasts tens of milliseconds, far less than this.
 */
export const MERGE_WAIT_MS = 1000;

/**
 * Check, at the entry of an action that writes files as well as rows, that
 * the repository is ready, and say why when it isn't. Before anything is
 * touched, a merge under way is waited out for up to {@link MERGE_WAIT_MS};
 * the action is refused if it is still under way by then, or at once while
 * saving is paused.
 * @param action what was not done, as in "Couldn't {action}"
 * @returns whether the action must not start
 */
export async function refusedAction(
  repo: ReadinessSource,
  action: string
): Promise<boolean> {
  const state = await outlastMerge(repo, MERGE_WAIT_MS);
  if (gate(state, 'multi-step') === 'allow') return false;
  tellRefused(repo, state, action);
  return true;
}

/**
 * Resolve with the first state `repo` leaves merging for, or with `merging`
 * once `bound` milliseconds pass first.
 */
function afterMerge(
  repo: Pick<ReadinessSource, 'readiness' | 'onReadinessChange'>,
  bound = Infinity
): Promise<Readiness> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const end = (state: Readiness) => {
      stop();
      clearTimeout(timer);
      resolve(state);
    };
    const stop = repo.onReadinessChange((state) => {
      if (state !== 'merging') end(state);
    });
    // The global timer, not `window`'s (the lint rule's ask): the same main
    // window's in the app, and the wait belongs to no view a popout could
    // close; but there in every test environment, DOM or none, which a
    // merge can coincide with a multi-step action in
    if (bound !== Infinity) timer = setTimeout(() => end('merging'), bound);
  });
}

/**
 * Wait out a merge under way, if any, before work that has touched nothing
 * yet — a background import, say, or a multi-step action's check — so a
 * merge's tens of milliseconds don't fail it.
 * @param bound how long to wait at most, in milliseconds
 * @returns the state once no merge is under way, or `merging` after `bound`,
 *   for the work's own check
 */
export function outlastMerge(
  repo: Pick<ReadinessSource, 'readiness' | 'onReadinessChange'>,
  bound = Infinity
): Promise<Readiness> {
  const state = repo.readiness;
  return state === 'merging' ? afterMerge(repo, bound) : Promise.resolve(state);
}

/**
 * Check, at the entry of an action of `kind`, that the repository is ready,
 * and say why when it isn't. A plain database write that comes during a
 * merge is held until the merge ends, then let through if the repository is
 * ready by then; it is never held twice.
 * @param action what was not done, as in "Couldn't {action}"
 * @returns whether to go ahead
 */
export async function requireReady(
  repo: ReadinessSource,
  kind: ActionKind,
  action: string
): Promise<boolean> {
  let state = repo.readiness;
  if (gate(state, kind) === 'retry-after') state = await afterMerge(repo);
  if (gate(state, kind) === 'allow') return true;
  tellRefused(repo, state, action);
  return false;
}

/**
 * {@link requireReady}, throwing instead of answering false, for an action
 * whose callers go on to report success.
 * @throws {ActionRefusedError} once the user has been told why
 */
export async function assertReady(
  repo: ReadinessSource,
  kind: ActionKind,
  action: string
): Promise<void> {
  if (!(await requireReady(repo, kind, action))) {
    throw new ActionRefusedError(action);
  }
}

/**
 * Follow something that already happened to a file — a rename, a deletion —
 * in the database: at once while the repository is ready, with no microtask
 * between the check and `run` (renames batch by arriving together), or once
 * a merge under way ends. There is nothing to refuse before, as the file has
 * changed already, so nothing is said; while saving is paused `run` is
 * skipped, as its writes would be refused all the same, and the write block
 * says so (see `SQLJSRepository.blockWrites`).
 */
export function followWhenReady(repo: ReadinessSource, run: () => void): void {
  const decision = gate(repo.readiness, 'db-write');
  if (decision === 'allow') {
    run();
    return;
  }
  if (decision === 'refuse') return;
  void afterMerge(repo).then((state) => {
    if (gate(state, 'db-write') === 'allow') run();
  });
}
