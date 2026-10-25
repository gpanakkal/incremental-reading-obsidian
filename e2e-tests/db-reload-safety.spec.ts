import { ARTICLE_TAG, DATABASE_FILE_PATH } from '#/lib/constants';
import { POSITIONS_KEY } from '#/lib/reading-positions';
import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import {
  executeCommandById,
  importArticle,
  openNote,
  pendingSaves,
  selectParagraph,
} from './helpers';
import {
  closeElectron,
  createVaultCopy,
  launchElectron,
  openVault,
  projectRoot,
  shouldCleanup,
  waitForLayoutReady,
} from './setup/helpers';

/**
 * 0217: "Reload app without saving" while a save was under way left the
 * database file empty, and the plugin refused to start on it.
 */

let app: ElectronApplication;
let window: Page;
let vaultPath: string;
let SQL: SqlJsStatic;

const PLUGIN_ID = 'incremental-reading';

/** The items the database starts with, each with a note of its own. */
const ARTICLES = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
].map((id, i) => ({ id, reference: `reload-safety/Article ${i + 1}.md` }));

/** Paragraphs of the test vault's source note to take snippets of. */
const SOURCE = 'sources/Security Principles';
/** A source note to import as an article and read part way. */
const MORE_TEXT =
  'sources/Memorizing a programming language using spaced repetition';
const PARAGRAPHS = [
  'Security has become a buzzword',
  'Before we start discussing the different security principles',
  'It is impossible to achieve perfect security',
];

test.beforeAll(async () => {
  SQL = await initSqlJs({
    wasmBinary: (await fs.readFile(
      path.join(projectRoot, 'node_modules/sql.js/dist/sql-wasm.wasm')
    )) as unknown as ArrayBuffer,
  });
});

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('db-reload-safety');
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
 * What the page-side calls below reach. `window.app`, `app.plugins`,
 * `app.commands` and the desktop adapter's `fsPromises` are unofficial
 * Obsidian API: stable in practice, but undocumented.
 */
type PageApp = {
  vault: {
    adapter: {
      getFullPath(path: string): string;
      fsPromises: {
        writeFile(path: string, ...rest: unknown[]): Promise<void>;
        open(path: string, flags: string): Promise<{ close(): Promise<void> }>;
      };
    };
  };
  commands: { executeCommandById(id: string): boolean };
  plugins: {
    plugins: Record<
      string,
      | {
          reviewManager?: {
            repo: { query(sql: string): unknown[] };
          };
        }
      | undefined
    >;
  };
};

/** Write {@link ARTICLES}' notes and a database holding them. */
async function writeVault(): Promise<Uint8Array> {
  for (const { id, reference } of ARTICLES) {
    const notePath = path.join(vaultPath, reference);
    await fs.mkdir(path.dirname(notePath), { recursive: true });
    await fs.writeFile(
      notePath,
      `---\ntags:\n  - ${ARTICLE_TAG}\nir-id: ${id}\n---\nText of ${reference}\n`
    );
  }
  const db = new SQL.Database();
  db.exec(
    await fs.readFile(path.join(projectRoot, 'src/db/schema.sql'), 'utf8')
  );
  for (const { id, reference } of ARTICLES) {
    db.run(
      `INSERT INTO article (id, reference, due, interval, priority)
       VALUES (?, ?, ?, ?, 30)`,
      [id, reference, Date.now() - 86_400_000, 86_400_000]
    );
  }
  const bytes = db.export();
  db.close();
  const dbPath = path.join(vaultPath, DATABASE_FILE_PATH);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.writeFile(dbPath, bytes);
  return bytes;
}

async function start() {
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
  // CI runs headed in a small window; pin it so layout matches everywhere
  await window.setViewportSize({ width: 1280, height: 800 });
}

