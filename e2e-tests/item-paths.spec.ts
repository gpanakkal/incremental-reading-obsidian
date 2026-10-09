import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  askBeforeUpdatingLinks,
  executeCommandById,
  importArticle,
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

/**
 * Characters that end a link's path early, as each file system can hold them:
 * Windows refuses `|` and `>` in a name, but takes `#` and `^`, which the
 * plugin refuses too.
 */
const WINDOWS = process.platform === 'win32';
const FILE_CHAR = WINDOWS ? '#' : '|';
const FOLDER_CHAR = WINDOWS ? '^' : '>';

const SOURCE = 'sources/Security Principles.md';
const PARAGRAPH =
  'Before we start discussing the different security principles';

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('item-paths');
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

/** The page's `app`, as far as these tests reach into it. */
type TestApp = {
  vault: {
    getFileByPath(path: string): { path: string } | null;
    getAbstractFileByPath(path: string): { path: string } | null;
    create(path: string, data: string): Promise<{ path: string }>;
    createFolder(path: string): Promise<unknown>;
    rename(file: unknown, path: string): Promise<void>;
  };
  fileManager: { renameFile(file: unknown, path: string): Promise<void> };
  metadataCache: {
    getFileCache(file: unknown): { frontmatter?: Record<string, unknown> };
    getFirstLinkpathDest(link: string, from: string): { path: string } | null;
  };
  plugins: {
    plugins: Record<
      string,
      {
        importArticle(
          file: unknown,
          opts: { copyOnImport: boolean; showImportDialog: boolean }
        ): Promise<void>;
        reviewManager: {
          repo: { query(sql: string): Record<string, unknown>[] };
        };
      }
    >;
  };
};

/** Every item row, with where its note's `source` link leads. */
const itemRows = (page: Page) =>
  page.evaluate(() => {
    const { app } = window as unknown as { app: TestApp };
    const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
    return repo
      .query(
        `SELECT 'article' AS kind, reference FROM article
         UNION ALL SELECT 'snippet', reference FROM snippet
         ORDER BY kind`
      )
      .map(({ kind, reference }) => {
        const file = app.vault.getFileByPath(String(reference));
        const source = file
          ? app.metadataCache.getFileCache(file)?.frontmatter?.source
          : undefined;
        const link =
          typeof source === 'string' ? /\[\[([^\]|#]*)/.exec(source)?.[1] : '';
        return {
          kind,
          reference,
          exists: file !== null,
          source,
          leadsTo:
            link === undefined || link === ''
              ? null
              : (app.metadataCache.getFirstLinkpathDest(link, String(reference))
                  ?.path ?? null),
        };
      });
  });

/** Rename what is at `from` to `to` as the file explorer does. */
const rename = (page: Page, from: string, to: string) =>
  page.evaluate(
    async ([from, to]) => {
      const { app } = window as unknown as { app: TestApp };
      await app.fileManager.renameFile(
        app.vault.getAbstractFileByPath(from),
        to
      );
    },
    [from, to] as const
  );

/**
 * Rename what is at `from` to `to` as a sync client does, behind Obsidian's
 * link updates: `Vault.rename` updates no links.
 */
const syncRename = (page: Page, from: string, to: string) =>
  page.evaluate(
    async ([from, to]) => {
      const { app } = window as unknown as { app: TestApp };
      await app.vault.rename(app.vault.getAbstractFileByPath(from), to);
    },
    [from, to] as const
  );

const exists = (page: Page, at: string) =>
  page.evaluate(
    (at) =>
      (window as unknown as { app: TestApp }).app.vault.getAbstractFileByPath(
        at
      ) !== null,
    at
  );

/** Import the source note in place and take a snippet from it. */
async function importWithSnippet(page: Page) {
  await importArticle(page, 'sources/Security Principles');
  await openNote(page, 'sources/Security Principles');
  await selectParagraph(page, PARAGRAPH);
  await executeCommandById(page, 'incremental-reading:extract-selection');
  await expect
    .poll(async () => (await itemRows(page)).map(({ kind }) => kind))
    .toEqual(['article', 'snippet']);
  const rows = await itemRows(page);
  expect(rows[1].leadsTo).toBe(SOURCE);
  return rows;
}

/**
 * Item notes at `paths`, imported where they are, and Obsidian's
 * link-update queue held by a rename waiting on its prompt, so that the
 * undo of a rename made meanwhile waits too, as in a sync burst.
 * @returns what answers the prompt, letting the queue go on
 */
async function holdQueueOver(page: Page, paths: readonly string[]) {
  await page.evaluate(async (paths) => {
    const { app } = window as unknown as { app: TestApp };
    await app.vault.createFolder('A');
    await app.vault.createFolder('hold');
    for (const path of paths) {
      const file = await app.vault.create(path, '# Note\n');
      await app.plugins.plugins['incremental-reading'].importArticle(file, {
        copyOnImport: false,
        showImportDialog: false,
      });
    }
    await app.vault.create('hold/target.md', '# Target\n');
    await app.vault.create('hold/linker.md', '[[target]]\n');
  }, paths);
  await expect
    .poll(async () => (await itemRows(page)).length)
    .toBe(paths.length);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { app: TestApp }
          ).app.metadataCache.getFirstLinkpathDest('target', 'hold/linker.md')
            ?.path
      )
    )
    .toBe('hold/target.md');
  await askBeforeUpdatingLinks(page);
  // Not awaited: it settles only once the prompt is answered
  void page.evaluate(() => {
    const { app } = window as unknown as { app: TestApp };
    void app.fileManager.renameFile(
      app.vault.getAbstractFileByPath('hold/target.md'),
      'hold/target 2.md'
    );
  });
  const prompt = page
    .locator('.modal-container')
    .getByRole('button', { name: 'Do not update' });
  await expect(prompt).toBeVisible();
  return () => prompt.click();
}

