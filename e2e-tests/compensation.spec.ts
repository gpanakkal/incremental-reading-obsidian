import { ARTICLE_TAG, DATA_DIRECTORY, SNIPPET_TAG } from '#/lib/constants';
import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import {
  executeCommandById,
  finalizeArticleImport,
  openNote,
  pendingSaves,
  selectParagraph,
  watchNotices,
} from './helpers';
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
  vaultPath = await createVaultCopy('compensation');
});

/** Start Obsidian on the vault copy, as it is by then. */
async function start() {
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
  // CI runs headed in a small window; pin it so layout matches everywhere
  await window.setViewportSize({ width: 1280, height: 800 });
}

test.afterEach(async () => {
  if (app) await closeElectron(app);
  if (shouldCleanup) {
    await fs
      .rm(vaultPath, { recursive: true, force: true, maxRetries: 3 })
      .catch(() => {});
  }
});

// #region HELPERS

const SOURCE = 'sources/Security Principles';
const PARAGRAPH =
  'Before we start discussing the different security principles';

/**
 * What the page-side calls below reach. `window.app`, `app.plugins` and the
 * repository's protected `blockWrites` are unofficial: stable in practice,
 * but undocumented.
 */
type PageWindow = {
  app: {
    vault: {
      getFiles(): { path: string }[];
      setConfig(key: string, value: unknown): void;
      adapter: {
        readBinary: (this: unknown, path: string) => Promise<ArrayBuffer>;
      };
    };
    metadataCache: {
      getCache(path: string): { frontmatter?: Record<string, unknown> } | null;
    };
    plugins: {
      plugins: Record<
        string,
        {
          reviewManager: {
            repo: {
              readonly readiness: string;
              readonly dbFilePath: string;
              handleFileChange(file: { path: string }): Promise<void>;
              save(): Promise<void>;
              blockWrites(error: Error): Error;
              mutate: (query: string, params?: unknown[]) => unknown;
              query(query: string, params?: unknown[]): unknown[];
              onReadinessChange: (
                listener: (state: string) => void
              ) => () => void;
            };
          };
          leftovers?: { current: readonly unknown[] };
        }
      >;
    };
  };
};

/** Paths of every file in the plugin's data folder but its database's. */
async function itemFiles(window: Page): Promise<string[]> {
  return window.evaluate((dataDirectory) => {
    const { app } = window as unknown as PageWindow;
    return app.vault
      .getFiles()
      .map((file) => file.path)
      .filter(
        (path) => path.startsWith(`${dataDirectory}/`) && path.endsWith('.md')
      )
      .sort();
  }, DATA_DIRECTORY);
}

/** How many rows `table` holds. */
async function rowCount(window: Page, table: string): Promise<number> {
  return window.evaluate((table) => {
    const { app } = window as unknown as PageWindow;
    const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
    return repo.query(`SELECT id FROM ${table}`).length;
  }, table);
}

/** Refuse writes, as a changed database file that won't load does. */
async function pauseSaving(window: Page) {
  await window.evaluate(() => {
    const { app } = window as unknown as PageWindow;
    const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
    repo.blockWrites(new Error('Paused for the test.'));
  });
}

/**
 * Hold the repository merging, as it is while it takes in a copy of the
 * database another device wrote: its read of the file is held until
 * {@link endMerge}. Through the page's adapter and the repository's own
 * `handleFileChange`, the path a Sync download takes.
 */
async function holdMerging(window: Page) {
  await window.evaluate(async () => {
    const { app } = window as unknown as PageWindow;
    const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
    // A fresh vault's database is in memory until its first write, and a
    // file that isn't there would read as one that won't load. `save` is
    // protected, so reached past its type.
    await repo.save();
    const { adapter } = app.vault;
    const original = adapter.readBinary;
    // Called on the adapter, which it reads its folder from
    const read = (path: string) =>
      original.call(adapter, path) as Promise<ArrayBuffer>;
    const w = window as unknown as { __irEndMerge?: () => void };
    adapter.readBinary = (path) => {
      if (path !== repo.dbFilePath) return read(path);
      adapter.readBinary = read;
      return new Promise((resolve) => {
        w.__irEndMerge = () => resolve(read(path));
      });
    };
    void repo.handleFileChange({ path: repo.dbFilePath });
  });
  await expect.poll(() => readiness(window)).toBe('merging');
}

