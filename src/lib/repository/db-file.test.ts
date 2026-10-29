import fc from 'fast-check';
import { readFileSync } from 'fs';
import type { DataAdapter } from 'obsidian';
import initSqlJs from 'sql.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  atomicReplace,
  dbFilePaths,
  fingerprintOf,
  isDatabaseBuffer,
  writeDatabaseFile,
  type DbFilePaths,
  type FileFingerprint,
} from './db-file';

// #region HELPERS

let sql: Promise<initSqlJs.SqlJsStatic> | null = null;

function getSql(): Promise<initSqlJs.SqlJsStatic> {
  return (sql ??= initSqlJs({
    wasmBinary: readFileSync(
      require.resolve('sql.js/dist/sql-wasm.wasm')
    ) as unknown as ArrayBuffer,
  }));
}

/** Every page size SQLite allows. */
const PAGE_SIZES = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];

/** A database file with a table of `rows` rows, at `pageSize`. */
async function databaseBytes(pageSize: number, rows: number) {
  const SQL = await getSql();
  const db = new SQL.Database();
  db.exec(`PRAGMA page_size = ${pageSize}; CREATE TABLE t (x TEXT)`);
  for (let i = 0; i < rows; i++) {
    db.run('INSERT INTO t VALUES (?)', ['x'.repeat(200)]);
  }
  const bytes = db.export();
  db.close();
  return bytes;
}

const databaseArb = fc
  .tuple(fc.constantFrom(...PAGE_SIZES), fc.integer({ min: 0, max: 60 }))
  .map(([pageSize, rows]) => ({ pageSize, rows }));

const PATHS = dbFilePaths('data/db.sqlite');

/** The calls `writeDatabaseFile` makes, in order, by name and path. */
type Calls = Array<[string, ...string[]]>;

/**
 * An adapter over `files` recording every call. `desktop` adds the
 * replacing rename (undocumented `fsPromises.rename`, with `getFullPath`)
 * and `update`. A file's mtime moves on whenever its bytes are replaced.
 */
function makeAdapter(
  files: Map<string, Uint8Array>,
  { desktop = true }: { desktop?: boolean } = {}
) {
  const calls: Calls = [];
  const mtimes = new Map<string, number>();
  let clock = 0;
  for (const path of files.keys()) mtimes.set(path, ++clock);
  const put = (path: string, bytes: Uint8Array, mtime = ++clock) => {
    files.set(path, bytes);
    mtimes.set(path, mtime);
  };
  const read = (path: string) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error(`ENOENT: ${path}`);
    return bytes;
  };
  const adapter = {
    writeBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
      calls.push(['writeBinary', path]);
      put(path, new Uint8Array(data.slice(0)));
    }),
    stat: vi.fn(async (path: string) => {
      calls.push(['stat', path]);
      const bytes = files.get(path);
      if (!bytes) return null;
      return {
        type: 'file' as const,
        ctime: 0,
        mtime: mtimes.get(path)!,
        size: bytes.byteLength,
      };
    }),
    copy: vi.fn(async (from: string, to: string) => {
      calls.push(['copy', from, to]);
      if (files.has(to)) throw new Error(`EEXIST: ${to}`);
      put(to, read(from).slice());
    }),
    remove: vi.fn(async (path: string) => {
      calls.push(['remove', path]);
      read(path);
      files.delete(path);
    }),
    ...(desktop && {
      getFullPath: vi.fn((path: string) => `/vault/${path}`),
      fsPromises: {
        rename: vi.fn(async (from: string, to: string) => {
          calls.push(['rename', from, to]);
          const path = (full: string) => full.slice('/vault/'.length);
          const bytes = read(path(from));
          const mtime = mtimes.get(path(from));
          files.delete(path(from));
          put(path(to), bytes, mtime);
        }),
      },
      update: vi.fn(async (path: string) => {
        calls.push(['update', path]);
      }),
    }),
  };
  return {
    adapter,
    calls,
    asAdapter: adapter as unknown as DataAdapter,
  };
}

function writeOptions(overrides: {
  stillCurrent?: () => boolean;
  knownGood?: FileFingerprint | null;
}) {
  return {
    stillCurrent: overrides.stillCurrent ?? (() => true),
    knownGood: () => overrides.knownGood ?? null,
  };
}

async function liveFingerprint(
  adapter: ReturnType<typeof makeAdapter>['adapter'],
  paths: DbFilePaths
) {
  const fingerprint = await fingerprintOf(
    adapter as unknown as DataAdapter,
    paths.live
  );
  adapter.stat.mockClear();
  return fingerprint;
}

