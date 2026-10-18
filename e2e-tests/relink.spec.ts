import test, {
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { executeCommandById, reviewTitle, setNativeMenus } from './helpers';
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
  vaultPath = await createVaultCopy('relink');
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
  workspace: {
    getLeaf(newLeaf: 'tab'): {
      openFile(file: unknown, state: unknown): Promise<void>;
    };
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
      }
    >;
  };
};

type Table = 'article' | 'snippet';

/** Run `sql` against the running plugin's database. */
const mutate = (sql: string, params: unknown[]) =>
  window.evaluate(
    async ([sql, params]) => {
      const { app } = window as unknown as { app: PageApp };
      const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
      await repo.mutate(sql, params);
    },
    [sql, params] as const
  );

/** Whether Obsidian has indexed a file at `at`. */
const hasFile = (at: string) =>
  window.evaluate(
    (p) =>
      (window as unknown as { app: PageApp }).app.vault.getFileByPath(p) !==
      null,
    at
  );

/** Write a file into the vault and wait for Obsidian to index it. */
async function writeVaultFile(at: string, content: string | Buffer) {
  await fs.mkdir(path.dirname(path.join(vaultPath, at)), { recursive: true });
  await fs.writeFile(path.join(vaultPath, at), content);
  await expect.poll(() => hasFile(at)).toBe(true);
}

/**
 * An item due now, with a review behind it, whose file is at `fileAt` — and
 * then lost it: its row is pointed at `lostAt`, where nothing is. That is what
 * a delete while Obsidian was closed leaves, with the file recreated at
 * `fileAt` under a new name or place.
 */
async function seedLostItem(
  table: Table,
  id: string,
  fileAt: string,
  lostAt: string
) {
  // A fuzz already rolled, as any reviewed item has: left null, one is rolled
  // the first time the item's file resolves, which moves its shown due date by
  // up to six hours, and across midnight in the evening.
  await mutate(
    `INSERT INTO ${table} (id, reference, due, due_fuzz, interval, priority)
     VALUES ($1, $2, $3, 0, 86400000, 25)`,
    [id, fileAt, Date.now() - 60_000]
  );
  await mutate(
    `INSERT INTO ${table}_review (id, ${table}_id, review_time)
     VALUES ($1, $2, $3)`,
    [`${id}-review`, id, Date.now() - 86_400_000]
  );
  await mutate(`UPDATE ${table} SET reference = $1 WHERE id = $2`, [
    lostAt,
    id,
  ]);
}

/** A snippet of `parent`'s, due well after the parent, with its own note. */
async function seedChild(parent: string) {
  await writeVaultFile('snippets/child.md', 'A snippet\n');
  await mutate(
    `INSERT INTO snippet (id, reference, parent, due, interval, priority)
     VALUES ('child', 'snippets/child.md', $1, $2, 86400000, 30)`,
    [parent, Date.now() + 1e9]
  );
}

/** The relink picker, once open. */
const picker = () => window.locator('.prompt');

/** Pick `path` in the open relink picker. */
async function pick(path: string) {
  await expect(picker()).toBeVisible();
  await picker().locator('.prompt-input').fill(path);
  await picker()
    .locator('.suggestion-item')
    .filter({ hasText: path })
    .first()
    .click();
  await expect(picker()).toBeHidden();
}

/** Every path the open picker offers, with the filter cleared. */
const offered = () => picker().locator('.suggestion-item').allTextContents();

/**
 * The queue row whose File column is `reference`, as its cell's tooltip reads
 * it. A missing item's reads "No file at …" instead, so this is never one.
 */
const queueRow = (reference: string) =>
  window.locator('.ir-queue-row').filter({
    has: window.getByRole('cell', { name: reference, exact: true }),
  });

/** The queue rows flagged as missing their file. */
const missingRows = () =>
  window
    .locator('.ir-queue-row')
    .filter({ has: window.locator('.ir-queue-missing-badge') });

/** A queue row's Due cell. */
const dueCell = (row: Locator) => row.locator('[data-column="due"]');

/** A queue row's Scheduling cell. */
const schedulingCell = (row: Locator) =>
  row.locator('[data-column="scheduling"]');

/** A priority as the queue's Scheduling column shows it: 25 reads "2.5". */
const shownPriority = (priority: number) => (priority / 10).toFixed(1);

/**
 * Open a menu with `open` until it shows `title`, choose that, and wait for
 * the menu to go. Obsidian's menus animate in, and on a loaded runner the
 * first right click can land before the row takes it, so it is repeated.
 */
