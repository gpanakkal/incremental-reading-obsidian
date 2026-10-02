import test, {
  expect,
  type ElectronApplication,
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
  plugins: {
    plugins: Record<
      string,
      {
        reviewManager: {
          repo: {
            query(sql: string, params?: unknown[]): Record<string, unknown>[];
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

const query = (sql: string, params: unknown[] = []) =>
  window.evaluate(
    ([sql, params]) => {
      const { app } = window as unknown as { app: PageApp };
      const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
      return repo.query(sql, params);
    },
    [sql, params] as const
  );

/**
 * A row's schedule and standing. Not its intra-day fuzz or scroll position,
 * which review fills in the first time it shows an item.
 */
const schedule = async (table: Table, id: string) =>
  (
    await query(
      `SELECT due, interval, priority, dismissed, deleted FROM ${table} WHERE id = $1`,
      [id]
    )
  )[0];

const referenceOf = async (table: Table, id: string) =>
  (await query(`SELECT reference FROM ${table} WHERE id = $1`, [id]))[0]
    ?.reference;

/** The review history of an item, which hangs off its id. */
const history = (table: Table, id: string) =>
  query(
    `SELECT id, review_time FROM ${table}_review WHERE ${table}_id = $1 ORDER BY id`,
    [id]
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
  await mutate(
    `INSERT INTO ${table} (id, reference, due, interval, priority)
     VALUES ($1, $2, $3, 86400000, 25)`,
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
  const before = await schedule('article', 'pdf');
  const historyBefore = await history('article', 'pdf');

  await executeCommandById(window, 'incremental-reading:learn');
  const row = window.locator('.ir-queue-row[data-missing]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Missing');
  await expect(row).toContainText('Lost.pdf');

  await setNativeMenus(window, false);
  await row.locator('.ir-queue-cell').first().click({ button: 'right' });
  await window
    .locator('.menu')
    .getByText('Relink file…', { exact: true })
    .click();
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

  await expect
    .poll(() => referenceOf('article', 'pdf'))
    .toBe('papers/Found.pdf');
  expect(await schedule('article', 'pdf')).toEqual(before);
  expect(await history('article', 'pdf')).toEqual(historyBefore);
  expect(await query(`SELECT parent FROM snippet WHERE id = 'child'`)).toEqual([
    { parent: 'pdf' },
  ]);
  await expect(window.locator('.ir-queue-row[data-missing]')).toHaveCount(0);
  const onDisk = await fs.readFile(path.join(vaultPath, 'papers/Found.pdf'));
  expect(onDisk.equals(bytes)).toBe(true);
});

test('relinks a missing note from its review placeholder, making it the item’s own', async () => {
  await writeVaultFile('found/Found note.md', 'Text of the found note\n');
  await seedLostItem('article', 'md', 'found/Found note.md', 'gone/Lost.md');
  await seedChild('md');
  const before = await schedule('article', 'md');
  const historyBefore = await history('article', 'md');

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
  expect(await referenceOf('article', 'md')).toBe('found/Found note.md');
  expect(await schedule('article', 'md')).toEqual(before);
  expect(await history('article', 'md')).toEqual(historyBefore);
  expect(await query(`SELECT parent FROM snippet WHERE id = 'child'`)).toEqual([
    { parent: 'md' },
  ]);
  await expect
    .poll(() =>
      fs.readFile(path.join(vaultPath, 'found/Found note.md'), 'utf8')
    )
    .toMatch(/ir-id: md[\s\S]*ir-article/);
});

test('relinks the missing item in review from the command', async () => {
  await writeVaultFile('found/Snippet.md', 'Snippet text\n');
  await seedLostItem('snippet', 'snip', 'found/Snippet.md', 'gone/Snip.md');
  await seedChild('snip');
  const before = await schedule('snippet', 'snip');
  const historyBefore = await history('snippet', 'snip');

  await executeCommandById(window, 'incremental-reading:learn');
  await window.locator('css=#begin-review-button').click();
  await expect(window.locator('.ir-missing-item')).toContainText(
    'gone/Snip.md'
  );

  expect(
    await executeCommandById(window, 'incremental-reading:relink-file')
  ).toBe(true);
  await pick('found/Snippet.md');

  await expect(window.locator('.ir-editor')).toContainText('Snippet text');
  expect(await referenceOf('snippet', 'snip')).toBe('found/Snippet.md');
  expect(await schedule('snippet', 'snip')).toEqual(before);
  expect(await history('snippet', 'snip')).toEqual(historyBefore);
  expect(await query(`SELECT parent FROM snippet WHERE id = 'child'`)).toEqual([
    { parent: 'snip' },
  ]);
  // Nothing is missing any more, so the command has nothing to do.
  // `app.commands.findCommand` is unofficial Obsidian API, asked directly
  // because `executeCommandById` answers true whatever the check says.
  await expect
    .poll(() =>
      window.evaluate(() =>
        (
          window as unknown as {
            app: {
              commands: {
                findCommand(id: string): {
                  checkCallback(checking: boolean): boolean;
                };
              };
            };
          }
        ).app.commands
          .findCommand('incremental-reading:relink-file')
          .checkCallback(true)
      )
    )
    .toBe(false);
});
