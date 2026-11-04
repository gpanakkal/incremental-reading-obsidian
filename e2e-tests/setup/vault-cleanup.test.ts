import fc from 'fast-check';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CopyTracker,
  claimCopy,
  cleanupEnabled,
  createOwnedCopy,
  createdCopies,
  disposeCopy,
  isProcessAlive,
  ownerFile,
  readOwner,
  removeWithRetry,
  sweepStaleCopies,
} from './vault-cleanup';

// #region HELPERS
/** Error codes Windows reports while a closing process still holds a file. */
const RETRYABLE_CODES = ['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'] as const;

function errorWithCode(code: string | undefined) {
  return Object.assign(new Error(code ?? 'no code'), { code });
}

/** An `rm` that fails with the given codes in turn, then succeeds. */
function makeFlakyRm(codes: readonly (string | undefined)[]) {
  let calls = 0;
  const rm = vi.fn(async () => {
    const code = codes[calls];
    calls++;
    if (calls <= codes.length) throw errorWithCode(code);
  });
  return rm;
}

function makeSleep() {
  return vi.fn(async (_ms: number) => {});
}

let root: string;

async function makeDir(name: string, under = root) {
  const dir = path.join(under, name);
  await fs.mkdir(path.join(dir, 'nested'), { recursive: true });
  await fs.writeFile(path.join(dir, 'nested', 'note.md'), 'body');
  return dir;
}

async function listRoot(dir = root) {
  return (await fs.readdir(dir)).sort();
}

const copyName = fc
  .tuple(
    fc.option(fc.stringMatching(/^[a-z][a-z0-9-]{0,24}$/), { nil: undefined }),
    fc.stringMatching(/^[0-9a-f]{8}$/)
  )
  .map(([prefix, id]) => (prefix ? `${prefix}-${id}` : id));

const ownerRecord = fc.record({
  pid: fc.integer({ min: 1, max: 2 ** 31 - 1 }),
  keep: fc.boolean(),
});

type MarkerSpec =
  | { kind: 'none' }
  | { kind: 'garbage'; text: string }
  | { kind: 'record'; pid: number; keep: boolean };

const markerSpec: fc.Arbitrary<MarkerSpec> = fc.oneof(
  fc.constant({ kind: 'none' as const }),
  fc
    .string()
    .filter((text) => {
      try {
        const parsed: unknown = JSON.parse(text);
        return typeof parsed !== 'object' || parsed === null;
      } catch {
        return true;
      }
    })
    .map((text) => ({ kind: 'garbage' as const, text })),
  ownerRecord.map((r) => ({ kind: 'record' as const, ...r }))
);

const entrySpec = fc.record({
  name: copyName,
  hasDir: fc.boolean(),
  marker: markerSpec,
  ownerAlive: fc.boolean(),
});

