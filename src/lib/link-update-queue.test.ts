import fc from 'fast-check';
import type { App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterLinkUpdates, batchAfterLinkUpdates } from './link-update-queue';

// #region HELPERS
/**
 * Obsidian's `FileManager.updateQueue`: each job runs once the one before has
 * settled. `hold` puts a job in it that waits until `release`, as a rename
 * waits on the prompt to update links.
 */
function makeQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  const queue = {
    queue: vi.fn((job: () => Promise<unknown>) => {
      const next = tail.then(job, job);
      tail = next;
      return next;
    }),
  };
  const hold = () => {
    let release!: () => void;
    void queue.queue(() => new Promise<void>((done) => (release = done)));
    return () => release();
  };
  /** Settles once every job queued so far has. */
  const drained = async () => {
    let seen: Promise<unknown>;
    do {
      seen = tail;
      await seen.catch(() => {});
    } while (seen !== tail);
  };
  return { queue, hold, drained };
}

const appWith = (fileManager: unknown) => ({ fileManager }) as unknown as App;

/** Let every promise already settled run its callbacks. */
const flush = () => new Promise<void>((done) => setTimeout(done, 0));

/** A promise of `items`, and what settles it. */
function later<T>(items: readonly T[]) {
  let settle!: () => void;
  const promise = new Promise<readonly T[]>(
    (done) => (settle = () => done(items))
  );
  return { promise, settle };
}

/** Some items, maybe none: the moves one rename gives. */
const itemsArb = fc.array(fc.anything(), { maxLength: 3 });
// #endregion

describe('batchAfterLinkUpdates', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hands over what it is given only once Obsidian's link update ahead of it is done, all of it in one batch", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(itemsArb, { minLength: 1 }), async (given) => {
        fc.pre(given.flat().length > 0);
        const { queue, hold, drained } = makeQueue();
        const run = vi.fn(async (_batch: unknown[]) => {});
        const follow = batchAfterLinkUpdates(
          appWith({ updateQueue: queue }),
          run
        );
        const release = hold();

        for (const items of given) follow(Promise.resolve(items));
        await flush();
        expect(run).not.toHaveBeenCalled();

        release();
        await drained();
        expect(run).toHaveBeenCalledExactlyOnceWith(given.flat());
      })
    );
  });

  it('waits for every promise given before its batch ran, however late it settles', async () => {
    const { queue, drained } = makeQueue();
    const run = vi.fn(async (_batch: unknown[]) => {});
    const follow = batchAfterLinkUpdates(appWith({ updateQueue: queue }), run);
    const first = later(['a']);
    const second = later(['b', 'c']);

    follow(first.promise);
    follow(second.promise);
    await flush();
    second.settle();
    await flush();
    expect(run).not.toHaveBeenCalled();

    first.settle();
    await drained();
    expect(run).toHaveBeenCalledExactlyOnceWith(['a', 'b', 'c']);
  });

  it('hands each item over exactly once and in order, however the queue drains between them', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.record({ items: itemsArb }),
            fc.constant('drain' as const)
          )
        ),
        async (steps) => {
          const { queue, drained } = makeQueue();
          const batches: unknown[][] = [];
          const follow = batchAfterLinkUpdates(
            appWith({ updateQueue: queue }),
            async (batch) => {
              batches.push(batch);
            }
          );

          for (const step of steps) {
            if (step === 'drain') await drained();
            else follow(Promise.resolve(step.items));
          }
          await drained();

          const items = steps.flatMap((step) =>
            step === 'drain' ? [] : step.items
          );
          expect(batches.flat()).toStrictEqual(items);
          // Never called for a batch of nothing
          expect(batches.every((batch) => batch.length > 0)).toBe(true);
          // One job per batch given, so nothing else of Obsidian's waits on more
          const runs = steps.reduce<{ waiting: boolean; jobs: number }>(
            ({ waiting, jobs }, step) =>
              step === 'drain'
                ? { waiting: false, jobs }
                : { waiting: true, jobs: waiting ? jobs : jobs + 1 },
            { waiting: false, jobs: 0 }
          ).jobs;
          expect(queue.queue).toHaveBeenCalledTimes(runs);
        }
      )
    );
  });

  it('takes nothing from a promise that rejects, and runs the rest', async () => {
    const { queue, drained } = makeQueue();
    const run = vi.fn(async (_batch: unknown[]) => {});
    const follow = batchAfterLinkUpdates(appWith({ updateQueue: queue }), run);

    follow(Promise.reject(new Error('no file there')));
    follow(Promise.resolve(['a']));
    await drained();

    expect(run).toHaveBeenCalledExactlyOnceWith(['a']);
  });

  it('logs a batch that fails, without failing the queue or the batches after it', async () => {
    const { queue, drained } = makeQueue();
    const failure = new Error('bad YAML');
    const run = vi
      .fn<(batch: unknown[]) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const follow = batchAfterLinkUpdates(appWith({ updateQueue: queue }), run);

    follow(Promise.resolve(['a']));
    await drained();
    follow(Promise.resolve(['b']));
    await drained();

    expect(error).toHaveBeenCalledExactlyOnceWith(failure);
    expect(run.mock.calls).toStrictEqual([[['a']], [['b']]]);
    await expect(queue.queue.mock.results[0].value).resolves.toBeUndefined();
  });

  it('runs at once, still batching what one moment hands it, where Obsidian has no queue to wait on', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          undefined,
          {},
          { updateQueue: null },
          { updateQueue: {} },
          { updateQueue: { queue: 'not a function' } }
        ),
        fc.array(fc.anything(), { minLength: 1 }),
        async (fileManager, items) => {
          const run = vi.fn(async (_batch: unknown[]) => {});
          const follow = batchAfterLinkUpdates(appWith(fileManager), run);

          for (const item of items) follow(Promise.resolve([item]));
          await flush();

          expect(run).toHaveBeenCalledExactlyOnceWith(items);
        }
      )
    );
  });
});

describe('afterLinkUpdates', () => {
  it('settles only once every link update queued before it is done, one that failed too', async () => {
    const { queue, hold, drained } = makeQueue();
    void queue.queue(() => Promise.reject(new Error('rename failed')));
    const release = hold();
    let settled = false;

    void afterLinkUpdates(appWith({ updateQueue: queue })).then(
      () => (settled = true)
    );
    await flush();
    expect(settled).toBe(false);

    release();
    await drained();
    expect(settled).toBe(true);
  });

  it('settles as soon as the moment that asked is over, where Obsidian has no queue to wait on', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          undefined,
          {},
          { updateQueue: null },
          { updateQueue: {} },
          { updateQueue: { queue: 'not a function' } }
        ),
        async (fileManager) => {
          await expect(
            afterLinkUpdates(appWith(fileManager))
          ).resolves.toBeUndefined();
        }
      )
    );
  });
});
