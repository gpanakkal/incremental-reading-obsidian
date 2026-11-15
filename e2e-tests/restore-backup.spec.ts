import { migrations, pluginVersionsOfSchema } from '#/db/migrations';
import {
  ARTICLE_TAG,
  BACKUP_DIRECTORY,
  CURRENT_ITEM_REFETCH_TIME,
  DATABASE_FILE_PATH,
} from '#/lib/constants';
import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import {
  emulateMobile,
  executeCommandById,
  expectReviewOn,
  pendingSaves,
  setNativeMenus,
  waitForReviewItem,
  watchNotices,
} from './helpers';
import {
  closeElectron,
  createVaultCopy,
  launchElectron,
  openVault,
  projectRoot,
  shouldCleanup,
} from './setup/helpers';
import { query } from './setup/item-steps';

let app: ElectronApplication;
let window: Page;
let vaultPath: string;
let SQL: SqlJsStatic;

const DAY_MS = 86_400_000;

/** The articles in the vault, each with a note of its own. */
const ARTICLES = [
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000012',
].map((id, i) => ({
  id,
  name: `Restored article ${i + 1}`,
  reference: `restore-backup/Restored article ${i + 1}.md`,
}));

test.beforeAll(async () => {
  SQL = await initSqlJs({
    wasmBinary: (await fs.readFile(
      path.join(projectRoot, 'node_modules/sql.js/dist/sql-wasm.wasm')
    )) as unknown as ArrayBuffer,
  });
});

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('restore-backup');
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
 * A database holding {@link ARTICLES}, each due a day ago, at the priority
 * `priorities` gives it, dismissed where `dismissed` says so, at the schema
 * version `schema.sql` sets.
 */
