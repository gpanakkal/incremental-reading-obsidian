import { SQLJSRepository } from '#/lib/repository/SQLJSRepository';
import type { ReplaySettings } from '#/lib/repository/scheduling-replay';
import { readFileSync } from 'fs';
import type { App } from 'obsidian';
import { resolve } from 'path';
import initSqlJs from 'sql.js';
import { vi } from 'vitest';
import { DEFAULT_DB_PATH, type FakeVault } from './FakeVault';

const SCHEMA = readFileSync(resolve(__dirname, '../../db/schema.sql'), 'utf-8');

let sharedSql: Promise<initSqlJs.SqlJsStatic> | null = null;

/** The sql.js module, read from node_modules once for every fake. */
function getSql(): Promise<initSqlJs.SqlJsStatic> {
  return (sharedSql ??= initSqlJs({
    wasmBinary: readFileSync(
      require.resolve('sql.js/dist/sql-wasm.wasm')
    ) as unknown as ArrayBuffer,
  }));
}

export class FakeRepository extends SQLJSRepository {
  /** Whether `db` is the stub of {@link create} rather than a real database. */
  #stub = true;

  static create(
    fakeVault: FakeVault,
    dbFilePath = DEFAULT_DB_PATH,
    deviceId = 'fake-device'
  ): FakeRepository {
    const repo = new FakeRepository({
      app: fakeVault.app as unknown as App,
      dbFilePath,
      schema: '',
      deviceId,
    });
    // Stub db so mutate/query/save don't throw. `updateHook` and the row
    // stamps are re-armed after every save (real sql.js drops both on
    // export), so the stub must accept them. It has no tables, so nothing is
    // stamped: stamps are the real database's (see `armRowStamps`).
    repo.db = {
      exec: vi.fn(() => []),
      run: vi.fn(), // the write stamp each save bumps
      export: vi.fn(() => new Uint8Array(8)),
      updateHook: vi.fn(),
      create_function: vi.fn(),
    } as unknown as (typeof repo)['db'];
    return repo;
  }

  /**
   * A repository over a real sql.js database, as one device runs it: loaded
   * from the file on `fakeVault`'s disk if there is one, or made new. Every
   * reload is the production one, so a file another device wrote is
   * classified by its write stamp and taken on or left alone for real.
   * @param clock stands in for `Date.now` as the clock of stamps
   */
  static async createReal(
    fakeVault: FakeVault,
    opts: {
      deviceId: string;
      clock?: () => number;
      dbFilePath?: string;
      replaySettings?: () => ReplaySettings;
    }
  ): Promise<FakeRepository> {
    const dbFilePath = opts.dbFilePath ?? DEFAULT_DB_PATH;
    const repo = new FakeRepository({
      app: fakeVault.app as unknown as App,
      dbFilePath,
      schema: SCHEMA,
      deviceId: opts.deviceId,
      stampClock: opts.clock,
      replaySettings: opts.replaySettings,
    });
    repo.#stub = false;
    const onDisk = fakeVault.adapter.diskBytes(dbFilePath)?.byteLength;
    const db = onDisk ? await repo.loadDb() : await repo.initDb();
    if (!db) throw new Error('FakeRepository: no database to start on');
    return repo;
  }

  // Expose the protected counter for assertions
  get pendingSaveCountForTest(): number {
    return this.pendingSaveCount;
  }

  /**
   * Wait out the saves under way, which a reload can start without being
   * awaited (see `handleFileChange`). Against a vault whose writes land at
   * once each takes a handful of microtasks.
   */
  async settle(): Promise<void> {
    for (let i = 0; i < 100 && this.pendingSaveCount > 0; i++) {
      await Promise.resolve();
    }
  }

  protected override loadWasm() {
    return getSql();
  }

  // A no-op over the stub; tests spy on it to control timing
  protected override async reloadDb(bytes?: ArrayBuffer, localCopy?: boolean) {
    return this.#stub ? this.db : super.reloadDb(bytes, localCopy);
  }
}
