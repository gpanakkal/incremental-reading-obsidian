import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObsidianHelpers as Obsidian } from './ObsidianHelpers';
import {
  type ActionKind,
  ActionRefusedError,
  assertReady,
  followWhenReady,
  gate,
  isRefusal,
  MERGE_WAIT_MS,
  outlastMerge,
  refusalMessage,
  refusalReason,
  refusedAction,
  requireReady,
} from './readiness';
import type { Readiness } from './types';

// #region HELPERS

const STATES: readonly Readiness[] = ['starting', 'merging', 'ready'];
const KINDS: readonly ActionKind[] = ['multi-step', 'db-write'];
const stateArb = fc.constantFrom(...STATES);
const kindArb = fc.constantFrom(...KINDS);
/** States a merge can end in. */
const endArb = fc.constantFrom<Readiness>('ready', 'starting');
/** Action text as callers word it: anything, the gate never reads it. */
const actionArb = fc.string({ minLength: 1 });

/**
 * A repository whose readiness the test sets with `becomes`, telling its
 * listeners as the real one does, refusing writes with `refusal` while
 * `starting`.
 */
function makeRepo(state: Readiness, refusal: Error | null = null) {
  const listeners = new Set<(state: Readiness) => void>();
  const repo = {
    readiness: state,
    writeRefusal: () => (repo.readiness === 'starting' ? refusal : null),
    onReadinessChange: (listener: (state: Readiness) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    becomes(next: Readiness) {
      repo.readiness = next;
      for (const listener of [...listeners]) listener(next);
    },
    listenerCount: () => listeners.size,
  };
  return repo;
}

/** Spy on notices, fresh per property case (counts outlive `it`'s cases). */
function spyNotify() {
  vi.restoreAllMocks();
  return vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
}

/** Let every queued microtask run. */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('gate', () => {
  it('property: allows every action when ready, and only then', () => {
    fc.assert(
      fc.property(stateArb, kindArb, (state, kind) => {
        expect(gate(state, kind) === 'allow').toBe(state === 'ready');
      })
    );
  });

  it('property: holds over a merge only a plain database write', () => {
    fc.assert(
      fc.property(stateArb, kindArb, (state, kind) => {
        expect(gate(state, kind) === 'retry-after').toBe(
          state === 'merging' && kind === 'db-write'
        );
      })
    );
  });

  it('property: refuses everything while starting, and a multi-step action while merging', () => {
    fc.assert(
      fc.property(stateArb, kindArb, (state, kind) => {
        expect(gate(state, kind) === 'refuse').toBe(
          state === 'starting' || (state === 'merging' && kind === 'multi-step')
        );
      })
    );
  });
});

describe('refusalMessage', () => {
  it('property: names the action and why, and while merging tells to try again rather than why writes are refused', () => {
    fc.assert(
      fc.property(stateArb, actionArb, fc.string(), (state, action, why) => {
        const message = refusalMessage(state, action, new Error(why));

        expect(message.startsWith(`Couldn't ${action}: `)).toBe(true);
        expect(message).toContain(refusalReason(state));
        if (state === 'merging') {
          expect(message).toMatch(/try again/i);
          expect(message).toBe(refusalMessage(state, action, null));
        } else {
          expect(message.endsWith(`. ${why}`)).toBe(true);
        }
      })
    );
  });

  it('property: adds nothing past the reason while writes are allowed', () => {
    fc.assert(
      fc.property(stateArb, actionArb, (state, action) => {
        const message = refusalMessage(state, action, null);

        expect(message.startsWith(`Couldn't ${action}: `)).toBe(true);
        if (state !== 'merging') {
          expect(message.endsWith(`${refusalReason(state)}.`)).toBe(true);
        }
      })
    );
  });

  it('tells a merge from paused saving', () => {
    expect(refusalReason('merging')).not.toBe(refusalReason('starting'));
    expect(refusalReason('ready')).toBe(refusalReason('starting'));
    // The write block's own wording, which `starting` keeps (0171)
    expect(refusalReason('starting')).toMatch(/paused/);
  });
});

describe('refusedAction', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('property: answers at once as the gate does while no merge is under way, saying why once, and nothing when it allows', async () => {
    await fc.assert(
      fc.asyncProperty(
        endArb,
        actionArb,
        fc.string(),
        async (state, action, why) => {
          const notify = spyNotify();
          const repo = makeRepo(state, new Error(why));

          const refused = await refusedAction(repo, action);

          const expected = gate(state, 'multi-step') !== 'allow';
          expect(refused).toBe(expected);
          if (expected) {
            expect(notify).toHaveBeenCalledExactlyOnceWith(
              refusalMessage(state, action, repo.writeRefusal()),
              { kind: 'error' }
            );
          } else {
            expect(notify).not.toHaveBeenCalled();
          }
          expect(repo.listenerCount()).toBe(0);
          expect(vi.getTimerCount()).toBe(0);
        }
      )
    );
  });

  it('property: waits out a merge that ends within the wait, then answers as the gate does for the state it ends in', async () => {
    await fc.assert(
      fc.asyncProperty(
        endArb,
        fc.integer({ min: 0, max: MERGE_WAIT_MS - 1 }),
        actionArb,
        async (after, waited, action) => {
          const notify = spyNotify();
          const repo = makeRepo('merging', new Error('paused'));
          let answer: boolean | null = null;

          void refusedAction(repo, action).then(
            (refused) => (answer = refused)
          );
          await vi.advanceTimersByTimeAsync(waited);
          expect(answer).toBeNull();
          expect(notify).not.toHaveBeenCalled();
          repo.becomes(after);
          await flush();

          expect(answer).toBe(after !== 'ready');
          if (after === 'ready') {
            expect(notify).not.toHaveBeenCalled();
          } else {
            expect(notify).toHaveBeenCalledExactlyOnceWith(
              refusalMessage(after, action, repo.writeRefusal()),
              { kind: 'error' }
            );
          }
          // Done with: neither the merge nor the wait asks anything again
          expect(repo.listenerCount()).toBe(0);
          expect(vi.getTimerCount()).toBe(0);
        }
      )
    );
  });

  it('property: refuses, saying a merge is under way, once it outlasts the wait, and says nothing more when it ends', async () => {
    await fc.assert(
      fc.asyncProperty(endArb, actionArb, async (after, action) => {
        const notify = spyNotify();
        const repo = makeRepo('merging');
        let answer: boolean | null = null;

        void refusedAction(repo, action).then((refused) => (answer = refused));
        await vi.advanceTimersByTimeAsync(MERGE_WAIT_MS - 1);
        expect(answer).toBeNull();
        await vi.advanceTimersByTimeAsync(1);

        expect(answer).toBe(true);
        expect(notify).toHaveBeenCalledExactlyOnceWith(
          refusalMessage('merging', action, null),
          { kind: 'error' }
        );
        expect(repo.listenerCount()).toBe(0);
        repo.becomes(after);
        await flush();
        expect(notify).toHaveBeenCalledOnce();
      })
    );
  });
});

