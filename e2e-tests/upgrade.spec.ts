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

const PLUGIN_ID = 'incremental-reading';

/** The items the database starts with, each with a note of its own. */
const ARTICLES = [
  { id: '00000000-0000-4000-8000-000000000001', priority: 20 },
  { id: '00000000-0000-4000-8000-000000000002', priority: 30 },
  { id: '00000000-0000-4000-8000-000000000003', priority: 40 },
].map((article, i) => ({
  ...article,
  reference: `upgrade/Article ${i + 1}.md`,
}));

test.beforeAll(async () => {
  SQL = await initSqlJs({
    wasmBinary: (await fs.readFile(
      path.join(projectRoot, 'node_modules/sql.js/dist/sql-wasm.wasm')
    )) as unknown as ArrayBuffer,
  });
});

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('upgrade');
  await writeVersion9Vault();
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
 * What the page-side calls below reach on Obsidian and the plugin.
 * `window.app` and `app.plugins` (with `enablePlugin`/`disablePlugin`) are
 * unofficial Obsidian API: stable in practice, but undocumented.
 */
type PageApp = {
  plugins: {
    plugins: Record<
      string,
      | {
          reviewManager?: {
            repo: {
              query(sql: string, params?: unknown[]): Record<string, unknown>[];
              mutate(sql: string, params?: unknown[]): unknown;
            };
          };
        }
      | undefined
    >;
    enablePlugin(id: string): Promise<boolean>;
    disablePlugin(id: string): Promise<void>;
  };
};

/**
 * The vault as a device on 0.6 (schema version 9, before the `rebind` table)
 * left it: a database and the item notes it names. Written before Obsidian
 * starts, so the plugin first sees it already in place.
 */
async function writeVersion9Vault() {
  for (const { id, reference } of ARTICLES) {
    const notePath = path.join(vaultPath, reference);
    await fs.mkdir(path.dirname(notePath), { recursive: true });
    await fs.writeFile(
      notePath,
      `---\ntags:\n  - ${ARTICLE_TAG}\nir-id: ${id}\n---\nText of ${reference}\n`
    );
  }
  await writeVersion9Database();
}

/**
 * A schema version 9 database holding {@link ARTICLES}, with any priorities
 * given in `priorities` instead of their own.
 */
async function writeVersion9Database(priorities: Record<string, number> = {}) {
  const schema = await fs.readFile(
    path.join(projectRoot, 'src/db/schema.sql'),
    'utf8'
  );
  const db = new SQL.Database();
  db.exec(schema);
  db.exec('DROP TABLE rebind; PRAGMA user_version = 9');
  for (const { id, reference, priority: own } of ARTICLES) {
    const priority = priorities[id] ?? own;
    db.run(
      `INSERT INTO article (id, reference, due, interval, priority)
       VALUES (?, ?, ?, ?, ?)`,
      [id, reference, Date.now() - 86_400_000, 86_400_000, priority]
    );
  }
  const dbPath = path.join(vaultPath, DATABASE_FILE_PATH);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.writeFile(dbPath, db.export());
  db.close();
}

/** Backups taken of a version 9 database before migrating it. */
async function version9Backups() {
  const names = await fs.readdir(path.join(vaultPath, BACKUP_DIRECTORY));
  return names.filter((name) => name.includes('_v9_'));
}

/** The database file on disk, read as a fresh device would. */
async function readDatabaseFile() {
  const db = new SQL.Database(
    await fs.readFile(path.join(vaultPath, DATABASE_FILE_PATH))
  );
  const version = db.exec('PRAGMA user_version')[0].values[0][0];
  const rows = db.exec('SELECT id, priority FROM article ORDER BY id')[0];
  db.close();
  return {
    version,
    articles: (rows?.values ?? []).map(([id, priority]) => ({ id, priority })),
  };
}

/** The article rows the running plugin holds. */
const pluginArticles = () =>
  window.evaluate((pluginId) => {
    const { app } = window as unknown as { app: PageApp };
    const repo = app.plugins.plugins[pluginId]?.reviewManager?.repo;
    if (!repo) return null;
    return repo
      .query('SELECT id, priority FROM article ORDER BY id')
      .map(({ id, priority }) => ({ id, priority }));
  }, PLUGIN_ID);

