// @vitest-environment jsdom
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEBUG_TIMING_FLAG,
  enableDebugTiming,
  markPhase,
  phaseTiming,
  QUIET_AFTER_RELOAD_MS,
  reloadTimingLog,
} from './phase-timing';

describe('markPhase', () => {
  afterEach(() => {
    phaseTiming.mark = null;
  });

  it('property: tells the hook of each phase as it ends, in order', () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (phases) => {
        const told: string[] = [];
        phaseTiming.mark = (phase) => told.push(phase);

        for (const phase of phases) markPhase(phase);

        expect(told).toEqual(phases);
      })
    );
  });

  it('does nothing while no hook is set, as in the plugin', () => {
    expect(() => markPhase('read')).not.toThrow();
  });
});

// #region HELPERS

/** A clock the test moves by hand, with timers that fire as it passes them. */
function makeClock() {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    setTimeout: (run: () => void, ms: number) => {
      timers.set(++next, { at: now + ms, run });
      return next;
    },
    clearTimeout: (timer: unknown) => void timers.delete(timer as number),
    advance(ms: number) {
      now += ms;
      for (const [id, { at, run }] of [...timers]) {
        if (at <= now) {
          timers.delete(id);
          run();
        }
      }
    },
  };
}

/** A logger over a hand-moved clock, and the lines it logged. */
function makeLog() {
  const clock = makeClock();
  const lines: string[] = [];
  const mark = reloadTimingLog((line) => lines.push(line), clock);
  return { clock, lines, mark };
}

/** The numbers a logged line reports. */
function parse(line: string) {
  const total = Number(/reload ([\d.]+) ms/.exec(line)![1]);
  const phases = [.../\((.*)\)/.exec(line)![1].matchAll(/(\S+) ([\d.]+)/g)].map(
    ([, name, took]) => [name, Number(took)] as const
  );
  const writes = Number(/(\d+) database/.exec(line)![1]);
  const at = [
    ...(/ at (.*) ms$/.exec(line)?.[1] ?? '').matchAll(/\+(\d+)/g),
  ].map(([, ms]) => Number(ms));
  return { total, phases, writes, at };
}

// #endregion

describe('reloadTimingLog', () => {
  const phaseName = fc
    .stringMatching(/^[a-z]{1,8}$/)
    .filter(
      (name) => !['start', 'end', 'export', 'save', 'write'].includes(name)
    );

  it('property: logs each phase of a reload in order with how long it took, and the total, once saves stop', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(phaseName, fc.integer({ min: 10, max: 500 }))),
        fc.integer({ min: 10, max: 500 }),
        (phases, tail) => {
          const { clock, lines, mark } = makeLog();

          mark('start');
          for (const [name, took] of phases) {
            clock.advance(took);
            mark(name);
          }
          clock.advance(tail);
          mark('end');
          clock.advance(QUIET_AFTER_RELOAD_MS - 1);
          expect(lines).toEqual([]);
          clock.advance(1);

          expect(lines).toHaveLength(1);
          const logged = parse(lines[0]);
          expect(logged.phases).toEqual(phases);
          expect(logged.total).toBe(
            phases.reduce((sum, [, took]) => sum + took, 0) + tail
          );
          expect(logged.writes).toBe(0);
        }
      )
    );
  });

  it('property: counts every database write from the start of a reload until none has landed for a while, each at its time', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: QUIET_AFTER_RELOAD_MS - 1 }), {
          maxLength: 6,
        }),
        fc.array(fc.integer({ min: 0, max: QUIET_AFTER_RELOAD_MS - 1 }), {
          maxLength: 6,
        }),
        (during, after) => {
          const { clock, lines, mark } = makeLog();
          const at: number[] = [];
          let elapsed = 0;
          const write = (gap: number) => {
            clock.advance(gap);
            elapsed += gap;
            mark('export');
            mark('save');
            at.push(elapsed);
            mark('write');
          };

          mark('start');
          during.forEach(write);
          mark('end');
          after.forEach(write);
          expect(lines).toEqual([]);
          clock.advance(QUIET_AFTER_RELOAD_MS);
          // A write after the line is logged belongs to no reload
          mark('save');
          clock.advance(QUIET_AFTER_RELOAD_MS);

          expect(lines).toHaveLength(1);
          const logged = parse(lines[0]);
          expect(logged.writes).toBe(at.length);
          expect(logged.at).toEqual(at);
          expect(logged.phases).toEqual([]);
          expect(logged.total).toBe(during.reduce((sum, gap) => sum + gap, 0));
        }
      )
    );
  });

  it('ignores marks made outside a reload', () => {
    const { clock, lines, mark } = makeLog();

    for (const phase of ['plan', 'export', 'save', 'write', 'end']) {
      mark(phase);
    }
    clock.advance(QUIET_AFTER_RELOAD_MS * 2);

    expect(lines).toEqual([]);
  });

  it('ignores phases marked after a reload ended, as of a save it started', () => {
    const { clock, lines, mark } = makeLog();

    mark('start');
    clock.advance(20);
    mark('plan');
    mark('end');
    clock.advance(30);
    mark('refetch');
    clock.advance(QUIET_AFTER_RELOAD_MS);

    expect(parse(lines[0]).phases).toEqual([['plan', 20]]);
  });

  it('keeps counting the writes of a reload waiting on its saves while the next one runs, which gets a line of its own', () => {
    const { clock, lines, mark } = makeLog();

    mark('start');
    clock.advance(10);
    mark('plan');
    mark('end');
    mark('save');
    clock.advance(100);
    // As the read of that save coming back
    mark('start');
    clock.advance(40);
    mark('read');
    mark('end');
    clock.advance(500);
    mark('save');
    clock.advance(QUIET_AFTER_RELOAD_MS);

    expect(lines.map(parse)).toEqual([
      { total: 10, phases: [['plan', 10]], writes: 2, at: [10, 650] },
      { total: 40, phases: [['read', 40]], writes: 1, at: [540] },
    ]);
  });

  it('reports a whole reload with no writes, and one with a single write, by count', () => {
    const { clock, lines, mark } = makeLog();

    mark('start');
    clock.advance(5.25);
    mark('end');
    clock.advance(QUIET_AFTER_RELOAD_MS);
    mark('start');
    mark('save');
    mark('write');
    mark('end');
    clock.advance(QUIET_AFTER_RELOAD_MS);

    expect(parse(lines[0])).toMatchObject({ total: 5.3, writes: 0, at: [] });
    expect(parse(lines[1])).toMatchObject({ writes: 1, at: [0] });
  });
});

