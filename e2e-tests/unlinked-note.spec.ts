import { ARTICLE_TAG } from '#/lib/constants';
import { expect, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  executeCommandById,
  openFileInActiveLeaf,
  setNativeMenus,
  waitForReviewItem,
} from './helpers';
import { test } from './setup/fixtures';
import {
  closeElectron,
  createVaultCopy,
  launchElectron,
  openVault,
} from './setup/helpers';

let app: ElectronApplication;
let window: Page;
let vaultPath: string;

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('unlinked');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
  await setNativeMenus(window, false);
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
});

// #region HELPERS

/**
 * What the page-side calls below reach on Obsidian and the plugin.
 * `window.app` and `app.plugins` are unofficial Obsidian API: stable in
 * practice, but undocumented.
 */
type PageApp = {
  vault: { getFileByPath(path: string): unknown };
  metadataCache: {
    getFileCache(file: unknown): { frontmatter?: Record<string, unknown> };
  };
  plugins: {
    plugins: Record<
      string,
      {
        reviewManager: {
          repo: { mutate(sql: string, params?: unknown[]): Promise<unknown> };
        };
      }
    >;
  };
};

/** The article note the cases damage, at the vault's top. */
const NOTE = 'Unlinked article.md';

/** Run `sql` against the running plugin's database. */
const mutate = (sql: string, params: unknown[] = []) =>
  window.evaluate(
    async ([sql, params]) => {
      const { app } = window as unknown as { app: PageApp };
      const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
      await repo.mutate(sql, params);
    },
    [sql, params] as const
  );

/** The `ir-id` the metadata cache holds for the note at `at`. */
const cachedIrId = (at: string) =>
  window.evaluate((at) => {
    const { app } = window as unknown as { app: PageApp };
    const file = app.vault.getFileByPath(at);
    return file
      ? (app.metadataCache.getFileCache(file)?.frontmatter?.['ir-id'] ?? null)
      : null;
  }, at);

/**
 * An article due now, `art`, at {@link NOTE}, whose note carries `irIdLine`
 * (nothing, for an id taken off): the note as it arrives over Sync, or as an
 * edit made while the plugin was off leaves it, with no write here to see.
 * The note is written first, so the row finds it there.
 */
async function seedDamagedArticle(irIdLine: string) {
  await fs.writeFile(
    path.join(vaultPath, NOTE),
    `---\n${irIdLine}tags:\n  - ${ARTICLE_TAG}\n---\nSome text.\n`
  );
  await expect
    .poll(() =>
      window.evaluate(
        (at) =>
          (window as unknown as { app: PageApp }).app.vault.getFileByPath(
            at
          ) !== null,
        NOTE
      )
    )
    .toBe(true);
  await mutate(
    `INSERT INTO article (id, reference, due, interval, priority)
     VALUES ('art', $1, $2, 86400000, 30)`,
    [NOTE, Date.now() - 60_000]
  );
}

/** The row the damaged-notes notice lists for {@link NOTE}. */
const noticeRow = () =>
  window
    .locator('.notice.ir-damaged-notes-notice .ir-damaged-note')
    .and(window.locator(`[data-path="${NOTE}"]`));

/**
 * The Re-associate the notice's row of buttons for {@link NOTE} offers for
 * the article's row.
 */
const reassociateButton = () =>
  noticeRow().locator('.ir-damaged-note-actions button[data-id="art"]');

/** The edit-mode action bar on the note's tab. */
const actionBar = () =>
  window.locator('.mod-root .markdown-source-view .ir-action-bar-panel');

/** The queue row of {@link NOTE}. */
const queueRow = () =>
  window.locator('.ir-queue-row').filter({ hasText: 'Unlinked article' });

// #endregion