/**
 * Disable and re-enable the plugin without restarting Obsidian, which is how
 * Obsidian installs an update, running `whileDisabled` in between. Waits for
 * the new instance's database.
 */
async function reloadPluginInPlace(whileDisabled?: () => Promise<void>) {
  await window.evaluate(async (id) => {
    const { app } = window as unknown as { app: PageApp };
    const w = window as unknown as { __irOldInstance?: unknown };
    w.__irOldInstance = app.plugins.plugins[id];
    await app.plugins.disablePlugin(id);
  }, PLUGIN_ID);
  await whileDisabled?.();
  await window.evaluate(async (id) => {
    const { app } = window as unknown as { app: PageApp };
    await app.plugins.enablePlugin(id);
  }, PLUGIN_ID);
  await expect
    .poll(() =>
      window.evaluate((id) => {
        const { app } = window as unknown as { app: PageApp };
        const w = window as unknown as { __irOldInstance?: unknown };
        const plugin = app.plugins.plugins[id];
        return (
          plugin !== undefined &&
          plugin !== w.__irOldInstance &&
          plugin.reviewManager !== undefined
        );
      }, PLUGIN_ID)
    )
    .toBe(true);
}

/**
 * Open review on its home screen and wait for the queue to load. Review may
 * open on the item it last showed instead, as the new instance resumes the
 * session the old one left, so this goes home from there.
 */
async function openQueue() {
  await executeCommandById(window, 'incremental-reading:learn');
  const home = window.locator('.ir-queue-panel');
  const homeButton = window.getByLabel('Go to home screen');
  await expect(home.or(homeButton).first()).toBeVisible();
  if (await homeButton.isVisible()) await homeButton.click();
  await expect(home).toBeVisible();
}

const expectedArticles = (priorities: Record<string, number> = {}) =>
  ARTICLES.map(({ id, priority }) => ({
    id,
    priority: priorities[id] ?? priority,
  }));

// #endregion

test('re-enabling the plugin in place keeps every item and every change', async () => {
  // Startup migrated the v9 file, backing it up first
  await expect.poll(pluginArticles).toEqual(expectedArticles());
  expect(await version9Backups()).toHaveLength(1);
  await openQueue();
  await expect(window.locator('.ir-queue-row')).toHaveCount(ARTICLES.length);

  // A change made before the update, which has to survive it
  const changed = ARTICLES[0].id;
  await window.evaluate(
    ({ pluginId, articleId }) => {
      const { app } = window as unknown as { app: PageApp };
      app.plugins.plugins[pluginId]?.reviewManager?.repo.mutate(
        'UPDATE article SET priority = 45 WHERE id = $1',
        [articleId]
      );
    },
    { pluginId: PLUGIN_ID, articleId: changed }
  );
  await expect.poll(() => pendingSaves(window)).toBe(0);

  await reloadPluginInPlace();

  const afterReload = expectedArticles({ [changed]: 45 });
  await expect.poll(pluginArticles).toEqual(afterReload);
  await openQueue();
  await expect(window.locator('.ir-queue-row')).toHaveCount(ARTICLES.length);
  await expect(window.locator('#begin-review-button')).toBeEnabled();
  await expect(window.getByText('Nothing due for review')).toHaveCount(0);
  expect(await readDatabaseFile()).toEqual({
    version: 10,
    articles: afterReload,
  });
});

test('an update that meets a v9 database migrates it in place, keeping every item', async () => {
  await expect.poll(pluginArticles).toEqual(expectedArticles());
  await openQueue();
  // What an update from 0.6 finds: the database as 0.6 left it, which the
  // old instance hands over as it unloads
  const changed = ARTICLES[1].id;
  const priorities = { [changed]: 35 };

  await reloadPluginInPlace(() => writeVersion9Database(priorities));

  await expect.poll(pluginArticles).toEqual(expectedArticles(priorities));
  expect(await version9Backups()).toHaveLength(2);
  await openQueue();
  await expect(window.locator('.ir-queue-row')).toHaveCount(ARTICLES.length);
  await expect(window.locator('#begin-review-button')).toBeEnabled();
  expect(await readDatabaseFile()).toEqual({
    version: 10,
    articles: expectedArticles(priorities),
  });
});
