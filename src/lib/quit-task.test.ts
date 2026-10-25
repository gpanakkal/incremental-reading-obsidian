// @vitest-environment jsdom
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addQuitTask } from './quit-task';

// #region HELPERS

/** A promise settled from outside, as the work a quit waits on. */
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type State = { status: 'pending' | 'fulfilled' | 'rejected'; v?: unknown };

/** What `promise` has settled to so far, and a wait for it to settle. */
function track(promise: Promise<unknown>) {
  const state: State = { status: 'pending' };
  const settled = promise.then(
    (v) => Object.assign(state, { status: 'fulfilled', v }),
    (v: unknown) => Object.assign(state, { status: 'rejected', v })
  );
  return { state, settled };
}

/** The one promise `addQuitTask` handed the quit, for `work`. */
function handed(work: Promise<unknown>) {
  const addPromise = vi.fn();
  addQuitTask({ addPromise }, work);
  expect(addPromise).toHaveBeenCalledOnce();
  return addPromise.mock.calls[0][0] as Promise<unknown>;
}

/** Run every microtask queued so far, and those they queue, but no task. */
async function drainMicrotasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** A task of its own, after the ones already queued. */
function nextMacrotask() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

const outcome = fc.record({
  fulfilled: fc.boolean(),
  value: fc.anything(),
});

// #endregion

describe('addQuitTask', () => {
  beforeEach(() => {
    // Frozen: the quit must not wait on a timer, which a hidden window throttles
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('settles as the work did, in a task after it, with no timer', async () => {
    await fc.assert(
      fc.asyncProperty(outcome, async ({ fulfilled, value }) => {
        const work = deferred();
        const { state, settled } = track(handed(work.promise));

        await nextMacrotask();
        expect(state.status).toBe('pending');

        if (fulfilled) work.resolve(value);
        else work.reject(value);
        await drainMicrotasks();
        expect(state.status).toBe('pending');

        await settled;
        expect(state).toEqual({
          status: fulfilled ? 'fulfilled' : 'rejected',
          v: value,
        });
      })
    );
  });

  it('waits a task even for work already settled', async () => {
    const { state, settled } = track(handed(Promise.resolve('done')));
    await drainMicrotasks();
    expect(state.status).toBe('pending');
    await settled;
    expect(state).toEqual({ status: 'fulfilled', v: 'done' });
  });

  it('lets go of the channel it waited on', async () => {
    const close = vi.spyOn(MessagePort.prototype, 'close');
    await handed(Promise.resolve());
    expect(close).toHaveBeenCalledOnce();
  });
});