for (const [damage, irIdLine] of [
  ['taken off', ''],
  ['changed to one no row holds', 'ir-id: no-such-item\n'],
] as const) {
  test(`offers an article note whose ir-id was ${damage} elsewhere to be re-associated as it opens, which makes it the article's note again and unflags its queue row`, async () => {
    await seedDamagedArticle(irIdLine);

    await openFileInActiveLeaf(window, NOTE);
    const offered = noticeRow().locator('.ir-damaged-note-actions [data-id]');
    await expect(offered).toHaveCount(1);
    await expect(offered).toHaveAttribute('data-by', 'path');
    await expect(offered).toHaveAttribute('data-id', 'art');
    if (irIdLine === '') {
      // A note claiming no id at an article's path is no item's, and has no bar
      await expect(actionBar()).toHaveCount(0);
    }

    await reassociateButton().click();

    await expect(noticeRow()).toHaveCount(0);
    await expect.poll(() => cachedIrId(NOTE)).toBe('art');
    await expect(actionBar()).toBeVisible();
    await executeCommandById(window, 'incremental-reading:learn');
    await expect(queueRow()).toHaveCount(1);
    await expect(queueRow()).not.toHaveAttribute('data-unlinked');
    await expect(queueRow().locator('.ir-queue-unlinked-badge')).toHaveCount(0);
  });
}

test("flags the queue row of an article whose note doesn't hold its id, and opens it in review, which offers to re-associate it", async () => {
  await seedDamagedArticle('');

  await executeCommandById(window, 'incremental-reading:learn');
  await expect(queueRow()).toHaveAttribute('data-unlinked', '');
  await expect(queueRow().locator('.ir-queue-unlinked-badge')).toBeVisible();
  await expect(queueRow().locator('.ir-queue-missing-badge')).toHaveCount(0);

  await queueRow().click();
  const shown = await waitForReviewItem(window);
  expect(shown.id).toBe('art');
  const offered = noticeRow().locator('.ir-damaged-note-actions [data-id]');
  await expect(offered).toHaveCount(1);

  await reassociateButton().click();
  await expect(noticeRow()).toHaveCount(0);
  await expect.poll(() => cachedIrId(NOTE)).toBe('art');
});

test("opens in review the queue row of an article whose note claims another's id, that article's own note still in place, and keeps each row's buttons in its own block", async () => {
  const other = 'Other article.md';
  await fs.writeFile(
    path.join(vaultPath, other),
    `---\nir-id: other\ntags:\n  - ${ARTICLE_TAG}\n---\nOther text.\n`
  );
  await expect.poll(() => cachedIrId(other)).toBe('other');
  await mutate(
    `INSERT INTO article (id, reference, due, interval, priority)
     VALUES ('other', $1, $2, 86400000, 30)`,
    [other, Date.now() + 86_400_000]
  );
  // A copy of the other article's note, laid over this article's
  await seedDamagedArticle('ir-id: other\n');
  const block = (id: string) =>
    noticeRow().locator(`.ir-damaged-note-candidate[data-id="${id}"]`);

  // Its queue row opens the note in review, as any row's does, not the
  // summary, and review showing it raises the notice. Bounded inside
  // `CURRENT_ITEM_REFETCH_TIME`, so only the click's own fetch can pass it
  await executeCommandById(window, 'incremental-reading:learn');
  await expect(queueRow()).toHaveAttribute('data-unlinked', '');
  await queueRow().click();
  const pane = window.locator('.workspace-leaf.mod-active');
  await expect(pane.locator('.ir-title')).toContainText('Unlinked article', {
    timeout: 3_000,
  });
  await expect(pane.locator('.ir-review-summary')).toHaveCount(0);
  expect((await waitForReviewItem(window)).id).toBe('art');
  await expect(block('art')).toHaveAttribute('data-by', 'path');

  await openFileInActiveLeaf(window, NOTE);
  await expect(block('art')).toHaveAttribute('data-by', 'path');
  await expect(block('other')).toHaveAttribute('data-blocked', 'occupied');
  await expect(
    block('other').locator('.ir-damaged-note-blocked')
  ).toBeVisible();
  await expect(block('other').locator('button.mod-cta')).toHaveCount(0);

  // The id row's Open shows the note this one may be a copy of
  await block('other').locator('button.ir-damaged-note-open').click();
  await expect
    .poll(() =>
      window.evaluate(
        () =>
          (
            window as unknown as {
              app: { workspace: { getActiveFile(): { path: string } | null } };
            }
          ).app.workspace.getActiveFile()?.path ?? null
      )
    )
    .toBe(other);

  await block('art').locator('button.mod-cta').click();
  await expect(noticeRow()).toHaveCount(0);
  await expect.poll(() => cachedIrId(NOTE)).toBe('art');
});