/** How many rows of `table` the plugin's database holds. */
async function rowCount(table: string): Promise<number> {
  return window.evaluate(
    ({ pluginId, table }) => {
      const { app } = window as unknown as { app: PageApp };
      const repo = app.plugins.plugins[pluginId]?.reviewManager?.repo;
      return repo ? repo.query(`SELECT id FROM ${table}`).length : -1;
    },
    { pluginId: PLUGIN_ID, table }
  );
}

/**
 * Cut the next write of the database file, or of a sibling of it, the way
 * reloading the window does: Node's `writeFile` opens the file truncated and
 * only then writes its bytes, so a reload in between leaves it empty. Here
 * the reload comes right after the truncate, every time, rather than once
 * in a while. Through an override on the adapter's own `fsPromises`, which
 * the reload discards with the rest of the page.
 */
async function reloadMidWrite() {
  await window.evaluate((dbPath) => {
    const { app } = window as unknown as { app: PageApp };
    const { adapter } = app.vault;
    const fsPromises = adapter.fsPromises;
    const live = adapter.getFullPath(dbPath);
    const slash = Math.max(live.lastIndexOf('/'), live.lastIndexOf('\\'));
    const folder = live.slice(0, slash + 1);
    const name = live.slice(slash + 1);
    /** The live file, or one of its hidden siblings (`db-file.ts`). */
    const isDatabaseFile = (target: string) =>
      target === live ||
      (target.startsWith(`${folder}.${name}.`) &&
        !/[\\/]/.test(target.slice(folder.length)));
    (window as unknown as { __irBeforeReload?: boolean }).__irBeforeReload =
      true;
    adapter.fsPromises = Object.create(fsPromises, {
      writeFile: {
        value: async (target: string, ...rest: unknown[]) => {
          if (!isDatabaseFile(target)) {
            return fsPromises.writeFile(target, ...rest);
          }
          const handle = await fsPromises.open(target, 'w');
          await handle.close();
          location.reload();
          return new Promise<void>(() => {});
        },
      },
    }) as typeof fsPromises;
  }, DATABASE_FILE_PATH);
}

/** Wait out the reload {@link reloadMidWrite} set off, and the plugin's start. */
async function waitForReload() {
  await expect
    .poll(
      () =>
        window
          .evaluate(
            () =>
              !(window as unknown as { __irBeforeReload?: boolean })
                .__irBeforeReload
          )
          // A read the navigation cuts off
          .catch(() => false),
      { timeout: 30_000 }
    )
    .toBe(true);
  await waitForLayoutReady(window);
  // Its commands go to waste until the database is up
  await expect.poll(() => rowCount('article')).not.toBe(-1);
}

/**
 * Open review on its home screen and check its queue holds a row for each of
 * {@link ARTICLES}: the plugin started on the database and its items.
 */
async function expectQueuedArticles() {
  await executeCommandById(window, `${PLUGIN_ID}:learn`);
  const home = window.locator('.ir-queue-panel');
  const homeButton = window.getByLabel('Go to home screen');
  await expect(home.or(homeButton).first()).toBeVisible();
  if (await homeButton.isVisible()) await homeButton.click();
  await expect(home).toBeVisible();
  for (const { reference } of ARTICLES) {
    await expect(
      window.locator('.ir-queue-row').filter({ hasText: reference })
    ).toHaveCount(1);
  }
}

// #endregion

test('reloading the app while undone snippets are being saved keeps every item', async () => {
  await writeVault();
  await start();
  await openNote(window, SOURCE);
  for (const paragraph of PARAGRAPHS) {
    await selectParagraph(window, paragraph);
    await executeCommandById(window, `${PLUGIN_ID}:extract-selection`);
  }
  await expect.poll(() => rowCount('snippet')).toBe(PARAGRAPHS.length);
  await expect.poll(() => pendingSaves(window)).toBe(0);

  // Undone in quick succession, each a write and a save, and the app
  // reloaded under the first save to reach the disk
  await reloadMidWrite();
  await window.evaluate((pluginId) => {
    const { app } = window as unknown as { app: PageApp };
    for (let i = 0; i < 3; i++) {
      app.commands.executeCommandById(`${pluginId}:undo`);
    }
  }, PLUGIN_ID);
  await waitForReload();

  await expectQueuedArticles();
  // Every snippet the last save that landed held, at the least
  expect(await rowCount('snippet')).toBeGreaterThan(0);
});

