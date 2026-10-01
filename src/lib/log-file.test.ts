import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_DIRECTORY } from './constants';
import { appendLog, logFilePath } from './log-file';

// #region HELPERS

/** An adapter over an in-memory folder tree, counting every call. */
function makeAdapter(
  initial: Record<string, string> = {},
  dirs: string[] = []
) {
  const files = new Map(Object.entries(initial));
  const folders = new Set(dirs);
  return {
    files,
    folders,
    exists: vi.fn(async (path: string) => files.has(path) || folders.has(path)),
    mkdir: vi.fn(async (path: string) => {
      folders.add(path);
    }),
    write: vi.fn(async (path: string, data: string) => {
      files.set(path, data);
    }),
    append: vi.fn(async (path: string, data: string) => {
      if (!files.has(path)) throw new Error(`no file at ${path}`);
      files.set(path, files.get(path) + data);
    }),
  };
}

/** Any moment a clock can read, from 1970 into the far future. */
const dateArb = fc.date({
  min: new Date(0),
  max: new Date(8_000_000_000_000),
  noInvalidDate: true,
});

/** Entries as callers write them: one line each, never a line break inside. */
const entryArb = fc.string().filter((entry) => !/[\r\n]/.test(entry));

// #endregion

describe('logFilePath', () => {
  it('names one file per topic per local calendar month, inside the log folder', () => {
    fc.assert(
      fc.property(dateArb, (at) => {
        const month = String(at.getMonth() + 1).padStart(2, '0');

        expect(logFilePath('rebinds', at)).toBe(
          `${LOG_DIRECTORY}/rebinds-${at.getFullYear()}-${month}.log`
        );
      })
    );
  });
});

describe('appendLog', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates the log folder and file on first use, one stamped line per entry', async () => {
    await fc.assert(
      fc.asyncProperty(
        dateArb,
        fc.array(entryArb, { minLength: 1, maxLength: 5 }),
        async (at, entries) => {
          const adapter = makeAdapter();

          await appendLog(adapter, 'rebinds', entries, at);

          expect(adapter.folders).toEqual(new Set([LOG_DIRECTORY]));
          expect([...adapter.files]).toEqual([
            [
              logFilePath('rebinds', at),
              entries.map((entry) => `${at.toISOString()} ${entry}\n`).join(''),
            ],
          ]);
        }
      )
    );
  });

  it('adds to an existing file without touching what it holds', async () => {
    const at = new Date(2026, 8, 30, 12);
    const path = logFilePath('rebinds', at);
    const adapter = makeAdapter({ [path]: 'earlier\n' }, [LOG_DIRECTORY]);

    await appendLog(adapter, 'rebinds', ['one', 'two'], at);

    expect(adapter.files.get(path)).toBe(
      `earlier\n${at.toISOString()} one\n${at.toISOString()} two\n`
    );
    expect(adapter.mkdir).not.toHaveBeenCalled();
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it('writes nothing at all for no entries', async () => {
    const adapter = makeAdapter();

    await appendLog(adapter, 'rebinds', []);

    expect(adapter.exists).not.toHaveBeenCalled();
    expect(adapter.files.size).toBe(0);
  });

  it('reports a failed write rather than letting it escape to the caller', async () => {
    const adapter = makeAdapter();
    const failure = new Error('disk full');
    adapter.write.mockRejectedValue(failure);

    await expect(
      appendLog(adapter, 'rebinds', ['entry'])
    ).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Incremental Reading'),
      failure
    );
  });

  it('lets no write overwrite another made at the same time', async () => {
    const at = new Date(2026, 8, 30, 12);
    const adapter = makeAdapter();
    adapter.write.mockRejectedValueOnce(new Error('disk full'));

    await Promise.all([
      appendLog(adapter, 'rebinds', ['lost'], at),
      appendLog(adapter, 'rebinds', ['one'], at),
      appendLog(adapter, 'rebinds', ['two'], at),
    ]);

    expect(adapter.files.get(logFilePath('rebinds', at))).toBe(
      `${at.toISOString()} one
${at.toISOString()} two
`
    );
  });
});

describe('appendLog by the clock', () => {
  const now = new Date(2026, 0, 2, 3, 4, 5);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stamps entries with the current time by default', async () => {
    const adapter = makeAdapter();

    await appendLog(adapter, 'rebinds', ['entry']);

    expect([...adapter.files]).toEqual([
      [
        logFilePath('rebinds', now),
        `${now.toISOString()} entry
`,
      ],
    ]);
  });
});