test.describe('Item paths that would break links', () => {
  test("puts back an article renamed to a name that breaks links, and its snippet's link to it still leads there", async () => {
    const before = await importWithSnippet(window);
    const notices = await watchNotices(window);
    const bad = `sources/Security ${FILE_CHAR} Principles.md`;

    await rename(window, SOURCE, bad);

    await expect
      .poll(() => notices())
      .toContainEqual(
        `Incremental reading: IR files and their folders cannot contain ${FILE_CHAR}`
      );
    expect(await exists(window, SOURCE)).toBe(true);
    expect(await exists(window, bad)).toBe(false);
    // Neither the rename nor its undo was followed, and Obsidian rewrote no
    // link: the undo ran inside the rename's own link update
    expect(await itemRows(window)).toEqual(before);
    expect(await notices()).not.toContainEqual(
      expect.stringContaining('Updated')
    );
  });

  test('puts back a folder holding an article renamed to a name that breaks links', async () => {
    const before = await importWithSnippet(window);
    const notices = await watchNotices(window);

    await rename(window, 'sources', `sour${FOLDER_CHAR}ces`);

    await expect
      .poll(() => notices())
      .toContainEqual(
        `Incremental reading: folders with items cannot contain ${FOLDER_CHAR}`
      );
    expect(await exists(window, SOURCE)).toBe(true);
    expect(await exists(window, `sour${FOLDER_CHAR}ces`)).toBe(false);
    expect(await itemRows(window)).toEqual(before);
    expect(await notices()).not.toContainEqual(
      expect.stringContaining('Updated')
    );
  });

  test('puts the same rename back only once, so a sync client pushing it again cannot loop', async () => {
    await importWithSnippet(window);
    const notices = await watchNotices(window);
    const bad = `sources/Security ${FILE_CHAR} Principles.md`;

    await syncRename(window, SOURCE, bad);
    await expect.poll(() => exists(window, SOURCE)).toBe(true);
    await expect.poll(() => notices()).toHaveLength(1);
    await syncRename(window, SOURCE, bad);

    // Followed as any rename is
    await expect
      .poll(async () => (await itemRows(window))[0])
      .toMatchObject({ kind: 'article', reference: bad, exists: true });
    expect(await notices()).toEqual([
      expect.stringContaining('cannot contain'),
      expect.stringContaining(
        `"${bad}" was already moved back once, so it stays`
      ),
    ]);
    expect(await exists(window, SOURCE)).toBe(false);
  });

  test('refuses to import in place a note whose folder breaks links', async () => {
    const notices = await watchNotices(window);
    const folder = `x${FOLDER_CHAR}y`;

    await window.evaluate(async (folder) => {
      const { app } = window as unknown as { app: TestApp };
      await app.vault.createFolder(folder);
      const file = await app.vault.create(`${folder}/Note.md`, '# Note\n');
      await app.plugins.plugins['incremental-reading'].importArticle(file, {
        copyOnImport: false,
        showImportDialog: false,
      });
    }, folder);

    await expect
      .poll(() => notices())
      .toContainEqual(
        expect.stringContaining(`Can't import "Note.md" in place`)
      );
    expect(await itemRows(window)).toEqual([]);
  });

  test('warns at startup of an item whose path came to break links while Obsidian was closed', async () => {
    await importArticle(window, 'sources/Security Principles');
    await expect.poll(async () => (await itemRows(window)).length).toBe(1);
    await expect.poll(() => pendingSaves(window)).toBe(0);
    await closeElectron(app);

    const bad = `sources/Security ${FILE_CHAR} Principles.md`;
    await fs.rename(path.join(vaultPath, SOURCE), path.join(vaultPath, bad));
    app = await launchElectron(vaultPath);
    window = await openVault(app, vaultPath);

    await expect(
      window.locator('.notice', { hasText: 'cannot contain any of these' })
    ).toContainText(`Rename "${bad}"`);
    // A path that already breaks links is reported, never moved
    expect(await itemRows(window)).toMatchObject([
      { kind: 'article', reference: bad, exists: true },
    ]);
  });

  test.describe('while a file in it waits to be put back', () => {
    for (const [kind, paths] of [
      ['its only item', ['A/x.md']],
      ['other items too', ['A/x.md', 'A/y.md']],
    ] as const) {
      test(`puts back a folder renamed while a file in it, ${kind}, waits to be put back itself, then the file, in one notice`, async () => {
        const release = await holdQueueOver(window, paths);
        const notices = await watchNotices(window);

        await syncRename(window, 'A/x.md', `A/x${FILE_CHAR}.md`);
        await syncRename(window, 'A', `A${FOLDER_CHAR}`);
        await release();

        await expect
          .poll(() => notices())
          .toContainEqual(
            `Incremental reading: IR files and their folders cannot contain ` +
              `${FOLDER_CHAR} or ${FILE_CHAR}`
          );
        for (const path of paths) expect(await exists(window, path)).toBe(true);
        expect(await exists(window, `A${FOLDER_CHAR}`)).toBe(false);
        expect(
          (await itemRows(window)).map(({ reference }) => reference).sort()
        ).toEqual([...paths].sort());
        expect(
          (await notices()).filter((notice) =>
            notice.includes('cannot contain')
          )
        ).toHaveLength(1);
      });
    }
  });
});