/** Let the read {@link holdMerging} held go on, ending the merge. */
async function endMerge(window: Page) {
  await window.evaluate(() =>
    (window as unknown as { __irEndMerge?: () => void }).__irEndMerge?.()
  );
  await expect.poll(() => readiness(window)).toBe('ready');
}

/** The repository's readiness (see `SQLiteRepository.readiness`). */
async function readiness(window: Page): Promise<string> {
  return window.evaluate(
    () =>
      (window as unknown as PageWindow).app.plugins.plugins[
        'incremental-reading'
      ].reviewManager.repo.readiness
  );
}

/** Write the note at vault path `path`, holding `frontmatter`, then `body`. */
async function writeNote(
  path: string,
  frontmatter: Record<string, unknown>,
  body = 'left behind'
) {
  const file = `${vaultPath}/${path}`;
  await fs.mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
  await fs.writeFile(
    file,
    `---
${JSON.stringify(frontmatter)}
---
${body}
`
  );
}

/** The notice counting leftovers, once it is up. */
const leftoverNotice = () =>
  window.locator('.notice', { hasText: /\b\d+ notes?\b/ });

/** The review home screen's button for the leftovers. */
const leftoverButton = () =>
  window.getByRole('button', {
    name: /^Manage \d+ notes? not found in the database$/,
  });

/**
 * Wait for the startup scan to have found `count` leftovers, which is when
 * the notice would show were it shown on load.
 */
async function leftoversFound(count: number) {
  await expect
    .poll(() =>
      window.evaluate(
        () =>
          (window as unknown as PageWindow).app.plugins.plugins[
            'incremental-reading'
          ].leftovers?.current.length ?? -1
      )
    )
    .toBe(count);
}

/** Open review, on its home screen. */
async function openReview() {
  await executeCommandById(window, 'incremental-reading:learn');
  await expect(window.locator('#begin-review-button')).toBeVisible();
}

/**
 * Start Obsidian once to give the database an item of its own, then close it:
 * leftovers are asked about only once the database holds items, as an empty
 * one may be one Sync has yet to bring down.
 */
async function seedItem() {
  await start();
  await window.evaluate(() => {
    const { app } = window as unknown as PageWindow;
    const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
    repo.mutate(
      `INSERT INTO article (id, reference, due, interval, priority)
       VALUES ('seeded', 'seeded.md', 0, 1, 30)`
    );
  });
  await expect.poll(() => pendingSaves(window)).toBe(0);
  await expect.poll(() => rowCount(window, 'article')).toBe(1);
  await closeElectron(app);
}

// #endregion

test.describe('Making items while saving is paused', () => {
  test.beforeEach(start);

  test('makes no snippet note, and says so', async () => {
    const notices = await watchNotices(window);
    await openNote(window, SOURCE);
    await pauseSaving(window);

    await selectParagraph(window, PARAGRAPH);
    await executeCommandById(window, 'incremental-reading:extract-selection');

    await expect
      .poll(notices)
      .toContainEqual(expect.stringMatching(/snippet.*paused/));
    expect(await itemFiles(window)).toEqual([]);
    expect(await rowCount(window, 'snippet')).toBe(0);
  });

  test("imports nothing, leaving the note's frontmatter as it was", async () => {
    const notices = await watchNotices(window);
    await openNote(window, SOURCE);
    const before = await window.evaluate(
      (path) =>
        (window as unknown as PageWindow).app.metadataCache.getCache(path)
          ?.frontmatter ?? null,
      `${SOURCE}.md`
    );
    await pauseSaving(window);

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);

    await expect
      .poll(notices)
      .toContainEqual(
        expect.stringMatching(/"Security Principles\.md".*paused/)
      );
    expect(await itemFiles(window)).toEqual([]);
    expect(await rowCount(window, 'article')).toBe(0);
    expect(
      await window.evaluate(
        (path) =>
          (window as unknown as PageWindow).app.metadataCache.getCache(path)
            ?.frontmatter ?? null,
        `${SOURCE}.md`
      )
    ).toEqual(before);
  });
});

