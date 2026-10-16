import {
  ARTICLE_TAG,
  BACKUP_DIRECTORY,
  DATA_DIRECTORY,
  DATABASE_FILE_PATH,
} from '#/lib/constants';
import { SYNC_HOLD_MESSAGES, syncExclusionMessage } from '#/lib/obsidian-sync';
import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
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

/** The items the database holds, each with a note of its own. */
const ARTICLES = [
  { id: '00000000-0000-4000-8000-000000000001', priority: 20 },
  { id: '00000000-0000-4000-8000-000000000002', priority: 30 },
].map((article, i) => ({ ...article, reference: `sync/Article ${i + 1}.md` }));

/** What another device changed in its copy, which Sync brings down. */
const REMOTE_PRIORITIES = { [ARTICLES[0].id]: 45, [ARTICLES[1].id]: 15 };
/** What this device's stale copy holds instead. */
const STALE_PRIORITIES = { [ARTICLES[0].id]: 25 };

test.beforeAll(async () => {
  SQL = await initSqlJs({
    wasmBinary: (await fs.readFile(
      path.join(projectRoot, 'node_modules/sql.js/dist/sql-wasm.wasm')
    )) as unknown as ArrayBuffer,
  });
});

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('sync-hold');
  for (const { id, reference } of ARTICLES) {
    const notePath = path.join(vaultPath, reference);
    await fs.mkdir(path.dirname(notePath), { recursive: true });
    await fs.writeFile(
      notePath,
      `---\ntags:\n  - ${ARTICLE_TAG}\nir-id: ${id}\n---\nText of ${reference}\n`
    );
  }
  await fs.mkdir(path.join(vaultPath, path.dirname(DATABASE_FILE_PATH)), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(vaultPath, DATABASE_FILE_PATH),
    databaseBytes({ version: 10 })
  );
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
  await expect.poll(pluginArticles).toEqual(expectedArticles());
  // The plugin as an update finds it: off while its files are replaced
  await window.evaluate(async (id) => {
    const { app } = window as unknown as { app: PageApp };
    await app.plugins.disablePlugin(id);
  }, PLUGIN_ID);
});

test.afterEach(async () => {
  if (app) {
    await window
      .evaluate(() => {
        const { app } = window as unknown as { app: PageApp };
        // Back to the prototype's own lookup
        delete (app.internalPlugins as Partial<PageApp['internalPlugins']>)
          .getEnabledPluginById;
      })
      .catch(() => {});
    await closeElectron(app);
  }
  if (shouldCleanup) {
    await fs
      .rm(vaultPath, { recursive: true, force: true, maxRetries: 3 })
      .catch(() => {});
  }
});

// #region HELPERS

/**
 * What the page-side calls below reach on Obsidian and the plugin. All
 * unofficial Obsidian API: `window.app`, `app.plugins` and
 * `app.internalPlugins.getEnabledPluginById` (how the plugin finds Sync).
 */
type PageApp = {
  plugins: {
    plugins: Record<
      string,
      | {
          reviewManager?: {
            repo: {
              query(sql: string, params?: unknown[]): Record<string, unknown>[];
            };
          };
        }
      | undefined
    >;
    enablePlugin(id: string): Promise<boolean>;
    disablePlugin(id: string): Promise<void>;
  };
  internalPlugins: { getEnabledPluginById: (id: string) => unknown };
  vault: {
    getFileByPath(path: string): unknown;
    modifyBinary(file: unknown, data: ArrayBuffer): Promise<void>;
  };
};

/**
 * The fields of Obsidian Sync's instance the plugin reads (undocumented),
 * which the tests change to play out a sync. `trigger` raises
 * `status-change`, as Sync does.
 */
type FakeSync = {
  status: string;
  pause: boolean;
  ready: boolean;
  newServerFiles: { path: string; folder: boolean }[];
  allowTypes: string[];
  /** Sync's "Excluded folders"; nothing under one syncs. */
  ignoreFolders: string[];
  /** What `allowSyncFile` answers for a file under no excluded folder. */
  allowed: boolean;
  trigger(): void;
};
type PageWindow = { __irFakeSync?: FakeSync; __irSyncWaitTimeoutMs?: number };

/**
 * Stand a fake Sync in for the real one, as `getEnabledPluginById` hands it
 * out, so the real Sync plugin is never touched (its saved state would keep
 * whatever the test put there). Stays until `afterEach`.
 */