test('reloading the app a while after undoing snippets, with an item note read part way, keeps every item', async () => {
  // The fourth time the file was emptied: nothing was being saved when the
  // reload came, but the reload hides the page, and the reading position
  // then written started a save the reload cut off
  await writeVault();
  await start();
  await openNote(window, SOURCE);
  for (const paragraph of PARAGRAPHS) {
    await selectParagraph(window, paragraph);
    await executeCommandById(window, `${PLUGIN_ID}:extract-selection`);
  }
  await expect.poll(() => rowCount('snippet')).toBe(PARAGRAPHS.length);
  for (let i = 0; i < PARAGRAPHS.length; i++) {
    await executeCommandById(window, `${PLUGIN_ID}:undo`);
  }
  // An item note opened afresh and scrolled, so a reading position waits
  await importArticle(window, MORE_TEXT);
  // Once the import's frontmatter is indexed
  let article = '';
  let id = '';
  await expect
    .poll(async () => {
      [article, id] = await window.evaluate(() => {
        const { app } = window as unknown as {
          app: {
            workspace: { getActiveFile(): { path: string } | null };
            metadataCache: {
              getFileCache(file: { path: string }): {
                frontmatter?: Record<string, unknown>;
              } | null;
            };
          };
        };
        const file = app.workspace.getActiveFile();
        const irId = file
          ? app.metadataCache.getFileCache(file)?.frontmatter?.['ir-id']
          : undefined;
        return [file?.path ?? '', typeof irId === 'string' ? irId : ''];
      });
      return id;
    })
    .not.toBe('');
  await executeCommandById(window, 'workspace:close');
  await openNote(window, article.replace(/\.md$/, ''));
  const scroller = window.locator(
    '.workspace-leaf.mod-active [data-type="markdown"] .markdown-source-view .cm-scroller'
  );
  await scroller.hover();
  // The scroll listener goes on once the mount-time restore has run, so
  // scroll until a position is held
  const heldPosition = () =>
    window.evaluate(
      ([itemId, key]) => {
        const entries = (
          window as unknown as {
            app: { loadLocalStorage(key: string): unknown };
          }
        ).app.loadLocalStorage(key) as Record<
          string,
          { position?: number }
        > | null;
        return entries?.[itemId]?.position ?? 0;
      },
      [id, POSITIONS_KEY] as const
    );
  await expect(async () => {
    await window.mouse.wheel(0, 600);
    await expect.poll(heldPosition, { timeout: 2000 }).toBeGreaterThan(0);
  }).toPass({ timeout: 30_000 });
  await expect.poll(() => pendingSaves(window)).toBe(0);
  // The wait the user left before reloading
  await window.waitForTimeout(5000);

  await window.evaluate(() => {
    (window as unknown as { __irBeforeReload?: boolean }).__irBeforeReload =
      true;
    // After this call returns, which the reload would otherwise cut off
    setTimeout(() =>
      (window as unknown as { app: PageApp }).app.commands.executeCommandById(
        'app:reload'
      )
    );
  });
  await waitForReload();

  await expectQueuedArticles();
});

test('a database file left empty is restored from the copy kept before the last save, saying so', async () => {
  const bytes = await writeVault();
  const dbPath = path.join(vaultPath, DATABASE_FILE_PATH);
  const prev = path.join(
    path.dirname(dbPath),
    `.${path.basename(dbPath)}.prev`
  );
  await fs.writeFile(prev, bytes);
  await fs.writeFile(dbPath, new Uint8Array(0));

  await start();

  await expectQueuedArticles();
  // The notice names the copy it restored from
  await expect(
    window.locator('.notice').filter({ hasText: path.basename(prev) })
  ).toHaveCount(1);
});
