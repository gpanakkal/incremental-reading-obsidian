import { ARTICLE_TAG } from '#/lib/constants';
import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { executeCommandById } from './helpers';
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
  vaultPath = await createVaultCopy('leftover-modal');
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
  metadataCache: {
    getFileCache(file: unknown): { frontmatter?: unknown } | null;
  };
  plugins: {
    plugins: Record<
      string,
      {
        reviewManager: {
          repo: {
            mutate(sql: string, params?: unknown[]): Promise<unknown>;
          };
        };
        leftovers?: { manage(): Promise<void> };
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

/**
 * Write a note into the vault and wait for Obsidian to index it, frontmatter
 * included: the leftover scan reads tags and ids off the metadata cache, which
 * parses a note some time after the vault first lists it.
 */
async function writeVaultFile(at: string, content: string) {
  await fs.mkdir(path.dirname(path.join(vaultPath, at)), { recursive: true });
  await fs.writeFile(path.join(vaultPath, at), content);
  await expect
    .poll(() =>
      window.evaluate((p) => {
        const { app } = window as unknown as { app: PageApp };
        const file = app.vault.getFileByPath(p);
        return (
          file !== null &&
          app.metadataCache.getFileCache(file)?.frontmatter !== undefined
        );
      }, at)
    )
    .toBe(true);
}

/** A note tagged as an article, holding `id`, which no row may hold. */
const articleNote = (id: string, body: string) =>
  `---\nir-id: ${id}\ntags: ${ARTICLE_TAG}\n---\n${body}\n`;

/** The leftover modal's line for the note named `name`. */
const lineOf = (name: string) =>
  window.locator('.ir-leftover-modal .setting-item').filter({ hasText: name });

// #endregion

test('saves only the leftover notes left checked on Confirm', async () => {
  // Leftovers are asked about only while the database holds an item
  await writeVaultFile('articles/Held.md', articleNote('held', 'Held'));
  await mutate(
    `INSERT INTO article (id, reference, due, interval, priority)
     VALUES ('held', 'articles/Held.md', $1, 86400000, 25)`,
    [Date.now() + 1e9]
  );
  await writeVaultFile('notes/Keep me.md', articleNote('keep', 'Keep me'));
  await writeVaultFile('notes/Leave me.md', articleNote('leave', 'Leave me'));
  // What the review home screen's Manage button does; the startup scan ran
  // before these notes were written, so the button isn't there yet
  await window.evaluate(() => {
    const { app } = window as unknown as { app: PageApp };
    void app.plugins.plugins['incremental-reading'].leftovers?.manage();
  });

  // Obsidian's slider toggles, on while `is-enabled`
  const keep = lineOf('Keep me').locator('.checkbox-container');
  const leave = lineOf('Leave me').locator('.checkbox-container');
  // Both recognized by their tag, so both start on
  await expect(keep).toHaveClass(/\bis-enabled\b/);
  await expect(leave).toHaveClass(/\bis-enabled\b/);
  // Its label's text flips it too
  await lineOf('Leave me').locator('.ir-leftover-keep-text').click();
  await expect(leave).not.toHaveClass(/\bis-enabled\b/);
  await window
    .locator('.ir-leftover-modal .modal-button-container .mod-cta')
    .click();

  // The note saved leaves the list; the one turned off stays, as it was
  await expect(lineOf('Keep me')).toHaveCount(0);
  await expect(lineOf('Leave me')).toHaveCount(1);
  await expect(leave).not.toHaveClass(/\bis-enabled\b/);
  await window
    .locator('.ir-leftover-modal .modal-button-container .mod-cancel')
    .click();
  await expect(window.locator('.ir-leftover-modal')).toHaveCount(0);

  await executeCommandById(window, 'incremental-reading:learn');
  const rows = window.locator('.ir-queue-row');
  await expect(rows.filter({ hasText: 'Keep me' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Leave me' })).toHaveCount(0);
  // Still a leftover, to be asked about again
  await expect(
    window.locator('#manage-leftovers-button .ir-leftover-count')
  ).toHaveText('1');
});