// #endregion

describe('isDatabaseBuffer', () => {
  it('property: accepts every database file SQLite writes, at every page size', async () => {
    await fc.assert(
      fc.asyncProperty(databaseArb, async ({ pageSize, rows }) => {
        expect(isDatabaseBuffer(await databaseBytes(pageSize, rows))).toBe(
          true
        );
      }),
      { numRuns: 30 }
    );
  });

  it('property: refuses every database file cut short, at a page boundary or not', async () => {
    await fc.assert(
      fc.asyncProperty(
        databaseArb,
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
        fc.boolean(),
        async ({ pageSize, rows }, at, onBoundary) => {
          const bytes = await databaseBytes(pageSize, rows);
          let cut = Math.floor(at * bytes.length);
          if (onBoundary) cut -= cut % pageSize;
          expect(isDatabaseBuffer(bytes.slice(0, cut))).toBe(false);
        }
      ),
      { numRuns: 60 }
    );
  });

  it('property: refuses a file whose header is not SQLite’s', async () => {
    const bytes = await databaseBytes(4096, 3);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 15 }),
        fc.integer({ min: 1, max: 255 }),
        (at, flip) => {
          const changed = bytes.slice();
          changed[at] ^= flip;
          expect(isDatabaseBuffer(changed)).toBe(false);
        }
      )
    );
  });

  it('property: refuses a page size SQLite never writes', async () => {
    const bytes = await databaseBytes(4096, 3);
    fc.assert(
      fc.property(
        fc
          .integer({ min: 0, max: 0xffff })
          .filter((raw) => raw !== 1 && !PAGE_SIZES.includes(raw)),
        (raw) => {
          const changed = bytes.slice();
          new DataView(changed.buffer).setUint16(16, raw);
          expect(isDatabaseBuffer(changed)).toBe(false);
        }
      )
    );
  });

  it('property: trusts the page count only while the header says it is valid', async () => {
    const bytes = await databaseBytes(4096, 3);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 32 - 1 }),
        fc.boolean(),
        (pages, valid) => {
          const changed = bytes.slice();
          const header = new DataView(changed.buffer);
          header.setUint32(28, pages);
          if (!valid) header.setUint32(92, header.getUint32(24) + 1);
          expect(isDatabaseBuffer(changed)).toBe(
            !valid || pages * 4096 === bytes.length
          );
        }
      )
    );
  });

  it('refuses every start of a database file too short to hold its header', async () => {
    const bytes = await databaseBytes(4096, 3);
    for (let length = 0; length <= 100; length++) {
      expect(isDatabaseBuffer(bytes.slice(0, length))).toBe(false);
    }
  });

  it('reads a page size of 1 as 65536', async () => {
    const bytes = await databaseBytes(65536, 1);
    expect(new DataView(bytes.buffer).getUint16(16)).toBe(1);
    expect(isDatabaseBuffer(bytes)).toBe(true);
  });

  it('refuses a file of one page, which holds no table', async () => {
    const bytes = await databaseBytes(4096, 0);
    expect(isDatabaseBuffer(bytes.slice(0, 4096))).toBe(false);
  });

  /**
   * The first `pages` pages of a database file of 4096-byte pages, its page
   * size field set to `raw`, and the header's page count marked stale, so
   * only the other checks decide.
   */
  async function uncounted(pages: number, raw = 4096, extra = 0) {
    const bytes = await databaseBytes(4096, 60);
    const cut = bytes.slice(0, pages * 4096 + extra);
    const header = new DataView(cut.buffer);
    header.setUint16(16, raw);
    header.setUint32(92, header.getUint32(24) + 1);
    return cut;
  }

  it('property: without a page count to go by, accepts whole pages, more than one', async () => {
    const bytes = await databaseBytes(4096, 60);
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: bytes.length / 4096 }),
        async (pages) => {
          expect(isDatabaseBuffer(await uncounted(pages))).toBe(true);
        }
      ),
      { numRuns: 10 }
    );
  });

  it.each([
    ['a single page', 1, 0],
    ['part of a page past the last', 2, 512],
  ])('without a page count to go by, refuses %s', async (_, pages, extra) => {
    expect(isDatabaseBuffer(await uncounted(pages, 4096, extra))).toBe(false);
  });

  it.each([
    // Each divides the 12288 bytes of three 4096-byte pages
    ['a page size that is no power of two', 1536],
    ['a page size that is no power of two', 3072],
    ['a power of two under 512', 256],
    ['a power of two under 512', 128],
  ])('without a page count to go by, refuses %s (%i)', async (_, raw) => {
    expect(isDatabaseBuffer(await uncounted(3, raw))).toBe(false);
  });
});