describe('reloadTimingLog lines', () => {
  it('shows each phase whole from 10 ms up and to a tenth below, in order', () => {
    const { clock, lines, mark } = makeLog();

    mark('start');
    clock.advance(10);
    mark('plan');
    clock.advance(9.94);
    mark('apply');
    mark('end');
    clock.advance(QUIET_AFTER_RELOAD_MS);

    expect(lines[0]).toContain('(plan 10, apply 9.9)');
  });

  it('lists the writes in order and counts them, one in the singular', () => {
    const { clock, lines, mark } = makeLog();

    mark('start');
    mark('save');
    clock.advance(5);
    mark('save');
    mark('end');
    clock.advance(QUIET_AFTER_RELOAD_MS);
    mark('start');
    mark('save');
    mark('end');
    clock.advance(QUIET_AFTER_RELOAD_MS);
    mark('start');
    mark('end');
    clock.advance(QUIET_AFTER_RELOAD_MS);

    expect(lines[0]).toMatch(/\b2 database writes at \+0, \+5 ms$/);
    expect(lines[1]).toMatch(/\b1 database write at \+0 ms$/);
    expect(lines[2]).toMatch(/\b0 database writes$/);
  });

  it('waits for a reload to end before logging it, however long a write before the end was', () => {
    const { clock, lines, mark } = makeLog();

    mark('start');
    mark('save');
    clock.advance(QUIET_AFTER_RELOAD_MS * 2);
    expect(lines).toEqual([]);
    mark('end');
    clock.advance(QUIET_AFTER_RELOAD_MS);

    expect(lines).toHaveLength(1);
  });
});

describe('enableDebugTiming', () => {
  afterEach(() => {
    phaseTiming.mark = null;
    vi.restoreAllMocks();
  });

  const storageWith = (value: string | null) => () => ({
    getItem: (key: string) => (key === DEBUG_TIMING_FLAG ? value : null),
  });

  it.each([null, '0', 'true', ''])(
    'sets no hook while the switch reads %j',
    (value) => {
      const off = enableDebugTiming(storageWith(value));

      expect(phaseTiming.mark).toBeNull();
      off();
      expect(phaseTiming.mark).toBeNull();
    }
  );

  it('sets no hook when storage throws', () => {
    enableDebugTiming(() => {
      throw new Error('blocked');
    });

    expect(phaseTiming.mark).toBeNull();
  });

  it('logs reloads with console.debug while on, and stops once turned off', () => {
    vi.useFakeTimers();
    try {
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const off = enableDebugTiming(storageWith('1'));

      markPhase('start');
      markPhase('end');
      vi.advanceTimersByTime(QUIET_AFTER_RELOAD_MS);
      expect(debug).toHaveBeenCalledTimes(1);
      expect(parse(String(debug.mock.calls[0][0])).writes).toBe(0);

      off();
      expect(phaseTiming.mark).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a hook set since alone when turned off', () => {
    const off = enableDebugTiming(storageWith('1'));
    const other = () => {};
    phaseTiming.mark = other;

    off();

    expect(phaseTiming.mark).toBe(other);
  });
});
