import test, {
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { executeCommandById, reviewTitle, setNativeMenus } from './helpers';
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
  vaultPath = await createVaultCopy('delete-missing');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
  if (shouldCleanup) {
    await fs.rm(vaultPath, { recursive: true, force: true });
  }
});

// #region HELPERS

/**
 * What the page-side calls below reach on Obsidian and the plugin.
 * `window.app` and `app.plugins` are unofficial Obsidian API: stable in
 * practice, but undocumented.
 */
type PageApp = {
  vault: { getFileByPath(path: string): unknown };
  plugins: {
    plugins: Record<
      string,
      {
        reviewManager: {
          repo: {
            mutate(sql: string, params?: unknown[]): Promise<unknown>;
          };
        };
      }
    >;
  };
};

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

/** Write a note into the vault and wait for Obsidian to index it. */
async function writeVaultFile(at: string, content: string) {
  await fs.mkdir(path.dirname(path.join(vaultPath, at)), { recursive: true });
  await fs.writeFile(path.join(vaultPath, at), content);
  await expect
    .poll(() =>
      window.evaluate(
        (p) =>
          (window as unknown as { app: PageApp }).app.vault.getFileByPath(p) !==
          null,
        at
      )
    )
    .toBe(true);
}

/** The queue rows flagged as missing their file. */
const missingRows = () =>
  window
    .locator('.ir-queue-row')
    .filter({ has: window.getByText('Missing', { exact: true }) });

const menu = () => window.locator('.menu');

const menuItem = (title: string) => menu().getByText(title, { exact: true });

/**
 * Open the menu of the queue row `row` and wait for it to show `title`.
 * Obsidian's menus animate in, and on a loaded runner the first right click
 * can land before the row takes it, so it is repeated.
 */
async function openRowMenu(row: Locator, title: string) {
  await expect(async () => {
    if ((await menu().count()) === 0) {
      await row.locator('.ir-queue-cell').first().click({ button: 'right' });
    }
    await expect(menuItem(title)).toBeVisible({ timeout: 2_000 });
  }).toPass();
}

/** Choose `title` from the open menu, and wait for the menu to go. */
async function chooseMenuItem(title: string) {
  await menuItem(title).click();
  await expect(menu()).toHaveCount(0);
}

/**
 * Close the open menu with Escape, and wait for it to go. Repeated while it
 * stays: a key pressed as the menu opens can reach the page instead.
 */
async function closeMenu() {
  await expect(async () => {
    if ((await menu().count()) > 0) await window.keyboard.press('Escape');
    await expect(menu()).toHaveCount(0, { timeout: 2_000 });
  }).toPass();
}

/** The confirmation, once open. */
const confirmation = () => window.locator('.modal-container.mod-confirmation');

// #endregion

test('permanently deletes a missing item from its queue row, keeping what was taken from it', async () => {
  // An article due now, with a review behind it, whose note is gone: its row
  // names a path where nothing is
  await mutate(
    `INSERT INTO article (id, reference, due, interval, priority)
     VALUES ('lost', 'gone/Lost.md', $1, 86400000, 25)`,
    [Date.now() - 60_000]
  );
  await mutate(
    `INSERT INTO article_review (id, article_id, review_time)
     VALUES ('lost-review', 'lost', $1)`,
    [Date.now() - 86_400_000]
  );
  // A snippet taken from it, with its note, due well after
  await writeVaultFile('snippets/Kept child.md', 'A snippet\n');
  await mutate(
    `INSERT INTO snippet (id, reference, parent, due, interval, priority)
     VALUES ('child', 'snippets/Kept child.md', 'lost', $1, 86400000, 30)`,
    [Date.now() + 1e9]
  );

  await executeCommandById(window, 'incremental-reading:learn');
  await setNativeMenus(window, false);
  const missing = missingRows();
  const child = window
    .locator('.ir-queue-row')
    .filter({ hasText: 'Kept child' });
  await expect(missing).toHaveCount(1);
  await expect(missing).toContainText('Lost.md');
  await expect(child).toHaveCount(1);
  // Its parent column names the missing item
  await expect(child).toContainText('gone/Lost.md');

  // A row with its note offers no permanent delete
  await openRowMenu(child, 'Relink file…');
  await expect(menuItem('Permanently delete')).toHaveCount(0);
  await closeMenu();

  // Cancel does nothing
  await openRowMenu(missing, 'Permanently delete');
  await chooseMenuItem('Permanently delete');
  await expect(confirmation()).toBeVisible();
  await expect(confirmation().locator('.modal-title')).toHaveText(
    'Permanently delete item'
  );
  await expect(confirmation()).toContainText('gone/Lost.md');
  const buttons = confirmation().locator('.modal-button-container > button');
  await expect(buttons).toHaveText(['Cancel', 'Delete']);
  await expect(buttons.nth(1)).toHaveClass(/mod-destructive/);
  await buttons.nth(0).click();
  await expect(confirmation()).toBeHidden();
  await expect(missing).toHaveCount(1);

  // Delete removes the row; the snippet stays, parentless
  await openRowMenu(missing, 'Permanently delete');
  await chooseMenuItem('Permanently delete');
  await confirmation().getByRole('button', { name: 'Delete' }).click();
  await expect(confirmation()).toBeHidden();

  await expect(missing).toHaveCount(0);
  await expect(child).toHaveCount(1);
  await expect(child).not.toContainText('gone/Lost.md');
  await expect(child).toContainText('Parent —');
  // Nothing was trashed: the snippet keeps its own note
  await expect(child.getByText('Missing', { exact: true })).toHaveCount(0);
});

test('moves review on to the next item due when the item it was on is deleted', async () => {
  await mutate(
    `INSERT INTO article (id, reference, due, interval, priority)
     VALUES ('lost', 'gone/Lost.md', $1, 86400000, 25)`,
    [Date.now() - 60_000]
  );
  await writeVaultFile(
    'articles/Next up.md',
    '---\nir-id: next\ntags: ir-article\n---\nThe next article\n'
  );
  await mutate(
    `INSERT INTO article (id, reference, due, interval, priority)
     VALUES ('next', 'articles/Next up.md', $1, 86400000, 25)`,
    [Date.now() - 30_000]
  );

  await executeCommandById(window, 'incremental-reading:learn');
  await window.locator('css=#begin-review-button').click();
  await expect(window.locator('.ir-missing-item')).toContainText(
    'gone/Lost.md'
  );
  // Home keeps review's place on the item
  await window.getByRole('button', { name: 'Go to home screen' }).click();

  await setNativeMenus(window, false);
  await openRowMenu(missingRows(), 'Permanently delete');
  await chooseMenuItem('Permanently delete');
  // Enter confirms, as in Obsidian's own confirmations
  await expect(
    confirmation().getByRole('button', { name: 'Delete' })
  ).toBeFocused();
  await window.keyboard.press('Enter');
  await expect(missingRows()).toHaveCount(0);
  await window.locator('css=#begin-review-button').click();

  // Bounded well inside `CURRENT_ITEM_REFETCH_TIME`, whose poll would get
  // review off a deleted item eventually whatever the delete did
  await expect(reviewTitle(window, 'Next up')).toBeVisible({ timeout: 2_000 });
  await expect(window.locator('.ir-missing-item')).toHaveCount(0);
});