async function databaseWith(
  priorities: readonly number[],
  dismissed: readonly boolean[] = []
): Promise<Uint8Array> {
  const db = new SQL.Database();
  db.exec(
    await fs.readFile(path.join(projectRoot, 'src/db/schema.sql'), 'utf8')
  );
  ARTICLES.forEach(({ id, reference }, i) => {
    db.run(
      `INSERT INTO article (id, reference, due, interval, priority, dismissed)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        reference,
        Date.now() - DAY_MS,
        DAY_MS,
        priorities[i],
        dismissed[i] ? 1 : 0,
      ]
    );
  });
  const bytes = db.export();
  db.close();
  return bytes;
}

/** The schema version `schema.sql` sets. */
async function schemaVersion() {
  return Number(
    /PRAGMA user_version = (\d+)/.exec(
      await fs.readFile(path.join(projectRoot, 'src/db/schema.sql'), 'utf8')
    )![1]
  );
}

async function writeVaultFile(at: string, content: string | Uint8Array) {
  const full = path.join(vaultPath, at);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

/**
 * The name the plugin gives a backup taken before a merge (`backupFileName`
 * in `retention.ts`, which imports `obsidian` and so can't load here).
 */
const mergeBackupName = (version: number, date: Date) =>
  `ir-user-data_v${version}_merge_${date.toISOString().replace(/[:.]/g, '-')}.sqlite`;

const queueRow = (name: string) =>
  window.locator('.ir-queue-row', { hasText: name });

const backupRows = () => window.locator('.ir-backup-modal .ir-backup-row');

/** Write a note for each of {@link ARTICLES}. */
async function writeArticleNotes() {
  for (const { id, reference } of ARTICLES) {
    await writeVaultFile(
      reference,
      `---\ntags:\n  - ${ARTICLE_TAG}\nir-id: ${id}\n---\nText of ${reference}\n`
    );
  }
}

/**
 * The page as the undo checks below reach it: the plugin's undo stack, and a
 * count of runs of one entry's undo. `window.app` and `app.plugins` are
 * unofficial Obsidian API: stable in practice, but undocumented.
 */
type UndoWindow = {
  __undoRuns?: number;
  app: {
    plugins: {
      plugins: Record<
        string,
        { actions: { undoStack: { undo: () => unknown }[] } }
      >;
    };
  };
};

// #endregion

test('restores a backup from the picker, and the review home shows what it holds', async () => {
  for (const { id, reference } of ARTICLES) {
    await writeVaultFile(
      reference,
      `---\ntags:\n  - ${ARTICLE_TAG}\nir-id: ${id}\n---\nText of ${reference}\n`
    );
  }
  // The database as it went bad: the second article's priority changed
  await writeVaultFile(DATABASE_FILE_PATH, await databaseWith([30, 45]));
  // A backup from before
  const version = Number(
    /PRAGMA user_version = (\d+)/.exec(
      await fs.readFile(path.join(projectRoot, 'src/db/schema.sql'), 'utf8')
    )![1]
  );
  await writeVaultFile(
    `${BACKUP_DIRECTORY}/${mergeBackupName(version, new Date(Date.now() - DAY_MS))}`,
    await databaseWith([30, 30])
  );
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);

  await executeCommandById(window, 'incremental-reading:learn');
  await expect(queueRow(ARTICLES[0].name)).toContainText(/Priority\s*3\.0/);
  await expect(queueRow(ARTICLES[1].name)).toContainText(/Priority\s*4\.5/);

  await window.locator('#restore-backup-button').click();
  await expect(backupRows()).toHaveCount(1);
  // Its name has no plugin version: the release that brought its schema
  // version stands in
  await expect(backupRows().first()).toContainText(
    pluginVersionsOfSchema(version)!.first
  );
  await backupRows().first().locator('button').click();
  await window.locator('.modal-container.mod-confirmation .mod-cta').click();

  await expect(queueRow(ARTICLES[1].name)).toContainText(/Priority\s*3\.0/);
  await expect(queueRow(ARTICLES[0].name)).toContainText(/Priority\s*3\.0/);
  await expect(window.locator('.ir-backup-modal')).toHaveCount(0);

  // What it replaced was backed up, and is offered back, by the version of
  // the plugin that took it
  await window.locator('#restore-backup-button').click();
  await expect(backupRows()).toHaveCount(2);
  const manifest = JSON.parse(
    await fs.readFile(path.join(projectRoot, 'manifest.json'), 'utf8')
  ) as { version: string };
  await expect(backupRows().first()).toContainText(manifest.version);
  // And the picker names the version running
  await expect(
    window.locator('.ir-backup-modal .ir-backup-intro')
  ).toContainText(manifest.version);
  // Escape rather than the close button, whose class differs between
  // Obsidian versions (`modal-close-button`, `modal-header-button`)
  await window.keyboard.press('Escape');
  await expect(window.locator('.ir-backup-modal')).toHaveCount(0);

  // A dismissal made before a restore is no longer offered for undo after it
  await window.locator('#begin-review-button').click();
  await window
    .getByRole('button', { name: 'Stop scheduling this item for review' })
    .click();
  await expect(window.locator('#undo-button')).toBeEnabled();
  await window.getByRole('button', { name: 'Go to home screen' }).click();
  await window.locator('#restore-backup-button').click();
  await backupRows().first().locator('button').click();
  await window.locator('.modal-container.mod-confirmation .mod-cta').click();
  await expect(window.locator('.ir-backup-modal')).toHaveCount(0);
  await window.locator('#begin-review-button').click();
  await expect(window.locator('#undo-button')).toBeDisabled();
});

test('takes on whole a database another device restored when it arrives, backing up its own first', async () => {
  await writeArticleNotes();
  await writeVaultFile(DATABASE_FILE_PATH, await databaseWith([30, 30]));
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);

  await executeCommandById(window, 'incremental-reading:learn');
  await expect(queueRow(ARTICLES[1].name)).toContainText(/Priority\s*3\.0/);
  await expect.poll(() => pendingSaves(window)).toBe(0);

  // What a restore on another device sends: this very file, so stamped as
  // this device's own save, holding other data and a later restore epoch
  const db = new SQL.Database(
    await fs.readFile(path.join(vaultPath, DATABASE_FILE_PATH))
  );
  db.run('UPDATE article SET priority = 45 WHERE id = ?', [ARTICLES[1].id]);
  db.run(
    `INSERT OR REPLACE INTO restore_epoch (id, epoch, device, restored_at)
     VALUES (1, ?, 'another-device', ?)`,
    [Date.now(), Date.now()]
  );
  const restored = Array.from(db.export());
  db.close();
  // Through the vault adapter, as Sync writes it, so the vault reports it
  await window.evaluate(
    async ({ dbPath, bytes }) => {
      const { app } = window as unknown as {
        app: {
          vault: {
            adapter: {
              writeBinary(path: string, data: ArrayBuffer): Promise<void>;
            };
          };
        };
      };
      await app.vault.adapter.writeBinary(dbPath, new Uint8Array(bytes).buffer);
    },
    { dbPath: DATABASE_FILE_PATH, bytes: restored }
  );

  await expect(queueRow(ARTICLES[1].name)).toContainText(/Priority\s*4\.5/);
  await expect(queueRow(ARTICLES[0].name)).toContainText(/Priority\s*3\.0/);
  // What it replaced was backed up, and is offered in the picker
  await window.locator('#restore-backup-button').click();
  await expect(backupRows()).toHaveCount(1);
});

test('drops the undo history from before a restore from the picker, so an undo press leaves the restored data as it is', async () => {
  await writeArticleNotes();
  await writeVaultFile(DATABASE_FILE_PATH, await databaseWith([30, 30]));
  // A backup in which the first article is dismissed too, and the second
  // stands at another priority: undoing the dismissal against it would bring
  // the first back to the queue
  await writeVaultFile(
    `${BACKUP_DIRECTORY}/${mergeBackupName(await schemaVersion(), new Date(Date.now() - DAY_MS))}`,
    await databaseWith([30, 45], [true, false])
  );
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
  await setNativeMenus(window, false);

  // Before the restore: dismiss the first article from its queue row
  await executeCommandById(window, 'incremental-reading:learn');
  await expect(queueRow(ARTICLES[0].name)).toHaveCount(1);
  const dismiss = window.locator('.menu .menu-item:has(.lucide-ban)');
  await expect(async () => {
    if ((await dismiss.count()) === 0)
      await queueRow(ARTICLES[0].name).locator('.ir-queue-row-menu').click();
    await expect(dismiss).toBeVisible({ timeout: 2000 });
  }).toPass();
  await dismiss.click();
  await expect(queueRow(ARTICLES[0].name)).toHaveCount(0);
  await expect.poll(() => pendingSaves(window)).toBe(0);
  // Count runs of the dismissal's own undo: the restore drops the entry from
  // the stack, so nothing that comes after it may run it
  await window.evaluate(() => {
    const w = window as unknown as UndoWindow;
    const entry =
      w.app.plugins.plugins['incremental-reading'].actions.undoStack.at(-1)!;
    const undo = entry.undo;
    w.__undoRuns = 0;
    entry.undo = () => {
      w.__undoRuns = (w.__undoRuns ?? 0) + 1;
      return undo();
    };
  });

  await window.locator('#restore-backup-button').click();
  await expect(backupRows()).toHaveCount(1);
  await backupRows().first().locator('button').click();
  await window.locator('.modal-container.mod-confirmation .mod-cta').click();
  await expect(queueRow(ARTICLES[1].name)).toContainText(/Priority\s*4\.5/);
  await expect(window.locator('.ir-backup-modal')).toHaveCount(0);

  // The restore empties the undo history before anything presses undo
  await expect
    .poll(() =>
      window.evaluate(
        () =>
          (window as unknown as UndoWindow).app.plugins.plugins[
            'incremental-reading'
          ].actions.undoStack.length
      )
    )
    .toBe(0);

  // So an undo press has nothing to run, and leaves the restored rows be. The
  // press answers with a notice, so its arrival marks the press as handled
  const notices = await watchNotices(window);
  await executeCommandById(window, 'incremental-reading:undo');
  await expect.poll(async () => (await notices()).length).toBeGreaterThan(0);
  expect(
    await window.evaluate(() => {
      const w = window as unknown as UndoWindow;
      return {
        left: w.app.plugins.plugins['incremental-reading'].actions.undoStack
          .length,
        runs: w.__undoRuns,
      };
    })
  ).toEqual({ left: 0, runs: 0 });
  expect(
    await query(
      window,
      'SELECT id, dismissed, priority FROM article ORDER BY id'
    )
  ).toEqual([
    { id: ARTICLES[0].id, dismissed: 1, priority: 30 },
    { id: ARTICLES[1].id, dismissed: 0, priority: 45 },
  ]);
  await expect(queueRow(ARTICLES[0].name)).toHaveCount(0);
  await expect(queueRow(ARTICLES[1].name)).toContainText(/Priority\s*4\.5/);
});

test('clears the undo history from before a restore from the picker with one notice, and keeps a skip made before it undoable', async () => {
  await writeArticleNotes();
  await writeVaultFile(DATABASE_FILE_PATH, await databaseWith([30, 30]));
  await writeVaultFile(
    `${BACKUP_DIRECTORY}/${mergeBackupName(await schemaVersion(), new Date(Date.now() - DAY_MS))}`,
    await databaseWith([30, 30])
  );
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
  await executeCommandById(window, 'incremental-reading:learn');
  await expect(queueRow(ARTICLES[0].name)).toHaveCount(1);
  await expect.poll(() => pendingSaves(window)).toBe(0);
  const notices = await watchNotices(window);
  const noticeCount = async () => (await notices()).length;
  const restoreFirstBackup = async () => {
    await window.locator('#restore-backup-button').click();
    await expect(backupRows().first()).toBeVisible();
    await backupRows().first().locator('button').click();
    await window.locator('.modal-container.mod-confirmation .mod-cta').click();
    await expect(window.locator('.ir-backup-modal')).toHaveCount(0);
  };

  // What a restore raises on its own, with no undo history to clear
  await restoreFirstBackup();
  await expect.poll(noticeCount).toBeGreaterThan(0);
  await expect.poll(() => pendingSaves(window)).toBe(0);
  const ownNotices = await noticeCount();

  // Skip one article, then dismiss the other
  await window.locator('#begin-review-button').click();
  const skipped = await waitForReviewItem(window);
  await window
    .getByRole('button', { name: 'Skip for current review session' })
    .click();
  const dismissed = await waitForReviewItem(window);
  expect(dismissed.id).not.toBe(skipped.id);
  await window
    .getByRole('button', { name: 'Stop scheduling this item for review' })
    .click();
  await expect
    .poll(() => window.locator('#undo-button').getAttribute('aria-label'))
    .toContain(dismissed.title);
  await expect.poll(() => pendingSaves(window)).toBe(0);
  await window.getByRole('button', { name: 'Go to home screen' }).click();
  const beforeRestore = await noticeCount();

  // The dismissal goes with one notice more than the restore raises alone
  await restoreFirstBackup();
  await expect.poll(noticeCount).toBe(beforeRestore + ownNotices + 1);
  await expect.poll(() => pendingSaves(window)).toBe(0);

  // And no read of the history after that tells of it again: the action bar
  // drawn again, the current item polled twice, the undo button's tooltip
  await window.locator('#begin-review-button').click();
  const undoButton = window.locator('#undo-button');
  await expect(undoButton).toBeEnabled();
  await window.getByRole('button', { name: 'Go to home screen' }).click();
  await window.locator('#begin-review-button').click();
  await undoButton.hover();
  await expect(window.locator('.tooltip')).toBeVisible();
  // One bounded wait past two polls of the current item, not a loop
  await window.waitForTimeout(2 * CURRENT_ITEM_REFETCH_TIME + 1000);
  await undoButton.hover();
  expect(await noticeCount()).toBe(beforeRestore + ownNotices + 1);

  // What the undo button offers is the skip, which still undoes; nothing is
  // left to undo after it, so the dismissal was never offered
  await expect
    .poll(() => undoButton.getAttribute('aria-label'))
    .toContain(skipped.title);
  await undoButton.click();
  await expectReviewOn(window, skipped);
  await expect(undoButton).toBeDisabled();
});

test('names each backup in the picker for the plugin versions that made it, keeps its schema version to the tooltip, and offers the backups folder on desktop alone', async () => {
  await writeArticleNotes();
  await writeVaultFile(DATABASE_FILE_PATH, await databaseWith([30, 30]));
  const version = await schemaVersion();
  const manifest = JSON.parse(
    await fs.readFile(path.join(projectRoot, 'manifest.json'), 'utf8')
  ) as { version: string };
  // An older schema version, one several releases shared, so the row of a
  // backup at it shows a range with two ends whatever this build's version is
  const older = [...migrations]
    .reverse()
    .map(({ version }) => ({ version, span: pluginVersionsOfSchema(version) }))
    .find(({ span }) => span !== null && span.first !== span.last)!;
  // One named as backups were before their names carried the plugin version,
  // and one named as this build names them
  await writeVaultFile(
    `${BACKUP_DIRECTORY}/${mergeBackupName(older.version, new Date(Date.now() - 2 * DAY_MS))}`,
    await databaseWith([30, 30])
  );
  const stamp = new Date(Date.now() - DAY_MS)
    .toISOString()
    .replace(/[:.]/g, '-');
  await writeVaultFile(
    `${BACKUP_DIRECTORY}/ir-user-data_v${version}_p${manifest.version}_merge_${stamp}.sqlite`,
    await databaseWith([30, 30])
  );
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
  await executeCommandById(window, 'incremental-reading:learn');

  await window.locator('#restore-backup-button').click();

  // Newest first
  await expect(backupRows()).toHaveCount(2);
  const [named, unnamed] = [backupRows().first(), backupRows().last()];
  await expect(named).toContainText(manifest.version);
  // The releases whose databases were at its schema version stand in
  await expect(unnamed).toContainText(older.span!.first);
  await expect(unnamed).toContainText(older.span!.last);
  // The schema version is the tooltip's alone: the one of a name without a
  // plugin version is all its tooltip holds, and the other's tooltip holds
  // the same for its own schema version
  const schemaLabel = await unnamed.getAttribute('aria-label');
  expect(schemaLabel).toContain(String(older.version));
  const namedSchemaLabel = schemaLabel!.replace(
    String(older.version),
    String(version)
  );
  expect(await named.getAttribute('aria-label')).toContain(namedSchemaLabel);

  for (const row of [named, unnamed]) {
    await expect(row).not.toContainText(schemaLabel!);
    await expect(row).not.toContainText(namedSchemaLabel);
  }
  await expect(
    window.locator('.ir-backup-modal .ir-backup-folder')
  ).toHaveCount(1);
  await window.keyboard.press('Escape');
  await expect(window.locator('.ir-backup-modal')).toHaveCount(0);

  // Mobile has no file manager to reveal the folder in
  await expect.poll(() => pendingSaves(window)).toBe(0);
  await emulateMobile(window, true);
  // The reload lays out the mobile workspace with no review tab. Learn is
  // refused until the database has started again, which `emulateMobile` does
  // not wait for: it returns once the plugin has its store, before that.
  // Unofficial: `window.app`, `app.plugins.plugins`.
  await window.waitForFunction(
    () =>
      !!(
        window as unknown as {
          app: {
            plugins: { plugins: Record<string, { reviewManager?: unknown }> };
          };
        }
      ).app.plugins.plugins['incremental-reading']?.reviewManager,
    undefined,
    { timeout: 15_000 }
  );
  await executeCommandById(window, 'incremental-reading:learn');
  const restoreButton = window.locator('#restore-backup-button');
  await restoreButton.click();
  await expect(backupRows()).toHaveCount(2);
  await expect(
    window.locator('.ir-backup-modal .ir-backup-folder')
  ).toHaveCount(0);
});
