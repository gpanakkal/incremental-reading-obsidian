import {
  ARTICLE_TAG,
  BACKUP_DIRECTORY,
  DATABASE_FILE_PATH,
} from '#/lib/constants';
import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import initSqlJs from 'sql.js';
import { executeCommandById } from './helpers';
import {
  closeElectron,
  createVaultCopy,
  launchElectron,
  openVault,
  projectRoot,
  shouldCleanup,
} from './setup/helpers';

let app: ElectronApplication;
let window: Page;
let vaultPath: string;

const ARTICLE = {
  id: '00000000-0000-4000-8000-000000000001',
  reference: 'upgrade/Article.md',
};

/** A file where the backup folder goes, so every backup write fails. */
const blockerPath = () => path.join(vaultPath, BACKUP_DIRECTORY);

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('upgrade');
  await writeVersion9Vault();
  await fs.writeFile(blockerPath(), 'not a folder');
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

/**
 * A schema version 9 database (before the `rebind` table) holding
 * {@link ARTICLE}, and its note, written before Obsidian starts so startup
 * has it to migrate.
 */
async function writeVersion9Vault() {
  const notePath = path.join(vaultPath, ARTICLE.reference);
  await fs.mkdir(path.dirname(notePath), { recursive: true });
  await fs.writeFile(
    notePath,
    `---\ntags:\n  - ${ARTICLE_TAG}\nir-id: ${ARTICLE.id}\n---\nText\n`
  );
  const SQL = await initSqlJs({
    wasmBinary: (await fs.readFile(
      path.join(projectRoot, 'node_modules/sql.js/dist/sql-wasm.wasm')
    )) as unknown as ArrayBuffer,
  });
  const db = new SQL.Database();
  db.exec(
    await fs.readFile(path.join(projectRoot, 'src/db/schema.sql'), 'utf8')
  );
  db.exec('DROP TABLE rebind; PRAGMA user_version = 9');
  db.run(
    `INSERT INTO article (id, reference, due, interval, priority)
     VALUES (?, ?, ?, ?, ?)`,
    [ARTICLE.id, ARTICLE.reference, Date.now() - 86_400_000, 86_400_000, 20]
  );
  const dbPath = path.join(vaultPath, DATABASE_FILE_PATH);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.writeFile(dbPath, db.export());
  db.close();
}

const notice = () => window.locator('.ir-backup-failure-notice');

/** Review's home screen lists the migrated article: the plugin started. */
async function expectStarted() {
  await executeCommandById(window, 'incremental-reading:learn');
  await expect(
    window.locator('.ir-queue-row').filter({ hasText: ARTICLE.reference })
  ).toHaveCount(1);
}

// #endregion

test('retrying a failed backup before migrating starts the plugin once the backup can be written', async () => {
  await expect(notice()).toBeVisible();
  const retry = notice().locator('button').first();

  // Still failing: the notice stays, ready to retry again
  await retry.click();
  await expect(retry).toBeEnabled();
  await expect(notice()).toBeVisible();

  await fs.rm(blockerPath());
  await retry.click();

  await expect(notice()).toHaveCount(0);
  await expectStarted();
});

test('going ahead without the backup migrates once confirmed, and Cancel keeps waiting', async () => {
  const proceed = notice().locator('button.mod-warning');
  const confirmation = window.locator('.modal-container.mod-confirmation');

  await proceed.click();
  await confirmation.locator('button.mod-cancel').click();
  await expect(confirmation).toHaveCount(0);
  await expect(notice()).toBeVisible();

  await proceed.click();
  await confirmation.locator('button.mod-destructive').click();

  await expect(notice()).toHaveCount(0);
  await expectStarted();
});