describe('requireReady', () => {
  it('property: answers at once as the gate does, unless it holds the action', async () => {
    await fc.assert(
      fc.asyncProperty(
        stateArb,
        kindArb,
        actionArb,
        async (state, kind, action) => {
          fc.pre(gate(state, kind) !== 'retry-after');
          const notify = spyNotify();
          const repo = makeRepo(state, new Error('paused'));

          const allowed = await requireReady(repo, kind, action);

          expect(allowed).toBe(state === 'ready');
          if (allowed) {
            expect(notify).not.toHaveBeenCalled();
          } else {
            expect(notify).toHaveBeenCalledExactlyOnceWith(
              refusalMessage(state, action, repo.writeRefusal()),
              { kind: 'error' }
            );
          }
          expect(repo.listenerCount()).toBe(0);
        }
      )
    );
  });

  it('property: holds a plain database write over a merge, then lets it through once ready, or refuses it, without holding it twice', async () => {
    await fc.assert(
      fc.asyncProperty(endArb, actionArb, async (after, action) => {
        const notify = spyNotify();
        const repo = makeRepo('merging', new Error('paused'));
        let answer: boolean | null = null;

        void requireReady(repo, 'db-write', action).then(
          (allowed) => (answer = allowed)
        );
        await flush();
        expect(answer).toBeNull();
        // Another merge on the heels of the first is no end to it
        repo.becomes('merging');
        await flush();
        expect(answer).toBeNull();
        repo.becomes(after);
        await flush();

        expect(answer).toBe(after === 'ready');
        if (after === 'ready') {
          expect(notify).not.toHaveBeenCalled();
        } else {
          expect(notify).toHaveBeenCalledExactlyOnceWith(
            refusalMessage(after, action, repo.writeRefusal()),
            { kind: 'error' }
          );
        }
        // Done with: later changes ask nothing again
        expect(repo.listenerCount()).toBe(0);
      })
    );
  });
});

