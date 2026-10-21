import fc from 'fast-check';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import {
  callSite,
  recordSave,
  SAVE_STATS_FLAG,
  SAVE_STATS_WINDOW_MS,
  type SaveStats,
} from './save-stats';

// #region HELPERS

/** A window whose localStorage holds `flag` under the counter's key. */
function stubWindow(flag: string | null | (() => never)) {
  const win: { localStorage: Storage; __irSaveStats?: SaveStats } = {
    localStorage: {
      getItem: (key: string) => {
        if (typeof flag === 'function') return flag();
        return key === SAVE_STATS_FLAG ? flag : null;
      },
    } as Storage,
  };
  vi.stubGlobal('window', win);
  return win;
}

// #endregion

let debug: MockInstance<typeof console.debug>;

beforeEach(() => {
  debug = vi.spyOn(console, 'debug').mockReturnValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('recordSave', () => {
  it.each([[null], ['0'], ['true']])(
    'counts nothing while the flag is %s',
    (flag) => {
      const win = stubWindow(flag);

      recordSave('saved');

      expect(win.__irSaveStats).toBeUndefined();
      expect(debug).not.toHaveBeenCalled();
    }
  );

  it('counts nothing when localStorage cannot be read', () => {
    const win = stubWindow(() => {
      throw new Error('denied');
    });

    recordSave('saved');

    expect(win.__irSaveStats).toBeUndefined();
  });

  it('keeps the last minute of records and totals by kind and site', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            gap: fc.integer({ min: 0, max: 40_000 }),
            kind: fc.constantFrom('saved' as const, 'skipped' as const),
          }),
          { minLength: 1, maxLength: 12 }
        ),
        (writes) => {
          debug.mockClear();
          const win = stubWindow('1');
          let now = 0;
          const times: number[] = [];
          for (const { gap, kind } of writes) {
            now += gap;
            times.push(now);
            recordSave(kind, now);
          }

          const stats = win.__irSaveStats!;
          const inWindow = writes.filter(
            (_, i) => now - times[i] < SAVE_STATS_WINDOW_MS
          );
          expect(stats.recent.map(({ kind }) => kind)).toEqual(
            inWindow.map(({ kind }) => kind)
          );
          for (const kind of ['saved', 'skipped'] as const) {
            const total = Object.values(stats.totals[kind]).reduce(
              (sum, count) => sum + count,
              0
            );
            expect(total).toBe(writes.filter((w) => w.kind === kind).length);
          }
          const last = writes[writes.length - 1];
          expect(debug).toHaveBeenLastCalledWith(
            expect.stringContaining(last.kind),
            expect.objectContaining({
              lastMinute: inWindow.filter(({ kind }) => kind === last.kind)
                .length,
            })
          );
        }
      )
    );
  });

  it('drops a record a whole window old', () => {
    const win = stubWindow('1');

    recordSave('saved', 0);
    recordSave('saved', SAVE_STATS_WINDOW_MS - 1);
    recordSave('saved', SAVE_STATS_WINDOW_MS);

    expect(win.__irSaveStats!.recent.map(({ at }) => at)).toEqual([
      SAVE_STATS_WINDOW_MS - 1,
      SAVE_STATS_WINDOW_MS,
    ]);
  });

  it('names the frame that called into the repository', () => {
    const win = stubWindow('1');

    (function writerOutsideTheRepo() {
      recordSave('saved', 1);
    })();

    const [{ site }] = win.__irSaveStats!.recent;
    expect(site).toMatch(/^writerOutsideTheRepo /);
  });
});

describe('callSite', () => {
  it('skips the repository and its helpers, and the message line', () => {
    const stack = [
      'Error: boom',
      '    at recordSave (save-stats.ts:1:1)',
      '    at ContentWatch.mark (content-watch.ts:1:1)',
      '    at SQLJSRepository.save (main.js:1:1)',
      '    at FakeRepository.mutate (main.js:2:2)',
      '',
      '    at ReviewManager.saveScrollPosition (main.js:3:3)',
      '    at later (main.js:4:4)',
    ].join('\n');

    expect(callSite(stack)).toBe(
      'ReviewManager.saveScrollPosition (main.js:3:3)'
    );
  });

  it('keeps a frame without the V8 prefix whole, as WebKit writes it', () => {
    const frame = 'importMany@app://local/Great Notes/main.js:1:2';

    expect(callSite(frame)).toBe(frame);
  });

  it.each([[undefined], [''], ['Error\n    at SQLJSRepository.save (x)']])(
    'falls back to unknown for %j',
    (stack) => {
      expect(callSite(stack)).toBe('unknown');
    }
  );
});