async function fakeSync(fields: Partial<Omit<FakeSync, 'trigger'>>) {
  await window.evaluate((fields) => {
    const { app } = window as unknown as { app: PageApp };
    const w = window as unknown as PageWindow;
    const listeners = new Set<{ callback: () => void }>();
    const fake: FakeSync & Record<string, unknown> = {
      status: 'syncing',
      pause: false,
      ready: false,
      newServerFiles: [],
      allowTypes: ['image', 'audio', 'pdf', 'video', 'unsupported'],
      ignoreFolders: [],
      allowed: true,
      ...fields,
      getStatus: () => fake.status,
      filter: {
        // Sync's own folder rule: a file is under an excluded folder when its
        // path starts with the folder plus `/`
        allowSyncFile: (path: string) =>
          fake.allowed &&
          !fake.ignoreFolders.some((folder) => path.startsWith(`${folder}/`)),
        get allowTypes() {
          return new Set(fake.allowTypes);
        },
        get ignoreFolders() {
          return fake.ignoreFolders;
        },
      },
      on: (_name: string, callback: () => void) => {
        const ref = { callback };
        listeners.add(ref);
        return ref;
      },
      offref: (ref: { callback: () => void }) => listeners.delete(ref),
      trigger: () => listeners.forEach(({ callback }) => callback()),
    };
    w.__irFakeSync = fake;
    const internal = app.internalPlugins;
    const lookup = internal.getEnabledPluginById;
    internal.getEnabledPluginById = (id) =>
      id === 'sync' ? fake : lookup.call(internal, id);
  }, fields);
}

/** Change the fake Sync's fields, raising `status-change` after. */
async function updateSync(fields: Partial<Omit<FakeSync, 'trigger'>>) {
  await window.evaluate((fields) => {
    const fake = (window as unknown as PageWindow).__irFakeSync!;
    Object.assign(fake, fields);
    fake.trigger();
  }, fields);
}

/** Turn the plugin on, as an update does once its files are in place. */
async function enablePlugin() {
  await window.evaluate(async (id) => {
    const { app } = window as unknown as { app: PageApp };
    await app.plugins.enablePlugin(id);
  }, PLUGIN_ID);
}

/**
 * A database holding {@link ARTICLES} at schema `version` 9 (from 0.6,
 * before the `rebind` table) or 10, with `priorities` in place of theirs.
 */
function databaseBytes({
  version,
  priorities = {},
}: {
  version: 9 | 10;
  priorities?: Record<string, number>;
}): Uint8Array {
  const schema = readSchema();
  const db = new SQL.Database();
  db.exec(schema);
  if (version === 9) db.exec('DROP TABLE rebind; PRAGMA user_version = 9');
  for (const { id, reference, priority } of ARTICLES) {
    db.run(
      `INSERT INTO article (id, reference, due, interval, priority)
       VALUES (?, ?, ?, ?, ?)`,
      [
        id,
        reference,
        Date.now() - 86_400_000,
        86_400_000,
        priorities[id] ?? priority,
      ]
    );
  }
  const bytes = db.export();
  db.close();
  return bytes;
}

let schemaText: string | null = null;
const readSchema = () =>
  (schemaText ??= readFileSync(
    path.join(projectRoot, 'src/db/schema.sql'),
    'utf8'
  ));

const writeDatabaseFile = (bytes: Uint8Array) =>
  fs.writeFile(path.join(vaultPath, DATABASE_FILE_PATH), bytes);

const readDatabaseBytes = () =>
  fs.readFile(path.join(vaultPath, DATABASE_FILE_PATH));

/** The database file on disk: its schema version and article priorities. */
async function readDatabaseFile() {
  const db = new SQL.Database(await readDatabaseBytes());
  const version = db.exec('PRAGMA user_version')[0].values[0][0];
  const rows = db.exec('SELECT id, priority FROM article ORDER BY id')[0];
  db.close();
  return {
    version,
    articles: (rows?.values ?? []).map(([id, priority]) => ({ id, priority })),
  };
}

/** Backups taken of a version 9 database before migrating it. */
async function version9Backups() {
  const names = await fs
    .readdir(path.join(vaultPath, BACKUP_DIRECTORY))
    .catch(() => [] as string[]);
  return names.filter((name) => name.includes('_v9_'));
}

