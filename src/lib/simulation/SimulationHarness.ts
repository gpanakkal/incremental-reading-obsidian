import { queryClient } from '#/lib/query-client';
import { resetSession, setCurrentItemId, store } from '#/lib/store';
import { afterEach, beforeEach, vi } from 'vitest';
import { FakeRepository } from './FakeRepository';
import { FakeReviewManager } from './FakeReviewManager';
import { FakeVault } from './FakeVault';

export { FakeRepository, FakeReviewManager, FakeVault };

export const FIXED_NOW = 1_700_000_000_000;
const FIXED_UUID = 'fixed-uuid-0000-0000-0000-000000000000';

export interface Harness {
  fakeVault: FakeVault;
  fakeRepo: FakeRepository;
  fakeRM: FakeReviewManager;
}

export function setupHarnessLifecycle(
  getHarness: () => Harness,
  setHarness: (h: Harness) => void,
  opts: { initialItemId?: string } = {}
) {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(FIXED_UUID as ReturnType<typeof crypto.randomUUID>);

    store.dispatch(resetSession());
    queryClient.clear();

    const fakeVault = new FakeVault();
    const fakeRepo = FakeRepository.create(fakeVault);
    const fakeRM = new FakeReviewManager();

    if (opts.initialItemId) {
      store.dispatch(setCurrentItemId(opts.initialItemId));
    }

    setHarness({ fakeVault, fakeRepo, fakeRM });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    store.dispatch(resetSession());
    queryClient.clear();
    // Suppress unused-variable lint for getHarness — it's used in tests via the ref
    void getHarness;
  });
}

/** A manually-resolvable promise gate for sequencing async operations in tests */
export function makeGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
