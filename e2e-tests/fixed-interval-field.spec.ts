import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  chooseFromMenu,
  executeCommandById,
  REVIEW_VIEW_TYPE,
  setNativeMenus,
  waitForReviewItem,
  type RepoWindow,
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

test.beforeEach(async () => {
  // Kept short: from a deep worktree on Windows, a longer prefix pushes the
  // vault's `.user-data/IndexedDB/*.leveldb` folder past the 248-character
  // directory limit, so Chromium can't create it and the trust dialog never
  // goes away
  vaultPath = await createVaultCopy('interval-field');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
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

const REVIEW_BAR = `.workspace-leaf.mod-active [data-type="${REVIEW_VIEW_TYPE}"] .ir-review-interface > .ir-action-bar`;

/** Digits with a letter, a sign, a point, an exponent and a comma among them. */
const TYPED = '1a-.e,2';

/** Run `sql` against the running plugin's database. */
const mutate = (sql: string, params: unknown[] = []) =>
  window.evaluate(
    async ([sql, params]) => {
      const { app } = window as unknown as RepoWindow;
      const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
      await repo.mutate(sql, params);
    },
    [sql, params] as const
  );

/**
 * Write an article's note and wait for Obsidian to index it.
 * `app.vault` is unofficial Obsidian API on `window`: stable, but undocumented.
 */
async function writeNote(at: string, content: string) {
  await fs.mkdir(path.dirname(path.join(vaultPath, at)), { recursive: true });
  await fs.writeFile(path.join(vaultPath, at), content);
  await expect
    .poll(() =>
      window.evaluate(
        (p) =>
          (
            window as unknown as {
              app: { vault: { getFileByPath(path: string): unknown } };
            }
          ).app.vault.getFileByPath(p) !== null,
        at
      )
    )
    .toBe(true);
}

/** An article due a minute ago, reviewed every 7 days. */
async function addFixedIntervalArticle(name: string) {
  const reference = `articles/${name}.md`;
  await writeNote(
    reference,
    `---\nir-id: fixed\ntags: ir-article\n---\nText of ${name}\n`
  );
  await mutate(
    `INSERT INTO article (id, reference, due, interval, priority, fixed_interval_days)
     VALUES ('fixed', $1, $2, 604800000, 25, 7)`,
    [reference, Date.now() - 60_000]
  );
}

// #endregion

test('the action bar’s fixed-interval field shows only the digits typed into it, and keeps them', async () => {
  await addFixedIntervalArticle('Fixed article');
  await executeCommandById(window, 'incremental-reading:learn');
  await window.locator('css=#begin-review-button').click();
  await waitForReviewItem(window);
  const field = window.locator(`${REVIEW_BAR} .ir-fixed-interval-input`);
  await expect(field).toHaveValue('7');

  await field.selectText();
  await field.pressSequentially(TYPED);

  await expect(field).toHaveValue('12');
  await field.press('Tab');
  await expect(field).toHaveValue('12');
});

test('the scheduling dialog’s fixed-interval field shows only the digits typed into it, and keeps them', async () => {
  await addFixedIntervalArticle('Fixed article');
  await executeCommandById(window, 'incremental-reading:learn');
  await setNativeMenus(window, false);
  const row = window
    .locator('.ir-queue-row')
    .filter({ hasText: 'Fixed article' });
  await chooseFromMenu(window, row.locator('.ir-queue-cell').first(), [
    'Change scheduling…',
  ]);
  const field = window
    .locator('.modal-container .ir-scheduling-modal')
    .locator('.ir-fixed-interval-input');
  await expect(field).toHaveValue('7');

  await field.selectText();
  await field.pressSequentially(TYPED);

  await expect(field).toHaveValue('12');
  // Tab, not Enter: Enter confirms the dialog from the field itself
  await field.press('Tab');
  await expect(field).toHaveValue('12');
});