test.describe('Making items while the database takes in another copy', () => {
  test.beforeEach(start);

  test('imports nothing, says so, and leaves the note byte for byte as it was', async () => {
    const notices = await watchNotices(window);
    await openNote(window, SOURCE);
    const before = await fs.readFile(`${vaultPath}/${SOURCE}.md`);
    await holdMerging(window);

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);

    await expect
      .poll(notices)
      .toContainEqual(expect.stringMatching(/"Security Principles\.md"/));
    expect(await readiness(window)).toBe('merging');
    expect(await rowCount(window, 'article')).toBe(0);
    expect(await itemFiles(window)).toEqual([]);
    expect(await fs.readFile(`${vaultPath}/${SOURCE}.md`)).toEqual(before);
    await endMerge(window);
    expect(await rowCount(window, 'article')).toBe(0);
    expect(await fs.readFile(`${vaultPath}/${SOURCE}.md`)).toEqual(before);
  });

  test('imports once a merge that ends within a moment is over', async () => {
    await openNote(window, SOURCE);
    await holdMerging(window);
    // The merge ends a moment after the import starts waiting it out, well
    // within the wait (`MERGE_WAIT_MS`): timed in the page, as round trips
    // to it would make the moment unknown
    await window.evaluate(() => {
      const { repo } = (window as unknown as PageWindow).app.plugins.plugins[
        'incremental-reading'
      ].reviewManager;
      const w = window as unknown as { __irEndMerge?: () => void };
      const listen = repo.onReadinessChange;
      repo.onReadinessChange = (listener) => {
        repo.onReadinessChange = listen;
        globalThis.setTimeout(() => w.__irEndMerge?.(), 100);
        return Reflect.apply(listen, repo, [listener]) as () => void;
      };
    });

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);

    await expect.poll(() => rowCount(window, 'article')).toBe(1);
    expect(await readiness(window)).toBe('ready');
  });
});

test.describe('Making an item whose row cannot be saved', () => {
  test.beforeEach(start);

  test('trashes the snippet note it made', async () => {
    const notices = await watchNotices(window);
    await openNote(window, SOURCE);
    // Throws as a statement SQLite rejects does, past the check made before
    // anything is touched. Trashed into the vault, not the system's trash
    // (`vault.setConfig` is unofficial Obsidian API).
    await window.evaluate(() => {
      const { app } = window as unknown as PageWindow;
      app.vault.setConfig('trashOption', 'local');
      const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
      const { mutate } = repo;
      repo.mutate = (query, params) => {
        if (query.startsWith('INSERT INTO snippet')) {
          throw new Error('Rejected for the test');
        }
        return Reflect.apply(mutate, repo, [query, params]);
      };
    });

    await selectParagraph(window, PARAGRAPH);
    await executeCommandById(window, 'incremental-reading:extract-selection');

    await expect
      .poll(notices)
      .toContainEqual(expect.stringContaining('Failed to create the snippet'));
    await expect.poll(() => itemFiles(window)).toEqual([]);
    expect(await rowCount(window, 'snippet')).toBe(0);
  });
});