async function chooseFromMenu(open: () => Promise<void>, title: string) {
  const menu = window.locator('.menu');
  const item = menu.getByText(title, { exact: true });
  await expect(async () => {
    if ((await menu.count()) === 0) await open();
    await expect(item).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await item.click();
  await expect(menu).toHaveCount(0);
}

/** The command palette, once open. */
const palette = () => window.locator('.modal-container .prompt');

/** Open the command palette, filtered to `query`. */
async function searchPalette(query: string) {
  await executeCommandById(window, 'command-palette:open');
  await expect(palette()).toBeVisible();
  await palette().locator('.prompt-input').fill(query);
  // The list is filtered as the query lands: wait for what it found
  await expect(
    palette().locator('.suggestion-item, .suggestion-empty').first()
  ).toBeVisible();
}

// #endregion

test('relinks a missing PDF article from the queue row menu', async () => {
  const bytes = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
      'trailer<</Root 1 0 R>>\n%%EOF\n',
    'latin1'
  );
  await writeVaultFile('papers/Found.pdf', bytes);
  await writeVaultFile('papers/Other.pdf', bytes);
  // Another live item's file, which no relink may take
  await writeVaultFile('papers/Taken.pdf', bytes);
  await mutate(
    `INSERT INTO article (id, reference, due, interval, priority)
     VALUES ('taken', 'papers/Taken.pdf', $1, 86400000, 30)`,
    [Date.now() + 1e9]
  );
  await seedLostItem('article', 'pdf', 'papers/Found.pdf', 'old/Lost.pdf');
  await seedChild('pdf');

  await executeCommandById(window, 'incremental-reading:learn');
  const row = missingRows();
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Lost.pdf');
  await expect(schedulingCell(row)).toContainText(shownPriority(25));
  const due = (await dueCell(row).textContent()) ?? '';
  expect(due).not.toBe('');
  const child = queueRow('snippets/child.md');
  await expect(child).toContainText('old/Lost.pdf');

  await setNativeMenus(window, false);
  await chooseFromMenu(
    () => row.locator('.ir-queue-cell').first().click({ button: 'right' }),
    'Relink file…'
  );
  // Only PDFs, and none another item has. The test vault ships PDF fixtures
  // of its own, which are untracked and so offered too: check what this test
  // put there rather than the whole list.
  await expect(picker()).toBeVisible();
  const paths = await offered();
  expect(paths).toEqual(
    expect.arrayContaining(['papers/Found.pdf', 'papers/Other.pdf'])
  );
  expect(paths).not.toContain('papers/Taken.pdf');
  expect(paths.every((p) => p.endsWith('.pdf'))).toBe(true);
  await pick('papers/Found.pdf');

  // The same item at the file picked, keeping its schedule and its snippet
  await expect(missingRows()).toHaveCount(0);
  const relinked = queueRow('papers/Found.pdf');
  await expect(relinked).toHaveCount(1);
  await expect(schedulingCell(relinked)).toContainText(shownPriority(25));
  await expect(dueCell(relinked)).toHaveText(due);
  await expect(child).toContainText('papers/Found.pdf');
  await expect(window.locator('.ir-queue-row')).toHaveCount(3);
});

test('relinks a missing note from its review placeholder, making it the item’s own', async () => {
  await writeVaultFile('found/Found note.md', 'Text of the found note\n');
  await seedLostItem('article', 'md', 'found/Found note.md', 'gone/Lost.md');

  await executeCommandById(window, 'incremental-reading:learn');
  await window.locator('css=#begin-review-button').click();
  const placeholder = window.locator('.ir-missing-item');
  await expect(placeholder).toContainText('gone/Lost.md');

  await placeholder.getByRole('button', { name: 'Relink file…' }).click();
  // Notes only, never a PDF
  await expect(picker()).toBeVisible();
  expect((await offered()).every((p) => p.endsWith('.md'))).toBe(true);
  await pick('found/Found note.md');

  await expect(reviewTitle(window, 'Found note')).toBeVisible();
  await expect(window.locator('.ir-editor')).toContainText(
    'Text of the found note'
  );
  await expect(placeholder).toBeHidden();

  // The note now carries the item's id and type tag. Opened in source mode,
  // where its properties read as written: the plugin hides `ir-id` elsewhere.
  // Undocumented: the `{ mode, source }` view state of source mode.
  await window.evaluate(async (at) => {
    const { app } = window as unknown as { app: PageApp };
    await app.workspace.getLeaf('tab').openFile(app.vault.getFileByPath(at), {
      active: true,
      state: { mode: 'source', source: true },
    });
  }, 'found/Found note.md');
  const source = window.locator('.workspace-leaf.mod-active .cm-content');
  await expect(source).toContainText('ir-id: md');
  await expect(source).toContainText('ir-article');
});

test('relinks the missing item in review from the command', async () => {
  await writeVaultFile('found/Snippet.md', 'Snippet text\n');
  await seedLostItem('snippet', 'snip', 'found/Snippet.md', 'gone/Snip.md');

  await executeCommandById(window, 'incremental-reading:learn');
  await window.locator('css=#begin-review-button').click();
  await expect(window.locator('.ir-missing-item')).toContainText(
    'gone/Snip.md'
  );

  const command = () =>
    palette().locator('.suggestion-item', { hasText: 'Relink file' });
  await searchPalette('Relink file');
  await command().first().click();
  await pick('found/Snippet.md');

  await expect(window.locator('.ir-editor')).toContainText('Snippet text');
  await expect(window.locator('.ir-missing-item')).toHaveCount(0);
  // Nothing is missing any more, so the palette no longer offers it
  await searchPalette('Relink file');
  await expect(command()).toHaveCount(0);
});
