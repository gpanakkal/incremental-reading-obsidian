import { CURRENT_ITEM_REFETCH_TIME } from '#/lib/constants';
import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import {
  executeCommandById,
  importArticle,
  leafSnapshot,
  waitForReviewItem,
} from './helpers';
import {
  closeElectron,
  createVaultCopy,
  launchElectron,
  openVault,
  shouldCleanup,
} from './setup/helpers';

let app: ElectronApplication;
let window: Page;
let vaultPath: string;

const ERROR_TEXT =
  "Couldn't load the review item. See the developer console for details.";

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('core');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
  // CI runs headed in a small window; pin it so layout matches everywhere
  await window.setViewportSize({ width: 1280, height: 800 });
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
  if (shouldCleanup) {
    await fs
      .rm(vaultPath, { recursive: true, force: true, maxRetries: 3 })
      .catch(() => {});
  }
});

// #region HELPERS

/**
 * What the page-side calls below reach. `window.app` and `app.plugins` are
 * unofficial Obsidian API: stable in practice, but undocumented.
 */
type PageWindow = {
  app: {
    plugins: {
      plugins: Record<
        string,
        {
          reviewManager: {
            repo: {
              query: (
                sql: string,
                params?: unknown[],
                options?: { throwOnError?: boolean }
              ) => unknown;
            };
          };
        }
      >;
    };
  };
  __diag?: {
    /** Failed reads counted while the stub is in place. */
    failedReads: number;
    /**
     * Spinners and summaries put on screen since {@link watchForFlashes}:
     * counted in the page, since one that lasts a frame falls between any two
     * reads from here.
     */
    flashes: number;
    restore: () => void;
  };
};

/**
 * Make every read that asks to be told of a failure fail, as an unreadable
 * table would; reads that ask for the empty-array fallback still succeed. Left
 * in place until {@link restoreReads}.
 */
async function failCheckedReads(window: Page) {
  await window.evaluate(() => {
    const page = window as unknown as PageWindow;
    const { repo } =
      page.app.plugins.plugins['incremental-reading'].reviewManager;
    const original = repo.query;
    const diag = {
      failedReads: 0,
      flashes: 0,
      restore: () => {
        // Back to the prototype's own method
        Reflect.deleteProperty(repo, 'query');
      },
    };
    page.__diag = diag;
    repo.query = (sql, params, options) => {
      if (options?.throwOnError) {
        diag.failedReads += 1;
        throw new Error('no such table: article');
      }
      return original.call(repo, sql, params, options);
    };
  });
}

/** Start counting what replaces the error, from here on. */
async function watchForFlashes(window: Page) {
  await window.evaluate(() => {
    const diag = (window as unknown as PageWindow).__diag;
    if (!diag) throw new Error('reads are not stubbed');
    const isFlash = (node: Node) =>
      node instanceof HTMLElement &&
      (node.matches('.ir-loading, .ir-review-summary') ||
        node.querySelector('.ir-loading, .ir-review-summary') !== null);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        diag.flashes += [...record.addedNodes].filter(isFlash).length;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const restore = diag.restore;
    diag.restore = () => {
      observer.disconnect();
      restore();
    };
  });
}

async function flashes(window: Page): Promise<number> {
  return await window.evaluate(
    () => (window as unknown as PageWindow).__diag?.flashes ?? 0
  );
}

async function failedReads(window: Page): Promise<number> {
  return await window.evaluate(
    () => (window as unknown as PageWindow).__diag?.failedReads ?? 0
  );
}

async function restoreReads(window: Page) {
  await window.evaluate(() =>
    (window as unknown as PageWindow).__diag?.restore()
  );
}

// #endregion

test('review says it could not load, never that nothing is due, and recovers on the next poll', async () => {
  await importArticle(
    window,
    'sources/Memorizing a programming language using spaced repetition'
  );
  await executeCommandById(window, 'incremental-reading:learn');
  const beginReview = window.locator('css=#begin-review-button');
  // The queue read before the failure, so Begin Review is still on offer
  await expect(beginReview).toBeEnabled();

  await failCheckedReads(window);
  await beginReview.click();

  const error = window.locator('.ir-review-error');
  await expect(error).toHaveText(ERROR_TEXT);
  await expect(window.getByText('Nothing due for review.')).toHaveCount(0);
  expect((await leafSnapshot(window)).currentItemId).toBeNull();
  await watchForFlashes(window);

  // Still the error across a poll that fails again: no spinner, no summary,
  // and the poll does not stop on a failure, nor hammer the database
  const readsBefore = await failedReads(window);
  await expect
    .poll(() => failedReads(window), {
      timeout: CURRENT_ITEM_REFETCH_TIME + 3_000,
    })
    .toBeGreaterThan(readsBefore);
  await expect(error).toHaveText(ERROR_TEXT);
  expect(await flashes(window)).toBe(0);
  expect(await failedReads(window)).toBeLessThanOrEqual(readsBefore + 6);

  // Nothing but the poll asks again, so landing on the item within one
  // interval is the poll recovering review in place
  await restoreReads(window);
  await expect(error).toHaveCount(0, {
    timeout: CURRENT_ITEM_REFETCH_TIME + 3_000,
  });
  const item = await waitForReviewItem(window);
  expect(item.title).toBe(
    'Memorizing a programming language using spaced repetition software'
  );
});