test.describe('Notes left without review data by a crash', () => {
  test('counts them once review opens, not before, and saves one the plugin made as the type its tag names on a plain Confirm, nothing on Cancel', async () => {
    const path = `${DATA_DIRECTORY}/snippets/Left behind.md`;
    await seedItem();
    await writeNote(path, { 'ir-id': 'left-1', tags: [SNIPPET_TAG] });
    await start();

    await leftoversFound(1);
    await expect(leftoverNotice()).toHaveCount(0);
    await openReview();
    await expect(leftoverNotice()).toHaveText(/\b1 note\b/);
    expect(await rowCount(window, 'snippet')).toBe(0);
    await leftoverNotice().getByText('Manage', { exact: true }).click();
    const modal = window.locator('.modal');
    await modal.getByRole('button', { name: 'Move to trash' }).click();
    await modal.getByRole('button', { name: 'Cancel' }).click();

    await expect(modal).toBeHidden();
    await expect(leftoverButton()).toBeVisible();
    await expect.poll(() => itemFiles(window)).toEqual([path]);

    await leftoverButton().click();
    // Its tag's type shown, and chosen already
    await expect(modal.getByRole('combobox')).toHaveValue('snippet');
    await expect(modal.getByRole('button', { name: 'Confirm' })).toBeEnabled();
    await modal.getByRole('button', { name: 'Confirm' }).click();

    await expect(modal).toBeHidden();
    await expect.poll(() => rowCount(window, 'snippet')).toBe(1);
    // The seeded one alone
    expect(await rowCount(window, 'article')).toBe(1);
    // None left, so the home screen has nothing to offer for them
    await expect(leftoverButton()).toHaveCount(0);
  });

  test('lists a note holding only an id, from the notice and from the review home screen, only hides the notice when its body is clicked, and trashes the note on Confirm', async () => {
    const path = `${DATA_DIRECTORY}/Untagged.md`;
    await seedItem();
    await writeNote(path, { 'ir-id': 'left-3' });
    await start();
    await leftoversFound(1);

    await openReview();
    await expect(leftoverNotice()).toBeVisible();
    await leftoverNotice().locator('.notice-message').click();

    await expect(leftoverNotice()).toHaveCount(0);
    await expect(window.locator('.modal')).toHaveCount(0);

    await leftoverButton().click();
    const modal = window.locator('.modal');
    // No type of its own to show: the placeholder, nothing chosen
    await expect(modal.getByRole('combobox')).toHaveValue('');
    await expect(modal.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    await modal.getByRole('button', { name: 'Move to trash' }).click();
    await modal.getByRole('button', { name: 'Confirm' }).click();

    await expect(modal).toBeHidden();
    await expect(leftoverButton()).toHaveCount(0);
    expect(await itemFiles(window)).toEqual([]);
  });

  test('previews a note in the modal when its name is clicked, one at a time, changing nothing', async () => {
    const first = `${DATA_DIRECTORY}/First.md`;
    const second = `${DATA_DIRECTORY}/Second.md`;
    await seedItem();
    await writeNote(
      first,
      { 'ir-id': 'left-4' },
      '# Greeting\n\nThe first note says **hello**.'
    );
    await writeNote(second, { 'ir-id': 'left-5' }, 'The second says goodbye.');
    await start();
    await leftoversFound(2);

    await openReview();
    await leftoverButton().click();
    const modal = window.locator('.modal');
    // Rendered, not shown as written: a heading, and no `#` or `**` left
    const firstBody = modal.getByRole('heading', { name: 'Greeting' });
    const secondBody = modal.getByText('The second says goodbye.');
    await expect(firstBody).toHaveCount(0);
    await modal.getByRole('button', { name: 'Preview First' }).click();

    await expect(firstBody).toBeVisible();
    await expect(modal.locator('strong', { hasText: 'hello' })).toBeVisible();
    await expect(modal.getByText('**hello**')).toHaveCount(0);
    // Its frontmatter left out
    await expect(modal.getByText('left-4')).toHaveCount(0);
    await modal.getByRole('button', { name: 'Preview Second' }).click();

    await expect(secondBody).toBeVisible();
    await expect(firstBody).toHaveCount(0);
    await modal.getByRole('button', { name: 'Cancel' }).click();

    await expect(modal).toBeHidden();
    await expect(leftoverButton()).toBeVisible();
    expect(await itemFiles(window)).toEqual([first, second]);
  });

  test("takes the plugin's id and tag off a note being imported in place when asked, leaving the rest", async () => {
    const path = 'sources/Imported.md';
    await seedItem();
    await writeNote(path, {
      'ir-id': 'left-2',
      tags: ['mine', ARTICLE_TAG],
      title: 'kept',
    });
    await start();
    await leftoversFound(1);

    await openReview();
    await leftoverNotice().getByText('Manage', { exact: true }).click();
    await expect(
      window.getByRole('button', { name: 'Move to trash' })
    ).toHaveCount(0);
    await window.getByRole('button', { name: 'Remove IR properties' }).click();
    await window.getByRole('button', { name: 'Confirm' }).click();

    await expect
      .poll(() =>
        window.evaluate(
          (path) =>
            (window as unknown as PageWindow).app.metadataCache.getCache(path)
              ?.frontmatter ?? null,
          path
        )
      )
      .toEqual({ tags: ['mine'], title: 'kept' });
    // The seeded one alone
    expect(await rowCount(window, 'article')).toBe(1);
    expect(await itemFiles(window)).toEqual([]);
  });
});
