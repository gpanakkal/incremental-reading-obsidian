import type { App } from 'obsidian';

/** A queue that runs each job once the one before it has settled. */
interface PromisedQueue {
  queue(job: () => Promise<void>): Promise<void>;
}

/**
 * Obsidian's own queue of link updates, or null where it has none.
 *
 * Undocumented: `FileManager.renameFile` runs each rename on
 * `fileManager.updateQueue` (typed `PromisedQueue` in obsidian-typings, a bare
 * `promise.then(job, job)` chain in the bundle), in one job that renames the
 * file (firing `rename`), then updates the links to it: at once with
 * "Automatically update internal links" on, else after its prompt is answered,
 * which keeps the job open until then.
 */
function linkUpdateQueue(app: App): PromisedQueue | null {
  const { updateQueue } = (app.fileManager ?? {}) as {
    updateQueue?: Partial<PromisedQueue> | null;
  };
  return typeof updateQueue?.queue === 'function'
    ? (updateQueue as PromisedQueue)
    : null;
}

/**
 * Settles once every link update queued so far is done, the rename running
 * now included, failed or not: a job of nothing queued after them. Where
 * Obsidian has no queue, once the moment that asked is over.
 *
 * Not to be awaited inside a job on Obsidian's queue, which it would wait
 * behind.
 */
export function afterLinkUpdates(app: App): Promise<void> {
  const queue = linkUpdateQueue(app);
  return queue ? queue.queue(async () => {}) : Promise.resolve();
}

/**
 * Gather what the returned function is given and hand it to `run` in batches,
 * each once Obsidian's own link update for the rename that gave it is done:
 * links it updates are then already right, and a note it would rewrite by
 * offset is not written under it first.
 *
 * Each call gives a promise of items, made at once and settling once they are
 * known: a rename event's handler gives its promise before its first `await`,
 * so the handlers of every file of a renamed folder, whose events Obsidian
 * fires all together, give theirs to one batch, which waits on them all. A
 * promise that rejects gives nothing; its caller sees the failure. Where
 * Obsidian has no queue to wait on, a batch runs as soon as the moment that
 * gave it is over.
 *
 * `run` must not itself wait on Obsidian's queue (by `FileManager.renameFile`,
 * say), since its own job holds it. It is not called for a batch of nothing.
 * A batch that fails is logged.
 */
export function batchAfterLinkUpdates<T>(
  app: App,
  run: (batch: T[]) => Promise<unknown>
): (items: Promise<readonly T[]>) => void {
  let pending: Promise<readonly T[]>[] = [];
  const job = async () => {
    const given = pending;
    pending = [];
    try {
      const batch = (await Promise.allSettled(given)).flatMap((result) =>
        result.status === 'fulfilled' ? result.value : []
      );
      if (batch.length > 0) await run(batch);
    } catch (error) {
      console.error(error);
    }
  };
  return (items) => {
    pending.push(items);
    // A job already waits for the ones before it, and takes this along
    if (pending.length > 1) return;
    const queue = linkUpdateQueue(app);
    if (queue) void queue.queue(job);
    else void Promise.resolve().then(job);
  };
}