async function writeMarker(vaultPath: string, marker: MarkerSpec) {
  if (marker.kind === 'garbage')
    await fs.writeFile(ownerFile(vaultPath), marker.text);
  if (marker.kind === 'record')
    await claimCopy(vaultPath, { pid: marker.pid, keep: marker.keep });
}
// #endregion

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-cleanup-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('cleanupEnabled', () => {
  it('cleans up unless E2E_CLEANUP is exactly "0"', () => {
    fc.assert(
      fc.property(
        fc.option(fc.oneof(fc.constantFrom('0', '1', ''), fc.string()), {
          nil: undefined,
        }),
        fc.dictionary(fc.string(), fc.string()),
        (value, rest) => {
          const env = { ...rest, E2E_CLEANUP: value };
          expect(cleanupEnabled(env)).toBe(value !== '0');
        }
      )
    );
  });

  it('cleans up when the variable is absent', () => {
    expect(cleanupEnabled({})).toBe(true);
  });

  it('reads process.env by default', () => {
    vi.stubEnv('E2E_CLEANUP', '0');
    try {
      expect(cleanupEnabled()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('removeWithRetry', () => {
  it('retries while the target is locked, then reports success', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...RETRYABLE_CODES), { maxLength: 6 }),
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 0, max: 1000 }),
        async (codes, spare, delayMs) => {
          const rm = makeFlakyRm(codes);
          const sleep = makeSleep();
          const attempts = codes.length + 1 + spare;
          const removed = await removeWithRetry('target', {
            attempts,
            delayMs,
            rm,
            sleep,
          });
          expect(removed).toBe(true);
          expect(rm).toHaveBeenCalledTimes(codes.length + 1);
          expect(rm).toHaveBeenCalledWith('target');
          // Linear backoff: each wait is longer than the one before.
          expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(
            codes.map((_, i) => delayMs * (i + 1))
          );
        }
      )
    );
  });

  it('gives up without throwing once every attempt was locked', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        fc.constantFrom(...RETRYABLE_CODES),
        async (attempts, code) => {
          const rm = makeFlakyRm(Array<string>(attempts + 5).fill(code));
          const sleep = makeSleep();
          const removed = await removeWithRetry('target', {
            attempts,
            delayMs: 1,
            rm,
            sleep,
          });
          expect(removed).toBe(false);
          expect(rm).toHaveBeenCalledTimes(attempts);
          expect(sleep).toHaveBeenCalledTimes(attempts - 1);
        }
      )
    );
  });

  it('does not retry an error that waiting cannot fix', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(
          fc
            .string()
            .filter((c) => !(RETRYABLE_CODES as readonly string[]).includes(c)),
          { nil: undefined }
        ),
        async (code) => {
          const rm = makeFlakyRm([code]);
          const sleep = makeSleep();
          const removed = await removeWithRetry('target', {
            attempts: 5,
            rm,
            sleep,
          });
          expect(removed).toBe(false);
          expect(rm).toHaveBeenCalledTimes(1);
          expect(sleep).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('retries for at least a few seconds by default', async () => {
    const rm = makeFlakyRm(Array<string>(100).fill('EBUSY'));
    const sleep = makeSleep();
    await removeWithRetry('target', { rm, sleep });
    const waited = sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0);
    expect(waited).toBeGreaterThanOrEqual(3000);
    expect(waited).toBeLessThanOrEqual(30_000);
  });

  it('deletes a real directory tree and treats a missing one as removed', async () => {
    const dir = await makeDir('tree');
    expect(await removeWithRetry(dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(await removeWithRetry(dir)).toBe(true);
  });

  it('waits between attempts by default', async () => {
    vi.useFakeTimers();
    try {
      const rm = makeFlakyRm(['EBUSY']);
      const pending = removeWithRetry('target', { rm, delayMs: 500 });
      await vi.advanceTimersByTimeAsync(499);
      expect(rm).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBe(true);
      expect(rm).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('claimCopy / readOwner', () => {
  it('only ever puts a complete marker at the final path', async () => {
    // A run still going after a timeout writes here, never into a later
    // test's root
    const base = root;
    await fc.assert(
      fc.asyncProperty(copyName, ownerRecord, async (name, record) => {
        const vaultPath = path.join(base, name);
        const marker = ownerFile(vaultPath);
        const writes: string[] = [];
        const renames: [string, string, unknown][] = [];
        await claimCopy(vaultPath, record, {
          writeFile: async (file, data) => {
            writes.push(file);
            await fs.writeFile(file, data);
          },
          rename: async (from, to) => {
            // What sits at the source the moment it becomes the marker.
            renames.push([
              from,
              to,
              JSON.parse(await fs.readFile(from, 'utf8')),
            ]);
            await fs.rename(from, to);
          },
        });
        expect(writes).not.toContain(marker);
        expect(writes).toHaveLength(1);
        expect(renames).toEqual([[writes[0], marker, record]]);
        expect(path.dirname(writes[0])).toBe(base);
        expect(await readOwner(vaultPath)).toEqual(record);
        // The temporary file is gone, leaving only the marker.
        expect(await listRoot(base)).toEqual([path.basename(marker)]);
        await fs.rm(marker);
      })
    );
  }, 30_000);

  it('shows a sweep running mid-write nothing to read or delete', async () => {
    const vaultPath = path.join(root, 'core-0123abcd');
    let duringWrite: string[] = [];
    let swept: string[] = [];
    await claimCopy(
      vaultPath,
      { pid: 7, keep: false },
      {
        writeFile: async (file, data) => {
          // Half the record on disk, as a sweep in another run could catch it.
          await fs.writeFile(file, data.slice(0, data.length >> 1));
          swept = await sweepStaleCopies(root, { isAlive: () => false });
          duringWrite = await listRoot();
          await fs.writeFile(file, data);
        },
      }
    );
    expect(swept).toEqual([]);
    expect(duringWrite).toHaveLength(1);
    expect(duringWrite[0]).not.toBe(path.basename(ownerFile(vaultPath)));
    expect(await readOwner(vaultPath)).toEqual({ pid: 7, keep: false });
    expect(await listRoot()).toEqual(['core-0123abcd.owner.json']);
  });

  it('records who owns a copy beside it, before the copy exists', async () => {
    // A run still going after a timeout writes here, never into a later
    // test's root
    const base = root;
    await fc.assert(
      fc.asyncProperty(copyName, ownerRecord, async (name, record) => {
        const vaultPath = path.join(base, name);
        await claimCopy(vaultPath, record);
        expect(existsSync(vaultPath)).toBe(false);
        expect(path.dirname(ownerFile(vaultPath))).toBe(base);
        expect(await readOwner(vaultPath)).toEqual(record);
        await fs.rm(ownerFile(vaultPath));
      })
    );
  }, 30_000);

  it('reads no owner from a missing or unreadable marker', async () => {
    // A run still going after a timeout writes here, never into a later
    // test's root
    const base = root;
    await fc.assert(
      fc.asyncProperty(copyName, markerSpec, async (name, marker) => {
        fc.pre(marker.kind !== 'record');
        const vaultPath = path.join(base, name);
        await writeMarker(vaultPath, marker);
        expect(await readOwner(vaultPath)).toBeNull();
        await fs.rm(ownerFile(vaultPath), { force: true });
      })
    );
  }, 30_000);

  it('reads no owner from a marker of the wrong shape', async () => {
    const vaultPath = path.join(root, 'core-0123abcd');
    for (const value of [
      {},
      { pid: '12', keep: false },
      { pid: 12, keep: 'no' },
      { keep: true },
      { pid: 12 },
      [],
      null,
    ]) {
      await fs.writeFile(ownerFile(vaultPath), JSON.stringify(value));
      expect(await readOwner(vaultPath)).toBeNull();
    }
  });
});

describe('sweepStaleCopies', () => {
  // Real disk work per run: under a loaded full suite 40 runs can outlast the
  // default 5s, and a timed-out property keeps running in the background
  it('removes copies nobody owns any more and keeps the rest', async () => {
    // Each run works in a directory of its own under this test's root, so a
    // run still going after a timeout never writes into a later test's root
    const base = root;
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(entrySpec, { selector: (e) => e.name, maxLength: 6 }),
        async (entries) => {
          const dir = await fs.mkdtemp(path.join(base, 'run-'));
          const alive = new Map<number, boolean>();
          for (const entry of entries) {
            const vaultPath = path.join(dir, entry.name);
            await writeMarker(vaultPath, entry.marker);
            if (entry.hasDir) await makeDir(entry.name, dir);
            if (entry.marker.kind === 'record')
              alive.set(entry.marker.pid, entry.ownerAlive);
          }
          // Not a test copy: never touched, whoever owns it.
          await makeDir('codegen', dir);
          await fs.writeFile(path.join(dir, 'notes.txt'), 'x');

          // Two entries can share a pid; the last one set wins for both.
          const isAlive = (pid: number) => alive.get(pid) ?? false;
          const removed = await sweepStaleCopies(dir, { isAlive });

          const stale = (marker: MarkerSpec) =>
            marker.kind !== 'record' || (!marker.keep && !isAlive(marker.pid));
          const expected = new Set(['codegen', 'notes.txt']);
          for (const entry of entries) {
            if (stale(entry.marker)) continue;
            if (entry.hasDir) expected.add(entry.name);
            expected.add(path.basename(ownerFile(entry.name)));
          }
          expect(await listRoot(dir)).toEqual([...expected].sort());
          expect([...removed].sort()).toEqual(
            entries
              .filter((e) => e.hasDir && stale(e.marker))
              .map((e) => e.name)
              .sort()
          );
          await fs.rm(dir, { recursive: true, force: true });
        }
      ),
      { numRuns: 40 }
    );
  }, 30_000);

  it('keeps a copy and its marker when the copy cannot be removed yet', async () => {
    await makeDir('core-0123abcd');
    await claimCopy(path.join(root, 'core-0123abcd'), { pid: 7, keep: false });
    const remove = vi.fn(async () => false);
    const removed = await sweepStaleCopies(root, {
      isAlive: () => false,
      remove,
    });
    expect(removed).toEqual([]);
    expect(remove).toHaveBeenCalledWith(path.join(root, 'core-0123abcd'));
    expect(await listRoot()).toEqual([
      'core-0123abcd',
      'core-0123abcd.owner.json',
    ]);
  });

  it('asks whether the recorded owner is alive', async () => {
    await makeDir('core-0123abcd');
    await claimCopy(path.join(root, 'core-0123abcd'), {
      pid: 4242,
      keep: false,
    });
    const isAlive = vi.fn(() => true);
    await sweepStaleCopies(root, { isAlive });
    expect(isAlive).toHaveBeenCalledWith(4242);
    expect(await listRoot()).toEqual([
      'core-0123abcd',
      'core-0123abcd.owner.json',
    ]);
  });

  it('tolerates another sweep removing a marker first', async () => {
    // Two runs in one checkout can sweep at once; the other one gets to this
    // orphan marker between this sweep reading it and deleting it.
    const marker = ownerFile(path.join(root, 'core-0123abcd'));
    await claimCopy(path.join(root, 'core-0123abcd'), { pid: 7, keep: false });
    const isAlive = () => {
      rmSync(marker, { force: true });
      return false;
    };
    expect(await sweepStaleCopies(root, { isAlive })).toEqual([]);
    expect(await listRoot()).toEqual([]);
  });

  it('does nothing when there is no vaults directory', async () => {
    const missing = path.join(root, 'missing');
    expect(await sweepStaleCopies(missing, { isAlive: () => false })).toEqual(
      []
    );
    expect(existsSync(missing)).toBe(false);
  });
});

describe('createOwnedCopy', () => {
  it('owns and tracks the copy before any of it exists', async () => {
    // A run still going after a timeout writes here, never into a later
    // test's root
    const base = root;
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.stringMatching(/^[a-z]{1,8}$/), { nil: undefined }),
        copyName,
        ownerRecord,
        async (subDirectory, name, record) => {
          const vaultPath = subDirectory
            ? path.join(base, subDirectory, name)
            : path.join(base, name);
          const tracker = new CopyTracker();
          const seen: unknown[] = [];
          await createOwnedCopy(
            vaultPath,
            async (target) => {
              // What a sweep in another process would see mid-copy.
              seen.push(
                target,
                existsSync(target),
                await readOwner(target),
                tracker.takeSince(0)
              );
              await makeDir(path.relative(base, target), base);
            },
            { ...record, tracker }
          );
          expect(seen).toEqual([vaultPath, false, record, [vaultPath]]);
          expect(existsSync(vaultPath)).toBe(true);
          await fs.rm(path.join(base, subDirectory ?? name), {
            recursive: true,
            force: true,
          });
          await fs.rm(ownerFile(vaultPath), { force: true });
        }
      ),
      { numRuns: 20 }
    );
  }, 30_000);

  it('leaves a copy that failed partway owned and tracked', async () => {
    const vaultPath = path.join(root, 'core-0123abcd');
    const tracker = new CopyTracker();
    const failure = new Error('disk full');
    await expect(
      createOwnedCopy(
        vaultPath,
        async (target) => {
          await makeDir(path.basename(target));
          throw failure;
        },
        { pid: 31, keep: false, tracker }
      )
    ).rejects.toBe(failure);
    expect(await readOwner(vaultPath)).toEqual({ pid: 31, keep: false });
    expect(tracker.takeSince(0)).toEqual([vaultPath]);
  });

  it('is owned by this process and tracked for the fixtures by default', async () => {
    const vaultPath = path.join(root, 'core-0123abcd');
    const mark = createdCopies.mark();
    await createOwnedCopy(vaultPath, async () => {}, { keep: true });
    expect(await readOwner(vaultPath)).toEqual({
      pid: process.pid,
      keep: true,
    });
    expect(createdCopies.takeSince(mark)).toEqual([vaultPath]);
  });
});

describe('disposeCopy', () => {
  it('removes the copy and its marker when cleanup is on', async () => {
    const vaultPath = path.join(root, 'core-0123abcd');
    await claimCopy(vaultPath, { pid: 1, keep: false });
    await makeDir('core-0123abcd');
    expect(await disposeCopy(vaultPath, { enabled: true })).toBe(true);
    expect(await listRoot()).toEqual([]);
  });

  it('leaves the copy and its marker alone when cleanup is off', async () => {
    const vaultPath = path.join(root, 'core-0123abcd');
    await claimCopy(vaultPath, { pid: 1, keep: true });
    await makeDir('core-0123abcd');
    const remove = vi.fn(async () => true);
    expect(await disposeCopy(vaultPath, { enabled: false, remove })).toBe(
      false
    );
    expect(remove).not.toHaveBeenCalled();
    expect(await listRoot()).toEqual([
      'core-0123abcd',
      'core-0123abcd.owner.json',
    ]);
  });

  it('keeps the marker for a later sweep when the copy stays locked', async () => {
    const vaultPath = path.join(root, 'core-0123abcd');
    await claimCopy(vaultPath, { pid: 1, keep: false });
    await makeDir('core-0123abcd');
    const remove = vi.fn(async () => false);
    expect(await disposeCopy(vaultPath, { enabled: true, remove })).toBe(false);
    expect(remove).toHaveBeenCalledWith(vaultPath);
    expect(await listRoot()).toEqual([
      'core-0123abcd',
      'core-0123abcd.owner.json',
    ]);
  });

  it('follows E2E_CLEANUP by default', async () => {
    const vaultPath = path.join(root, 'core-0123abcd');
    await makeDir('core-0123abcd');
    vi.stubEnv('E2E_CLEANUP', '0');
    try {
      await disposeCopy(vaultPath);
      expect(existsSync(vaultPath)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
    await disposeCopy(vaultPath);
    expect(existsSync(vaultPath)).toBe(false);
  });
});

describe('CopyTracker', () => {
  it('hands back exactly the copies tracked since a mark, once', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string()),
        fc.array(fc.string()),
        (before, after) => {
          const tracker = new CopyTracker();
          before.forEach((p) => tracker.track(p));
          const mark = tracker.mark();
          after.forEach((p) => tracker.track(p));
          expect(tracker.takeSince(mark)).toEqual(after);
          expect(tracker.takeSince(mark)).toEqual([]);
          expect(tracker.takeSince(0)).toEqual(before);
          expect(tracker.takeSince(0)).toEqual([]);
        }
      )
    );
  });
});

describe('isProcessAlive', () => {
  it('reports this process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('reports an exited process as gone', () => {
    const child = spawnSync(process.execPath, ['-e', 'process.pid'], {
      windowsHide: true,
    });
    expect(child.pid).toBeGreaterThan(0);
    expect(isProcessAlive(child.pid)).toBe(false);
  });

  it('counts a process it may not signal as alive', () => {
    const kill = vi.fn(() => {
      throw errorWithCode('EPERM');
    });
    expect(isProcessAlive(12, kill)).toBe(true);
    expect(kill).toHaveBeenCalledWith(12, 0);
  });

  it('counts any other signalling failure as gone', () => {
    fc.assert(
      fc.property(
        fc.option(
          fc.string().filter((c) => c !== 'EPERM'),
          { nil: undefined }
        ),
        (code) => {
          const kill = () => {
            throw errorWithCode(code);
          };
          expect(isProcessAlive(12, kill)).toBe(false);
        }
      )
    );
  });
});
