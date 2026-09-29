import { createSaveCoalescer } from '#/lib/save-coalescer';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// #region HELPERS

/** Let every pending promise callback run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

interface SaveRecord {
  startedAt: number;
  settledAt: number | null;
  settle: (ok: boolean) => void;
}

interface RequestRecord {
  at: number;
  resolvedAt: number | null;
}

/**
 * A coalescer over a save that only settles when told to, with every start,
 * settle, request and resolution stamped on one shared clock so the order of
 * events can be checked afterwards.
 *
 * `reenter` makes the first save ask for another save from inside itself,
 * before it has done anything asynchronous.
 */
function makeHarness({ reenter = false } = {}) {
  let clock = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const saves: SaveRecord[] = [];
  const requests: RequestRecord[] = [];
  const errors: unknown[] = [];
  const thrown: Error[] = [];

  const request = () => {
    const record: RequestRecord = { at: ++clock, resolvedAt: null };
    requests.push(record);
    void coalescer.request().then(() => {
      record.resolvedAt = ++clock;
    });
  };

  const coalescer = createSaveCoalescer(
    () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const record = { startedAt: ++clock, settledAt: null } as SaveRecord;
      saves.push(record);
      if (reenter && saves.length === 1) request();
      return new Promise<void>((resolve, reject) => {
        record.settle = (ok) => {
          inFlight--;
          record.settledAt = ++clock;
          if (ok) {
            resolve();
          } else {
            const error = new Error(`save ${saves.indexOf(record)} failed`);
            thrown.push(error);
            reject(error);
          }
        };
      });
    },
    (error) => errors.push(error)
  );

  /** Settle the save that is running, if one is. */
  const settleRunning = (ok: boolean) => {
    saves.find((save) => save.settledAt === null)?.settle(ok);
  };

  /** Let every save run to completion, successfully. */
  const drain = async () => {
    await flush();
    // Each settle can start at most one follow-up, so this ends.
    for (let i = 0; i <= requests.length; i++) {
      settleRunning(true);
      await flush();
    }
  };

  return {
    request,
    settleRunning,
    drain,
    saves,
    requests,
    errors,
    thrown,
    get inFlight() {
      return inFlight;
    },
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

type Op = { kind: 'request' } | { kind: 'settle'; ok: boolean };

const opsArb: fc.Arbitrary<Op[]> = fc.array(
  fc.oneof(
    fc.constant<Op>({ kind: 'request' }),
    fc.boolean().map<Op>((ok) => ({ kind: 'settle', ok }))
  ),
  { maxLength: 40 }
);

async function run(ops: Op[], options?: { reenter?: boolean }) {
  const harness = makeHarness(options);
  for (const op of ops) {
    if (op.kind === 'request') harness.request();
    else harness.settleRunning(op.ok);
    await flush();
  }
  await harness.drain();
  return harness;
}

// #endregion

describe('createSaveCoalescer', () => {
  it('never runs two saves at once, whatever order requests and settles arrive in (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(opsArb, fc.boolean(), async (ops, reenter) => {
        const harness = await run(ops, { reenter });

        expect(harness.maxInFlight).toBeLessThanOrEqual(1);
        expect(harness.inFlight).toBe(0);
      })
    );
  });

  it('follows every request with a save that starts after it, and resolves the request only once that save settles (property-based)', async () => {
    // The guarantee the review editor leans on: the save covering a keystroke
    // reads the document after the keystroke, so it cannot be skipped.
    await fc.assert(
      fc.asyncProperty(opsArb, fc.boolean(), async (ops, reenter) => {
        const harness = await run(ops, { reenter });

        for (const request of harness.requests) {
          const covering = harness.saves.find(
            (save) => save.startedAt > request.at
          );
          expect(covering).toBeDefined();
          expect(covering!.settledAt).not.toBeNull();
          expect(request.resolvedAt).not.toBeNull();
          expect(request.resolvedAt!).toBeGreaterThan(covering!.settledAt!);
        }
      })
    );
  });

  it('starts a save only for requests no earlier save has covered (property-based)', async () => {
    // Coalescing: however many requests arrive while a save runs, they share
    // one follow-up. Each save therefore has a request of its own between it
    // and the save before it.
    await fc.assert(
      fc.asyncProperty(opsArb, fc.boolean(), async (ops, reenter) => {
        const harness = await run(ops, { reenter });

        harness.saves.forEach((save, i) => {
          const previousStart = i === 0 ? 0 : harness.saves[i - 1].startedAt;
          const uncovered = harness.requests.some(
            (request) =>
              request.at > previousStart && request.at < save.startedAt
          );
          expect(uncovered).toBe(true);
        });
        expect(harness.saves.length).toBeLessThanOrEqual(
          harness.requests.length
        );
      })
    );
  });

  it('reports each failed save to onError, in order, and keeps saving after one (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(opsArb, fc.boolean(), async (ops, reenter) => {
        const harness = await run(ops, { reenter });

        expect(harness.errors).toEqual(harness.thrown);
      })
    );
  });

  it('folds any number of requests made during a running save into one follow-up save', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 50 }), async (burst) => {
        const harness = makeHarness();
        harness.request();
        await flush();
        expect(harness.saves).toHaveLength(1);

        for (let i = 0; i < burst; i++) harness.request();
        await flush();
        expect(harness.saves).toHaveLength(1);

        harness.settleRunning(true);
        await flush();
        expect(harness.saves).toHaveLength(2);

        harness.settleRunning(true);
        await flush();
        expect(harness.saves).toHaveLength(2);
        expect(harness.requests.every((r) => r.resolvedAt !== null)).toBe(true);
      })
    );
  });

  it('runs the follow-up even when the save before it failed', async () => {
    const harness = makeHarness();
    harness.request();
    await flush();
    harness.request();
    harness.settleRunning(false);
    await flush();

    expect(harness.saves).toHaveLength(2);
    expect(harness.errors).toEqual(harness.thrown);
    expect(harness.errors).toHaveLength(1);
  });

  it('starts afresh once idle, rather than staying attached to a finished run', async () => {
    const harness = makeHarness();
    harness.request();
    await harness.drain();
    harness.request();
    await flush();

    expect(harness.saves).toHaveLength(2);
    expect(harness.inFlight).toBe(1);
  });

  it('joins a request made from inside a save to the running series instead of starting a second save alongside it', async () => {
    const harness = makeHarness({ reenter: true });
    harness.request();
    await flush();

    expect(harness.saves).toHaveLength(1);
    harness.settleRunning(true);
    await flush();
    expect(harness.saves).toHaveLength(2);
    expect(harness.maxInFlight).toBe(1);
  });
});
