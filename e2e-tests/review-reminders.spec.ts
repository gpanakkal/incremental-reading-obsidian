import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import { expectReviewHome, importArticle, openPluginSettings } from './helpers';
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
  vaultPath = await createVaultCopy('core');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
  if (shouldCleanup) {
    // Best-effort, as in core.spec.ts: a surviving Electron child on Windows
    // can still hold a handle inside the disposable vault.
    await fs
      .rm(vaultPath, { recursive: true, force: true, maxRetries: 3 })
      .catch(() => {});
  }
});

const ARTICLE = 'sources/Security Principles';

/** The status bar's reminder that items are due. */
const reminder = (page: Page) =>
  page.locator('.status-bar .status-bar-item', { hasText: 'Ready for review' });

/**
 * What the page-side call below reaches. `window.app` and `app.plugins` are
 * unofficial: stable in practice, but undocumented.
 */
type PageWindow = {
  app: {
    plugins: {
      plugins: Record<string, { saveSettings(): Promise<void> }>;
    };
  };
};

/**
 * Wait for the reminder to show or hide after a change to what is due.
 *
 * A data change reaches it a minute after its last check at the latest, too
 * long to wait out here, but a settings save makes it check at once. So each
 * try saves the settings unchanged, then looks: the review or import that
 * changed what is due may still be landing on the first try.
 */
async function expectReminder(page: Page, shown: boolean) {
  await expect(async () => {
    await page.evaluate(() =>
      (window as unknown as PageWindow).app.plugins.plugins[
        'incremental-reading'
      ].saveSettings()
    );
    if (shown) await expect(reminder(page)).toBeVisible({ timeout: 1_000 });
    else await expect(reminder(page)).toBeHidden({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

test('the status bar says items are ready for review until the last is reviewed, and opens review when clicked', async () => {
  // A fresh vault has nothing due
  await expect(window.locator('.workspace')).toBeVisible();
  await expect(reminder(window)).toBeHidden();

  await importArticle(window, ARTICLE);
  await expectReminder(window, true);
  // Never a count
  await expect(reminder(window)).not.toHaveText(/\d/);

  await reminder(window).click();
  await expectReviewHome(window);
  await window.locator('css=#begin-review-button').click();
  await window.getByRole('button', { name: 'Mark reviewed' }).click();

  await expectReminder(window, false);
});

test('reminder settings hide it for due articles, and lock the type toggles while reminders are off', async () => {
  await importArticle(window, ARTICLE);
  await expectReminder(window, true);

  const settings = await openPluginSettings(app, window);
  const row = (name: string) =>
    settings.locator('.vertical-tab-content .setting-item').filter({
      has: settings
        .locator('.setting-item-name')
        .getByText(name, { exact: true }),
    });
  const toggle = (name: string) => row(name).locator('.checkbox-container');
  const reminders = toggle('Show review reminders in status bar');
  const articles = toggle('Remind for due articles');
  const snippets = toggle('Remind for due snippets');
  for (const each of [reminders, articles, snippets]) {
    await expect(each).toHaveClass(/\bis-enabled\b/);
  }

  // Only an article is due, so the reminder goes with it
  await articles.click();
  await expect(articles).not.toHaveClass(/\bis-enabled\b/);
  await expect(reminder(window)).toBeHidden();
  await articles.click();
  await expect(reminder(window)).toBeVisible();

  await reminders.click();
  await expect(reminder(window)).toBeHidden();
  for (const name of ['Remind for due articles', 'Remind for due snippets']) {
    await expect(row(name)).toHaveClass(/\bis-disabled\b/);
  }
  // A locked toggle ignores clicks
  await snippets.click({ force: true });
  await expect(snippets).toHaveClass(/\bis-enabled\b/);

  await reminders.click();
  await expect(row('Remind for due snippets')).not.toHaveClass(
    /\bis-disabled\b/
  );
  await expect(reminder(window)).toBeVisible();
});