describe('assertReady', () => {
  it('resolves for an action it allows', async () => {
    await expect(
      assertReady(makeRepo('ready'), 'multi-step', 'import')
    ).resolves.toBeUndefined();
  });

  it('property: throws a refusal naming the action for one it refuses', async () => {
    await fc.assert(
      fc.asyncProperty(kindArb, actionArb, async (kind, action) => {
        spyNotify();

        const error = await assertReady(
          makeRepo('starting'),
          kind,
          action
        ).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ActionRefusedError);
        expect(isRefusal(error)).toBe(true);
        expect((error as Error).message).toContain(action);
        expect((error as Error).name).toBe('ActionRefusedError');
      })
    );
  });

  it('takes no other error for a refusal', () => {
    expect(isRefusal(new Error('Refused: import'))).toBe(false);
    expect(isRefusal(null)).toBe(false);
  });
});

describe('outlastMerge', () => {
  it('property: answers the state at once while no merge is under way', async () => {
    await fc.assert(
      fc.asyncProperty(endArb, async (state) => {
        const repo = makeRepo(state);

        await expect(outlastMerge(repo)).resolves.toBe(state);
        expect(repo.listenerCount()).toBe(0);
      })
    );
  });

  it('property: answers the first state a merge ends in', async () => {
    await fc.assert(
      fc.asyncProperty(endArb, async (after) => {
        const repo = makeRepo('merging');
        let answer: Readiness | null = null;

        void outlastMerge(repo).then((state) => (answer = state));
        repo.becomes('merging');
        await flush();
        expect(answer).toBeNull();
        repo.becomes(after);
        await flush();

        expect(answer).toBe(after);
        expect(repo.listenerCount()).toBe(0);
      })
    );
  });

  describe('with a bound', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('property: answers the state a merge ends in within the bound, or merging once the bound passes first', async () => {
      await fc.assert(
        fc.asyncProperty(
          endArb,
          fc.integer({ min: 1, max: 10 * MERGE_WAIT_MS }),
          fc.integer({ min: 0, max: 20 * MERGE_WAIT_MS }),
          async (after, bound, endsAt) => {
            const repo = makeRepo('merging');
            let answer: Readiness | null = null;

            void outlastMerge(repo, bound).then((state) => (answer = state));
            await vi.advanceTimersByTimeAsync(Math.min(endsAt, bound - 1));
            expect(answer).toBeNull();
            if (endsAt < bound) repo.becomes(after);
            else await vi.advanceTimersByTimeAsync(1);
            await flush();

            expect(answer).toBe(endsAt < bound ? after : 'merging');
            expect(repo.listenerCount()).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
          }
        )
      );
    });

    it('waits for as long as a merge lasts with none, as does a held plain write', async () => {
      const repo = makeRepo('merging');
      let outlasted: Readiness | null = null;
      let allowed: boolean | null = null;

      void outlastMerge(repo).then((state) => (outlasted = state));
      void requireReady(repo, 'db-write', 'grade').then((ok) => (allowed = ok));
      await vi.advanceTimersByTimeAsync(100 * MERGE_WAIT_MS);
      expect(outlasted).toBeNull();
      expect(allowed).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      repo.becomes('ready');
      await flush();

      expect(outlasted).toBe('ready');
      expect(allowed).toBe(true);
    });
  });
});

describe('followWhenReady', () => {
  it('runs at once, with no microtask between, when ready', () => {
    const run = vi.fn();

    followWhenReady(makeRepo('ready'), run);

    expect(run).toHaveBeenCalledOnce();
  });

  it('property: runs once a merge ends ready, and never what it hears while saving is paused, saying nothing', async () => {
    await fc.assert(
      fc.asyncProperty(endArb, async (after) => {
        const notify = spyNotify();
        const merging = makeRepo('merging');
        const paused = makeRepo('starting');
        const afterMerge = vi.fn();
        const whilePaused = vi.fn();

        followWhenReady(merging, afterMerge);
        followWhenReady(paused, whilePaused);
        await flush();
        expect(afterMerge).not.toHaveBeenCalled();
        merging.becomes(after);
        paused.becomes('ready');
        await flush();

        expect(afterMerge).toHaveBeenCalledTimes(after === 'ready' ? 1 : 0);
        expect(whilePaused).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
        expect(paused.listenerCount()).toBe(0);
      })
    );
  });
});