/** The article rows the running plugin holds, or null before it has any. */
const pluginArticles = () =>
  window.evaluate((pluginId) => {
    const { app } = window as unknown as { app: PageApp };
    const repo = app.plugins.plugins[pluginId]?.reviewManager?.repo;
    if (!repo) return null;
    return repo
      .query('SELECT id, priority FROM article ORDER BY id')
      .map(({ id, priority }) => ({ id, priority }));
  }, PLUGIN_ID);

const expectedArticles = (priorities: Record<string, number> = {}) =>
  ARTICLES.map(({ id, priority }) => ({
    id,
    priority: priorities[id] ?? priority,
  }));

const notice = (text: string) =>
  window.locator('.notice').filter({ hasText: text });

/** Open review's home screen and wait for its queue. */
async function expectQueueShowsEveryItem() {
  await window.evaluate(() => {
    const { app } = window as unknown as {
      app: { commands: { executeCommandById(id: string): boolean } };
    };
    app.commands.executeCommandById('incremental-reading:learn');
  });
  const homeButton = window.getByLabel('Go to home screen');
  const home = window.locator('.ir-queue-panel');
  await expect(home.or(homeButton).first()).toBeVisible();
  if (await homeButton.isVisible()) await homeButton.click();
  await expect(window.locator('.ir-queue-row')).toHaveCount(ARTICLES.length);
}

// #endregion

test('a migrating startup waits for Sync, then loads the copy it delivered instead of migrating its own', async () => {
  const stale = databaseBytes({ version: 9, priorities: STALE_PRIORITIES });
  await writeDatabaseFile(stale);
  await fakeSync({
    status: 'syncing',
    ready: true,
    newServerFiles: [{ path: DATABASE_FILE_PATH, folder: false }],
  });

  await enablePlugin();

  // Held: told so after a moment, nothing written, plugin not up
  await expect(notice(SYNC_HOLD_MESSAGES.waiting)).toBeVisible();
  expect(await pluginArticles()).toBeNull();
  expect(await version9Backups()).toHaveLength(0);
  expect(Buffer.compare(await readDatabaseBytes(), stale)).toBe(0);
  // Review is not to be had yet: its command is unavailable (as the palette
  // shows it), and the ribbon says so rather than failing. `app.commands` is
  // unofficial API.
  expect(
    await window.evaluate(() => {
      const { app } = window as unknown as {
        app: {
          commands: {
            commands: Record<
              string,
              { checkCallback?: (checking: boolean) => unknown }
            >;
          };
        };
      };
      return app.commands.commands[
        'incremental-reading:learn'
      ]?.checkCallback?.(true);
    })
  ).toBe(false);
  await window.locator('.incremental-reading-ribbon').click();
  await expect(
    notice('Incremental reading: still starting. Try again in a moment.')
  ).toBeVisible();

  // Sync writes the other device's migrated copy, then dequeues it, as its
  // `syncFileDown` does
  const remote = databaseBytes({ version: 10, priorities: REMOTE_PRIORITIES });
  await window.evaluate(
    async ({ dbPath, bytes }) => {
      const { app } = window as unknown as { app: PageApp };
      const file = app.vault.getFileByPath(dbPath);
      await app.vault.modifyBinary(file, new Uint8Array(bytes).buffer);
    },
    { dbPath: DATABASE_FILE_PATH, bytes: [...remote] }
  );
  await updateSync({ newServerFiles: [], status: 'synced' });

  await expect
    .poll(pluginArticles)
    .toEqual(expectedArticles(REMOTE_PRIORITIES));
  await expect(notice(SYNC_HOLD_MESSAGES.waiting)).toHaveCount(0);
  expect(await version9Backups()).toHaveLength(0);
  expect(Buffer.compare(await readDatabaseBytes(), remote)).toBe(0);
  await expectQueueShowsEveryItem();
});

test('with Sync paused, a startup migrates at once and says so', async () => {
  await writeDatabaseFile(
    databaseBytes({ version: 9, priorities: STALE_PRIORITIES })
  );
  await fakeSync({
    status: 'paused',
    pause: true,
    ready: false,
    newServerFiles: [{ path: DATABASE_FILE_PATH, folder: false }],
  });

  await enablePlugin();

  await expect.poll(pluginArticles).toEqual(expectedArticles(STALE_PRIORITIES));
  await expect(notice(SYNC_HOLD_MESSAGES.paused.migrate)).toBeVisible();
  expect(await version9Backups()).toHaveLength(1);
  expect(await readDatabaseFile()).toEqual({
    version: 10,
    articles: expectedArticles(STALE_PRIORITIES),
  });
  await expectQueueShowsEveryItem();
});

