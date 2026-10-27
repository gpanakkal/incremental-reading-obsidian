import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { chooseFromMenu, executeCommandById, setNativeMenus } from './helpers';
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
  vaultPath = await createVaultCopy('queue-row-menu');
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

/** An article due a minute ago, with its note, at priority `priority`. */
async function addDueArticle(id: string, name: string, priority = 25) {
  const reference = `articles/${name}.md`;
  await writeVaultFile(
    reference,
    `---\nir-id: ${id}\ntags: ir-article\n---\nText of ${name}\n`
  );
  await mutate(
    `INSERT INTO article (id, reference, due, interval, priority)
     VALUES ($1, $2, $3, 86400000, $4)`,
    [id, reference, Date.now() - 60_000, priority]
  );
}

/** The queue row naming `name`. */
const queueRow = (name: string) =>
  window.locator('.ir-queue-row').filter({ hasText: name });

// #endregion

test('dismisses an item from its queue row, and undo puts the row back', async () => {
  await addDueArticle('one', 'Row one');
  await addDueArticle('two', 'Row two');

  await executeCommandById(window, 'incremental-reading:learn');
  await setNativeMenus(window, false);
  const row = queueRow('Row one');
  await expect(row).toHaveCount(1);

  await chooseFromMenu(window, row.locator('.ir-queue-cell').first(), [
    'Dismiss',
  ]);

  await expect(row).toHaveCount(0);
  await expect(queueRow('Row two')).toHaveCount(1);

  // The same undo as the action bar's dismiss; home has no undo button
  await executeCommandById(window, 'incremental-reading:undo');
  await expect(row).toHaveCount(1);
});

test('opens the scheduling dialog for a queue row’s item, and its change shows in the row', async () => {
  await addDueArticle('one', 'Row one', 25);
  await addDueArticle('two', 'Row two', 30);

  await executeCommandById(window, 'incremental-reading:learn');
  await setNativeMenus(window, false);
  const row = queueRow('Row one');
  await expect(row).toContainText('2.5');

  await chooseFromMenu(window, row.locator('.ir-queue-cell').first(), [
    'Change scheduling…',
  ]);

  // It is that item's dialog: titled with its note, holding its priority
  const modal = window.locator('.modal-container').filter({
    has: window.locator('.ir-scheduling-modal'),
  });
  await expect(modal.locator('.modal-title')).toHaveText('Row one');
  const priority = modal.locator('.ir-priority-input');
  await expect(priority).toHaveValue('2.5');

  await priority.fill('4');
  // Tab, not Enter: Enter confirms the dialog from the field itself
  await priority.press('Tab');
  await modal.locator('button.mod-cta').click();
  await expect(modal).toHaveCount(0);

  await expect(row).toContainText('4.0');
  await expect(queueRow('Row two')).toContainText('3.0');
});

test('reveals a queue row’s note in the file explorer', async () => {
  await addDueArticle('one', 'Row one');
  await addDueArticle('two', 'Row two');

  await executeCommandById(window, 'incremental-reading:learn');
  await setNativeMenus(window, false);
  const row = queueRow('Row one');
  await expect(row).toHaveCount(1);
  const explorerRow = window.locator(
    '.nav-file-title[data-path="articles/Row one.md"]'
  );
  // Its folder starts collapsed, so the explorer has no row for it yet
  await expect(explorerRow).toBeHidden();

  await chooseFromMenu(window, row.locator('.ir-queue-cell').first(), [
    'Reveal file in navigation',
  ]);

  // Its folder opens, and the explorer focuses the note's row
  await expect(explorerRow).toBeVisible();
  await expect(explorerRow).toHaveClass(/\bhas-focus\b/);
  await expect(
    window.locator('.nav-file-title[data-path="articles/Row two.md"]')
  ).not.toHaveClass(/\bhas-focus\b/);
});