describe('dbFilePaths', () => {
  const segmentArb = fc
    .string({ minLength: 1, maxLength: 8 })
    .filter((segment) => !/[/\\]/.test(segment) && segment.trim() === segment)
    .filter((segment) => segment !== '.' && segment !== '..');

  it('property: puts every sibling beside the live file, hidden and apart from it and each other', () => {
    fc.assert(
      fc.property(
        fc.array(segmentArb, { maxLength: 3 }),
        segmentArb,
        fc.date({
          min: new Date(2000, 0, 1),
          max: new Date(2100, 0, 1),
          noInvalidDate: true,
        }),
        (folders, name, date) => {
          const live = [...folders, name].join('/');
          const paths = dbFilePaths(live);
          const folder = live.slice(0, live.length - name.length);
          const siblings = [paths.tmp, paths.prev, paths.corrupt(date)];
          expect(new Set([paths.live, ...siblings]).size).toBe(4);
          for (const sibling of siblings) {
            expect(sibling.startsWith(`${folder}.${name}.`)).toBe(true);
            expect(sibling.slice(folder.length)).not.toContain('/');
          }
          expect(paths.corrupt(date)).toContain(
            date.toISOString().slice(0, 10)
          );
          // No `:`, which Windows refuses in a file name
          expect(paths.corrupt(date).split('.corrupt-').pop()).not.toMatch(
            /[:]/
          );
        }
      )
    );
  });

  it('names corrupt copies of different moments apart', () => {
    const paths = dbFilePaths('a/b.sqlite');
    expect(paths.corrupt(new Date(1))).not.toBe(paths.corrupt(new Date(2)));
  });

  it('property: stamps a corrupt copy with its moment, every : and . as -', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date(2000, 0, 1),
          max: new Date(2100, 0, 1),
          noInvalidDate: true,
        }),
        (date) => {
          const iso = date.toISOString();
          expect(dbFilePaths('a/b.sqlite').corrupt(date)).toBe(
            `a/.b.sqlite.corrupt-${iso.slice(0, 10)}T${iso
              .slice(11, 23)
              .split(/[:.]/)
              .join('-')}Z`
          );
        }
      )
    );
  });
});

describe('atomicReplace', () => {
  it.each([
    ['no fsPromises', {}],
    ['no rename', { fsPromises: {}, getFullPath: (p: string) => p }],
    ['no getFullPath', { fsPromises: { rename: async () => {} } }],
  ])('is null on an adapter with %s, as on mobile', (_, adapter) => {
    expect(atomicReplace(adapter as unknown as DataAdapter)).toBeNull();
  });

  it('renames between the full paths, called on the adapter and its fsPromises', async () => {
    const files = new Map([['a', new Uint8Array([1])]]);
    const { adapter, asAdapter } = makeAdapter(files);
    const replace = atomicReplace(asAdapter)!;
    await replace('a', 'b');
    expect(adapter.fsPromises!.rename).toHaveBeenCalledWith(
      '/vault/a',
      '/vault/b'
    );
    expect(adapter.fsPromises!.rename.mock.contexts[0]).toBe(
      adapter.fsPromises
    );
    expect(adapter.getFullPath!.mock.contexts[0]).toBe(adapter);
    expect(files.get('b')).toEqual(new Uint8Array([1]));
  });
});

