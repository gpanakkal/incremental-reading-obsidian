import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refusedWrite, withCompensation } from './compensation';
import { ObsidianHelpers as Obsidian } from './ObsidianHelpers';
import type { SQLiteRepository } from './types';

// #region HELPERS

/**
 * An operation of `count` steps, each logging its run and its undo, where
 * `failAt` (if any) is the step whose run throws, and every step in
 * `failingUndos` throws from its undo.
 */
function makeOperation(
  count: number,
  failAt: number | null,
  failingUndos: ReadonlySet<number>
) {
  const log: string[] = [];
  const reported: unknown[] = [];
  const failure = new Error(`step ${failAt} failed`);
  const run = () =>
    withCompensation(
      async (step) => {
        const results: number[] = [];
        for (let i = 0; i < count; i++) {
          results.push(
            await step(
              async () => {
                log.push(`run ${i}`);
                if (i === failAt) throw failure;
                return i * 10;
              },
              async (result) => {
                log.push(`undo ${i} of ${result}`);
                if (failingUndos.has(i)) throw new Error(`undo ${i} failed`);
              }
            )
          );
        }
        return results;
      },
      (error) => reported.push(error)
    );
  return { run, log, reported, failure };
}

const operationArb = fc.nat({ max: 8 }).chain((count) =>
  fc.record({
    count: fc.constant(count),
    failAt:
      count === 0
        ? fc.constant(null)
        : fc.option(fc.nat({ max: count - 1 }), { nil: null }),
    failingUndos: fc.uniqueArray(fc.nat({ max: Math.max(count - 1, 0) })),
  })
);

/** A repository refusing writes with `refusal`, or allowing them for null. */
const repoRefusing = (refusal: Error | null) =>
  ({ writeRefusal: () => refusal }) as unknown as SQLiteRepository;

// #endregion

describe('withCompensation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs every step in order and undoes none when all succeed', async () => {
    await fc.assert(
      fc.asyncProperty(operationArb, async ({ count, failingUndos }) => {
        const op = makeOperation(count, null, new Set(failingUndos));

        const results = await op.run();

        expect(results).toEqual(
          Array.from({ length: count }, (_, i) => i * 10)
        );
        expect(op.log).toEqual(
          Array.from({ length: count }, (_, i) => `run ${i}`)
        );
        expect(op.reported).toEqual([]);
      })
    );
  });

  it('on a failing step, undoes the steps before it in reverse, with their results, runs none after, and rethrows its error', async () => {
    await fc.assert(
      fc.asyncProperty(
        operationArb,
        async ({ count, failAt, failingUndos }) => {
          fc.pre(failAt !== null);
          const op = makeOperation(count, failAt, new Set(failingUndos));

          await expect(op.run()).rejects.toBe(op.failure);

          const runs = Array.from({ length: failAt + 1 }, (_, i) => `run ${i}`);
          const undos = Array.from(
            { length: failAt },
            (_, i) => `undo ${failAt - 1 - i} of ${(failAt - 1 - i) * 10}`
          );
          expect(op.log).toEqual([...runs, ...undos]);
        }
      )
    );
  });

  it('reports each undo that fails, keeps undoing the rest, and still rethrows the original error', async () => {
    await fc.assert(
      fc.asyncProperty(
        operationArb,
        async ({ count, failAt, failingUndos }) => {
          fc.pre(failAt !== null);
          const op = makeOperation(count, failAt, new Set(failingUndos));

          await expect(op.run()).rejects.toBe(op.failure);

          const expected = [...failingUndos]
            .filter((i) => i < failAt)
            .sort((a, b) => b - a)
            .map((i) => `undo ${i} failed`);
          expect(op.reported.map((error) => (error as Error).message)).toEqual(
            expected
          );
        }
      )
    );
  });

  it('undoes every completed step, in reverse, when the work throws between steps', async () => {
    await fc.assert(
      fc.asyncProperty(fc.nat({ max: 8 }), async (count) => {
        const undone: number[] = [];
        const failure = new Error('between steps');

        await expect(
          withCompensation(async (step) => {
            for (let i = 0; i < count; i++) {
              await step(
                () => i,
                (result) => void undone.push(result)
              );
            }
            throw failure;
          })
        ).rejects.toBe(failure);

        expect(undone).toEqual(
          Array.from({ length: count }, (_, i) => count - 1 - i)
        );
      })
    );
  });

  it('logs a failing undo to the console when no reporter is given', async () => {
    const error = vi.spyOn(console, 'error').mockReturnValue(undefined);
    const undoFailure = new Error('undo failed');

    await expect(
      withCompensation(async (step) => {
        await step(
          () => undefined,
          () => {
            throw undoFailure;
          }
        );
        throw new Error('work failed');
      })
    ).rejects.toThrow('work failed');

    expect(error).toHaveBeenCalledExactlyOnceWith(undoFailure);
  });
});

describe('refusedWrite', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers false, and says nothing, while writes are allowed', () => {
    const notify = vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);

    expect(refusedWrite(repoRefusing(null), 'create the snippet')).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('answers true, and says what was not done and why, while writes are refused', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (action, reason) => {
        vi.restoreAllMocks();
        const notify = vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);

        expect(refusedWrite(repoRefusing(new Error(reason)), action)).toBe(
          true
        );
        expect(notify).toHaveBeenCalledExactlyOnceWith(
          `Couldn't ${action}: saving to the database is paused. ${reason}`
        );
      })
    );
  });
});
