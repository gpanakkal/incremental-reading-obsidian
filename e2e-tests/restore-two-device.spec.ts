import {
  ARTICLE_TAG,
  BACKUP_DIRECTORY,
  DATABASE_FILE_PATH,
} from '#/lib/constants';
import { expect, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import {
  executeCommandById,
  REVIEW_VIEW_TYPE,
  waitForReviewItem,
} from './helpers';
import { test } from './setup/fixtures';
import { createVaultCopy, projectRoot } from './setup/helpers';
import {
  closeDevices,
  launchDevice,
  launchSecondDevice,
  waitForTakenOn,
  type Device,
} from './setup/two-device';

// A restore from the picker on one device, while another device shares the
// vault: the other device takes the restored database on whole, backing its
// own up first, and its later saves build on the restore rather than undo it.

let deviceA: Device | undefined;
let deviceB: Device | undefined;
let vaultPath: string;
let SQL: SqlJsStatic;

const DAY_MS = 86_400_000;

// #region HELPERS

/** The articles in the vault, each with a note of its own. */
const ARTICLES = [
  '00000000-0000-4000-8000-000000000021',
  '00000000-0000-4000-8000-000000000022',
].map((id, i) => ({
  id,
  name: `Shared article ${i + 1}`,
  reference: `Shared article ${i + 1}.md`,
}));

/**
 * A database holding {@link ARTICLES}, each due a day ago, at the priority
 * `priorities` gives it, at the schema version `schema.sql` sets.
 */
async function databaseWith(priorities: readonly number[]) {
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

/** The priority of each of {@link ARTICLES} in the database file at `at`. */
async function prioritiesIn(at: string) {
  const db = new SQL.Database(await fs.readFile(at));
  try {
    return ARTICLES.map(({ id }) => {
      const [result] = db.exec('SELECT priority FROM article WHERE id = ?', [
        id,
      ]);
      return result ? Number(result.values[0][0]) : null;
    });
  } finally {
    db.close();
  }
}

/** The schema version `schema.sql` sets. */
async function schemaVersion() {
  return Number(
    /PRAGMA user_version = (\d+)/.exec(
      await fs.readFile(path.join(projectRoot, 'src/db/schema.sql'), 'utf8')
    )![1]
  );
}

/**
 * The name the plugin gives a backup taken before a merge (`backupFileName`
 * in `retention.ts`, which imports `obsidian` and so can't load here).
 */
const mergeBackupName = (version: number, date: Date) =>
  `ir-user-data_v${version}_merge_${date.toISOString().replace(/[:.]/g, '-')}.sqlite`;

/**
 * The backups taken before another copy replaced the database (`stale` in
 * the name `backupFileName` gives them), by absolute path.
 */
async function staleBackups() {
  const folder = path.join(vaultPath, BACKUP_DIRECTORY);
  const names = await fs.readdir(folder).catch(() => [] as string[]);
  return names
    .filter((name) => /_stale_.*\.sqlite$/.test(name))
    .map((name) => path.join(folder, name));
}

async function writeVaultFile(at: string, content: string | Uint8Array) {
  const full = path.join(vaultPath, at);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

/**
 * The page as {@link recordStaleBackups} reaches it. `window.app` is
 * unofficial Obsidian API; `vault.adapter.writeBinary` is the documented
 * method the repository writes its backups with.
 */
type BackupWindow = {
  __staleWrites?: string[];
  app: {
    vault: {
      adapter: {
        writeBinary(at: string, data: ArrayBuffer): Promise<void>;
      };
    };
  };
};

/**
 * From now on, note each `stale` backup the device on `page` writes itself,
 * by vault path: in a folder both devices share, the only way to tell whose
 * backup is whose.
 */
const recordStaleBackups = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as BackupWindow;
    const { adapter } = w.app.vault;
    const write = adapter.writeBinary.bind(
      adapter
    ) as typeof adapter.writeBinary;
    w.__staleWrites = [];
    adapter.writeBinary = (at, data) => {
      if (/_stale_/.test(at)) w.__staleWrites?.push(at);
      return write(at, data);
    };
  });

/** The `stale` backups the device on `page` wrote since it began recording. */
const staleBackupsWrittenBy = (page: Page) =>
  page.evaluate(() => (window as unknown as BackupWindow).__staleWrites ?? []);

const queueRow = (page: Page, name: string) =>
  page.locator('.ir-queue-row', { hasText: name });

/**
 * Show review's home on `page`, its queue drawn: Learn opens it in a new
 * review tab, and takes a focused review tab on an item back to it.
 */
async function reviewHome(page: Page) {
  const home = page.locator('css=#begin-review-button');
  if (!(await home.isVisible())) {
    await executeCommandById(page, 'incremental-reading:learn');
    await expect(home).toBeVisible();
  }
  await expect(page.locator('.ir-queue-row').first()).toBeVisible();
}

/**
 * On `page`, set the priority of the article named `name` from the review
 * pane, as a reader would while reviewing it: a save of that device's own.
 */
async function reprioritize(page: Page, name: string, priority: string) {
  await reviewHome(page);
  await queueRow(page, name).click();
  expect((await waitForReviewItem(page)).title).toBe(name);
  const field = page.locator(
    `.workspace-leaf.mod-active [data-type="${REVIEW_VIEW_TYPE}"] .ir-action-bar .ir-priority-input`
  );
  await field.fill(priority);
  await field.press('Enter');
  await expect(field).toHaveValue(`${Number(priority) / 10}`);
}

// #endregion

test.beforeAll(async () => {
  SQL = await initSqlJs({
    wasmBinary: (await fs.readFile(
      path.join(projectRoot, 'node_modules/sql.js/dist/sql-wasm.wasm')
    )) as unknown as ArrayBuffer,
  });
});

test.beforeEach(async () => {
  // One vault copy, two installs: a database saved on one reaches the other
  // through its own file watcher, as a Sync download does
  vaultPath = await createVaultCopy('two-restore');
  for (const { id, reference } of ARTICLES) {
    await writeVaultFile(
      reference,
      `---\ntags:\n  - ${ARTICLE_TAG}\nir-id: ${id}\n---\nText of ${reference}\n`
    );
  }
  await writeVaultFile(DATABASE_FILE_PATH, await databaseWith([30, 30]));
  // A backup from before either device changed anything
  await writeVaultFile(
    `${BACKUP_DIRECTORY}/${mergeBackupName(await schemaVersion(), new Date(Date.now() - DAY_MS))}`,
    await databaseWith([30, 30])
  );
  deviceA = await launchDevice(vaultPath);
  deviceB = await launchSecondDevice(vaultPath);
});

test.afterEach(async () => {
  await closeDevices([deviceA, deviceB]);
  deviceA = undefined;
  deviceB = undefined;
});

test("a restore on one device replaces the other's data there, backed up first, and the other's later saves keep the restore", async () => {
  const a = deviceA!.window;
  const b = deviceB!.window;
  const [first, second] = ARTICLES.map(({ name }) => name);

  // On B: a change of its own, which A takes on
  await reprioritize(b, second, '45');
  await waitForTakenOn(b, a);
  await reviewHome(a);
  await expect(queueRow(a, second)).toContainText(/Priority\s*4\.5/);

  // On A: restore the backup from before that change
  await recordStaleBackups(b);
  await a.locator('#restore-backup-button').click();
  const rows = a.locator('.ir-backup-modal .ir-backup-row');
  await expect(rows).not.toHaveCount(0);
  // Newest first, so the backup seeded a day ago is last
  await rows.last().locator('button').click();
  await a.locator('.modal-container.mod-confirmation .mod-cta').click();
  await expect(a.locator('.ir-backup-modal')).toHaveCount(0);
  await expect(queueRow(a, second)).toContainText(/Priority\s*3\.0/);
  await waitForTakenOn(a, b);

  // On B: the restored data, its own change gone. A backed up what it
  // replaced, and B did too, one backup each: both copies held B's change
  await reviewHome(b);
  await expect(queueRow(b, second)).toContainText(/Priority\s*3\.0/);
  await expect.poll(() => staleBackupsWrittenBy(b)).toHaveLength(1);
  await expect.poll(async () => (await staleBackups()).length).toBe(2);
  for (const backup of await staleBackups()) {
    expect(await prioritiesIn(backup)).toEqual([30, 45]);
  }

  // On B: a later change, which A takes on without the restore coming undone
  await reprioritize(b, first, '45');
  await waitForTakenOn(b, a);
  await reviewHome(a);
  await expect(queueRow(a, first)).toContainText(/Priority\s*4\.5/);
  await expect(queueRow(a, second)).toContainText(/Priority\s*3\.0/);
  expect(await prioritiesIn(path.join(vaultPath, DATABASE_FILE_PATH))).toEqual([
    45, 30,
  ]);
});
