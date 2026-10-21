import { SQLJSRepository } from '#/lib/repository/SQLJSRepository';
import type { App } from 'obsidian';
import { vi } from 'vitest';
import type { FakeVault } from './FakeVault';

export class FakeRepository extends SQLJSRepository {
  static create(
    fakeVault: FakeVault,
    dbFilePath = 'ir-user-data.sqlite',
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
      export: vi.fn(() => new Uint8Array(8)),
      updateHook: vi.fn(),
      create_function: vi.fn(),
    } as unknown as (typeof repo)['db'];
    return repo;
  }

  // Expose the protected counter for assertions
  get pendingSaveCountForTest(): number {
    return this.pendingSaveCount;
  }

  // Override reloadDb to be a no-op by default; tests spy on it to control timing
  protected override async reloadDb() {
    return this.db;
  }
}
