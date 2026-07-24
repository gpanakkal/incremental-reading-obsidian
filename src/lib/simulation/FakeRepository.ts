import { SQLJSRepository } from '#/lib/repository/SQLJSRepository';
import type { App } from 'obsidian';
import { vi } from 'vitest';
import type { FakeVault } from './FakeVault';

export class FakeRepository extends SQLJSRepository {
  static create(
    fakeVault: FakeVault,
    dbFilePath = 'ir-user-data.sqlite'
  ): FakeRepository {
    const repo = new FakeRepository({
      app: fakeVault.app as unknown as App,
      dbFilePath,
      schema: '',
    });
    // Stub db so mutate/query/save don't throw. `updateHook` is re-armed after
    // every save (real sql.js drops it on export), so the stub must accept it.
    repo.db = {
      exec: vi.fn(() => []),
      export: vi.fn(() => new Uint8Array(8)),
      updateHook: vi.fn(),
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