describe('writeDatabaseFile', () => {
  let data: ArrayBuffer;
  let old: Uint8Array;

  beforeEach(async () => {
    data = (await databaseBytes(4096, 5)).buffer as ArrayBuffer;
    old = await databaseBytes(4096, 2);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('property: refuses anything but a whole database, touching nothing', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ maxLength: 9000 }),
        fc.boolean(),
        async (bytes, desktop) => {
          fc.pre(!isDatabaseBuffer(bytes));
          const files = new Map([[PATHS.live, old]]);
          const { calls, asAdapter } = makeAdapter(files, { desktop });
          await expect(
            writeDatabaseFile(
              asAdapter,
              PATHS,
              bytes.slice().buffer,
              writeOptions({})
            )
          ).rejects.toThrow(String(bytes.byteLength));
          expect(calls).toEqual([]);
        }
      )
    );
  });

  it('on desktop, writes the hidden sibling and renames it over the live file', async () => {
    const files = new Map([[PATHS.live, old]]);
    const { adapter, calls, asAdapter } = makeAdapter(files);
    const result = await writeDatabaseFile(
      asAdapter,
      PATHS,
      data,
      writeOptions({})
    );
    expect(calls).toEqual([
      ['writeBinary', PATHS.tmp],
      ['stat', PATHS.tmp],
      ['rename', `/vault/${PATHS.tmp}`, `/vault/${PATHS.live}`],
      ['update', PATHS.live],
    ]);
    expect(files.get(PATHS.live)).toEqual(new Uint8Array(data));
    expect(files.has(PATHS.tmp)).toBe(false);
    expect(result).toEqual({
      landed: true,
      fingerprint: await liveFingerprint(adapter, PATHS),
    });
  });

  it('on desktop, lands without `update`, leaving the change to the file watcher', async () => {
    const files = new Map([[PATHS.live, old]]);
    const { adapter, asAdapter } = makeAdapter(files);
    delete (adapter as { update?: unknown }).update;
    const result = await writeDatabaseFile(
      asAdapter,
      PATHS,
      data,
      writeOptions({})
    );
    expect(result.landed).toBe(true);
    expect(files.get(PATHS.live)).toEqual(new Uint8Array(data));
  });

  it('settles only once `update` has reported the file', async () => {
    const files = new Map([[PATHS.live, old]]);
    const { adapter, asAdapter } = makeAdapter(files);
    let reported = false;
    adapter.update!.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      reported = true;
    });
    await writeDatabaseFile(asAdapter, PATHS, data, writeOptions({}));
    expect(reported).toBe(true);
  });

  it('lands when `update` fails, which only delays the index', async () => {
    const files = new Map([[PATHS.live, old]]);
    const { adapter, asAdapter } = makeAdapter(files);
    adapter.update!.mockRejectedValueOnce(new Error('boom'));
    const result = await writeDatabaseFile(
      asAdapter,
      PATHS,
      data,
      writeOptions({})
    );
    expect(result.landed).toBe(true);
  });

  it('on mobile, writes the hidden sibling, then the live file in place, then deletes the sibling', async () => {
    const files = new Map([[PATHS.live, old]]);
    const { adapter, calls, asAdapter } = makeAdapter(files, {
      desktop: false,
    });
    const result = await writeDatabaseFile(
      asAdapter,
      PATHS,
      data,
      writeOptions({})
    );
    expect(calls).toEqual([
      ['writeBinary', PATHS.tmp],
      ['stat', PATHS.tmp],
      ['writeBinary', PATHS.live],
      ['stat', PATHS.live],
      ['remove', PATHS.tmp],
    ]);
    expect(files.get(PATHS.live)).toEqual(new Uint8Array(data));
    expect(files.has(PATHS.tmp)).toBe(false);
    expect(result).toEqual({
      landed: true,
      fingerprint: await liveFingerprint(adapter, PATHS),
    });
  });

  it('writes in place when the rename fails, as Windows refuses one over a file held open', async () => {
    const files = new Map([[PATHS.live, old]]);
    const { adapter, asAdapter } = makeAdapter(files);
    adapter.fsPromises!.rename.mockRejectedValueOnce(new Error('EPERM'));
    const result = await writeDatabaseFile(
      asAdapter,
      PATHS,
      data,
      writeOptions({})
    );
    expect(result.landed).toBe(true);
    expect(files.get(PATHS.live)).toEqual(new Uint8Array(data));
    expect(files.has(PATHS.tmp)).toBe(false);
    expect(adapter.update).not.toHaveBeenCalled();
  });

  it('lands when tidying up after an in-place write fails, with no fingerprint if the stat did', async () => {
    const files = new Map([[PATHS.live, old]]);
    const { adapter, asAdapter } = makeAdapter(files, { desktop: false });
    adapter.stat.mockImplementation(async (path: string) =>
      path === PATHS.tmp
        ? { type: 'file', ctime: 0, mtime: 1, size: data.byteLength }
        : Promise.reject(new Error('EIO'))
    );
    const result = await writeDatabaseFile(
      asAdapter,
      PATHS,
      data,
      writeOptions({})
    );
    expect(result).toEqual({ landed: true, fingerprint: null });
    expect(files.get(PATHS.live)).toEqual(new Uint8Array(data));
  });

  it('property: stops writing once the write is no longer current, leaving the live file as it was', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 4 }),
        fc.boolean(),
        fc.boolean(),
        async (currentFor, desktop, renameFails) => {
          const files = new Map([[PATHS.live, old]]);
          const { adapter, calls, asAdapter } = makeAdapter(files, {
            desktop,
          });
          if (desktop && renameFails) {
            adapter.fsPromises!.rename.mockRejectedValueOnce(
              new Error('EPERM')
            );
          }
          let asked = 0;
          const stillCurrent = () => asked++ < currentFor;
          const result = await writeDatabaseFile(
            asAdapter,
            PATHS,
            data,
            writeOptions({ stillCurrent })
          );
          // Asked before the sibling, before keeping `prev`, before the live
          // file, and again before writing in place after a failed rename
          const checks = desktop && renameFails ? 4 : 3;
          const landed = currentFor >= checks;
          expect(result.landed).toBe(landed);
          expect(files.get(PATHS.live)).toEqual(
            landed ? new Uint8Array(data) : old
          );
          if (currentFor === 0) expect(calls).toEqual([]);
        }
      )
    );
  });

  it.each([
    ['nothing at all', null],
    ['nothing of that size', 3],
  ])(
    'throws when the sibling holds %s once written, touching the live file no more',
    async (_, size) => {
      const files = new Map([[PATHS.live, old]]);
      const { adapter, calls, asAdapter } = makeAdapter(files);
      adapter.stat.mockResolvedValueOnce(
        size === null ? null : { type: 'file', ctime: 0, mtime: 0, size }
      );
      await expect(
        writeDatabaseFile(asAdapter, PATHS, data, writeOptions({}))
      ).rejects.toThrow(`${size ?? 0} of ${data.byteLength}`);
      expect(files.get(PATHS.live)).toBe(old);
      expect(calls).toEqual([['writeBinary', PATHS.tmp]]);
      expect(adapter.stat).toHaveBeenCalledExactlyOnceWith(PATHS.tmp);
    }
  );

  it('property: copies the live file to `prev` only while it is the file known good, replacing what `prev` held', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('none', 'same', 'size', 'mtime'),
        fc.boolean(),
        fc.boolean(),
        async (known, hadPrev, desktop) => {
          const earlier = new Uint8Array([9, 9]);
          const files = new Map([[PATHS.live, old]]);
          if (hadPrev) files.set(PATHS.prev, earlier);
          const { adapter, asAdapter } = makeAdapter(files, { desktop });
          const live = (await liveFingerprint(adapter, PATHS))!;
          const knownGood = {
            none: null,
            same: live,
            size: { ...live, size: live.size + 1 },
            mtime: { ...live, mtime: live.mtime + 1 },
          }[known];
          await writeDatabaseFile(
            asAdapter,
            PATHS,
            data,
            writeOptions({ knownGood })
          );
          expect(files.get(PATHS.live)).toEqual(new Uint8Array(data));
          if (known === 'same') expect(files.get(PATHS.prev)).toEqual(old);
          else
            expect(files.get(PATHS.prev)).toBe(hadPrev ? earlier : undefined);
        }
      ),
      { timeout: 15000 }
    );
  });

  it('keeps no `prev` when there is no live file to copy, and still lands', async () => {
    const files = new Map<string, Uint8Array>();
    const { asAdapter } = makeAdapter(files);
    const result = await writeDatabaseFile(
      asAdapter,
      PATHS,
      data,
      writeOptions({ knownGood: { size: 1, mtime: 1 } })
    );
    expect(result.landed).toBe(true);
    expect(files.has(PATHS.prev)).toBe(false);
  });

  it('lands when keeping `prev` fails, which only costs the copy', async () => {
    const files = new Map([[PATHS.live, old]]);
    const { adapter, asAdapter } = makeAdapter(files);
    const live = await liveFingerprint(adapter, PATHS);
    adapter.copy.mockRejectedValueOnce(new Error('ENOSPC'));
    const result = await writeDatabaseFile(
      asAdapter,
      PATHS,
      data,
      writeOptions({ knownGood: live })
    );
    expect(result.landed).toBe(true);
    expect(files.get(PATHS.live)).toEqual(new Uint8Array(data));
  });
});

describe('fingerprintOf', () => {
  it('is null for a file that is not there', async () => {
    const { asAdapter } = makeAdapter(new Map());
    expect(await fingerprintOf(asAdapter, 'x')).toBeNull();
  });

  it('is the size and mtime of a file that is there', async () => {
    const { asAdapter } = makeAdapter(new Map([['x', new Uint8Array(3)]]));
    expect(await fingerprintOf(asAdapter, 'x')).toEqual({ size: 3, mtime: 1 });
  });
});
