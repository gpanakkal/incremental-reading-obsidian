import { pluginVersionsOfSchema } from '#/db/migrations';
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
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { executeCommandById, pendingSaves } from './helpers';
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
 * `priorities` gives it, at the schema version `schema.sql` sets.
 */
async function databaseWith(
  priorities: readonly number[]
): Promise<Uint8Array> {
  const db = new SQL.Database();
  db.exec(
    await fs.readFile(path.join(projectRoot, 'src/db/schema.sql'), 'utf8')
  );
  ARTICLES.forEach(({ id, reference }, i) => {
    db.run(
      `INSERT INTO article (id, reference, due, interval, priority)
       VALUES (?, ?, ?, ?, ?)`,
      [id, reference, Date.now() - DAY_MS, DAY_MS, priorities[i]]
    );
  });
  const bytes = db.export();
  db.close();
  return bytes;
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