test('when Sync never delivers, a startup migrates once the wait runs out, warning of a conflict', async () => {
  await writeDatabaseFile(
    databaseBytes({ version: 9, priorities: STALE_PRIORITIES })
  );
  await fakeSync({ status: 'error', ready: false });
  await window.evaluate(() => {
    (window as unknown as PageWindow).__irSyncWaitTimeoutMs = 3000;
  });

  await enablePlugin();

  await expect(notice(SYNC_HOLD_MESSAGES.waiting)).toBeVisible();
  expect(await version9Backups()).toHaveLength(0);
  await expect(notice(SYNC_HOLD_MESSAGES.timeout.migrate)).toBeVisible({
    timeout: 10_000,
  });
  await expect.poll(pluginArticles).toEqual(expectedArticles(STALE_PRIORITIES));
  await expect(notice(SYNC_HOLD_MESSAGES.waiting)).toHaveCount(0);
  expect(await version9Backups()).toHaveLength(1);
  expect((await readDatabaseFile()).version).toBe(10);
  await expectQueueShowsEveryItem();
});

test('a plugin turned off while it waits for Sync never migrates', async () => {
  const stale = databaseBytes({ version: 9 });
  await writeDatabaseFile(stale);
  await fakeSync({ status: 'syncing', ready: false });

  await enablePlugin();
  await expect(notice(SYNC_HOLD_MESSAGES.waiting)).toBeVisible();
  await window.evaluate(async (id) => {
    const { app } = window as unknown as { app: PageApp };
    await app.plugins.disablePlugin(id);
  }, PLUGIN_ID);
  // What would have ended the wait, had it still been listening
  await updateSync({ ready: true, status: 'synced' });

  await expect(notice(SYNC_HOLD_MESSAGES.waiting)).toHaveCount(0);
  // Long enough for a migration still under way to have saved
  await window.waitForTimeout(1500);
  expect(await version9Backups()).toHaveLength(0);
  // A wait cut short by unloading is no failure to report
  await expect(notice('Failed to initialize plugin')).toHaveCount(0);
  expect(Buffer.compare(await readDatabaseBytes(), stale)).toBe(0);
});

test('with Sync leaving the database out, a startup migrates at once and asks for "Sync all other types"', async () => {
  await writeDatabaseFile(databaseBytes({ version: 9 }));
  await fakeSync({
    status: 'synced',
    ready: false,
    allowed: false,
    allowTypes: ['image', 'audio', 'pdf', 'video'],
  });

  await enablePlugin();

  await expect.poll(pluginArticles).toEqual(expectedArticles());
  await expect(notice(syncExclusionMessage({ cause: 'type' }))).toBeVisible();
  await expect(notice(SYNC_HOLD_MESSAGES.waiting)).toHaveCount(0);
  expect(await version9Backups()).toHaveLength(1);
});

test("with the data folder among Sync's excluded folders, a startup asks to remove it", async () => {
  await writeDatabaseFile(databaseBytes({ version: 9 }));
  await fakeSync({
    status: 'synced',
    ready: true,
    ignoreFolders: ['notes', DATA_DIRECTORY],
  });

  await enablePlugin();

  await expect.poll(pluginArticles).toEqual(expectedArticles());
  await expect(
    notice(syncExclusionMessage({ cause: 'folder', folder: DATA_DIRECTORY }))
  ).toBeVisible();
  // Every type syncs, so that is not the cause
  await expect(notice(syncExclusionMessage({ cause: 'type' }))).toHaveCount(0);
  await expect(notice(SYNC_HOLD_MESSAGES.waiting)).toHaveCount(0);
});

test('with only unrelated folders excluded from Sync, a startup says nothing about Sync', async () => {
  await writeDatabaseFile(databaseBytes({ version: 9 }));
  await fakeSync({
    status: 'synced',
    ready: true,
    ignoreFolders: ['notes', `${DATA_DIRECTORY}-archive`],
  });

  await enablePlugin();

  await expect.poll(pluginArticles).toEqual(expectedArticles());
  await expect(
    notice('Incremental reading: Sync leaves the review database out')
  ).toHaveCount(0);
});
