import { test as base } from '@playwright/test';
import { createdCopies, disposeCopy } from './vault-cleanup';

/**
 * Playwright's `test`, plus deleting every vault copy a test made once it ends
 * — passed, failed, or timed out — unless the run sets `E2E_CLEANUP=0`.
 *
 * Specs import `test` from here rather than deleting their own copies, so a
 * new spec cannot forget to. Test-scoped fixtures are torn down after
 * `afterEach`, which is where specs close Electron, so the copy is no longer
 * held open by then; a copy that still is gets retried, and failing that, the
 * global teardown sweeps it (see ./global-cleanup.ts).
 */
export const test = base.extend<
  { disposeTestVaults: void },
  { disposeWorkerVaults: void }
>({
  disposeTestVaults: [
    // Playwright requires the first argument to be destructured.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const mark = createdCopies.mark();
      await use();
      for (const vaultPath of createdCopies.takeSince(mark))
        await disposeCopy(vaultPath);
    },
    { auto: true },
  ],
  // Copies made in `beforeAll` outlive any one test.
  disposeWorkerVaults: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use();
      for (const vaultPath of createdCopies.takeSince(0))
        await disposeCopy(vaultPath);
    },
    { auto: true, scope: 'worker' },
  ],
});
