import { ARTICLE_TAG, AUTO_IMPORT_TAG } from '#/lib/constants';
import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  executeCommandById,
  openNote,
  openPluginSettings,
  setDefaultEditingMode,
  setPluginSetting,
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
 * What the page-side calls below reach on Obsidian and the plugin.
 * Unofficial: `window.app`, `app.plugins.plugins` and `app.setting`; the
 * plugin's `autoImportWatcher` is private to it.
 */
type PageApp = {
  vault: { getFileByPath(path: string): unknown };
  fileManager: {
    processFrontMatter(
      file: unknown,
      fn: (frontmatter: Record<string, unknown>) => void
    ): Promise<void>;
  };
  metadataCache: {
    getFileCache(file: unknown): {
      frontmatter?: Record<string, unknown>;
      headings?: { heading: string }[];
    } | null;
  };
  workspace: {
    activeEditor: {
      editor: {
        setSelection(pos: unknown): void;
        offsetToPos(offset: number): unknown;
        focus(): void;
      };
    };
  };
  setting: { close(): void };
  plugins: {
    plugins: Record<
      string,
      {
        reviewManager: {
          repo: {
            query(
              sql: string,
              params?: unknown[]
            ): Record<string, unknown>[] | Promise<Record<string, unknown>[]>;
            mutate(sql: string, params?: unknown[]): unknown;
          };
        };
        autoImportWatcher: { flushNow(): Promise<void> };
      }
    >;
  };
};

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('auto-import');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
  if (shouldCleanup) {
    // Best-effort, as in core.spec.ts: a surviving child can hold a handle
    await fs
      .rm(vaultPath, { recursive: true, force: true, maxRetries: 3 })
      .catch(() => {});
  }
});

// #region HELPERS

/** Write `content` to `at` in the vault from outside Obsidian, as a script would. */
async function writeVaultFile(at: string, content: string) {
  await fs.mkdir(path.dirname(path.join(vaultPath, at)), { recursive: true });
  await fs.writeFile(path.join(vaultPath, at), content);
}

/**
 * What the app knows of the note at `notePath`: its `ir-id` and tags as the
 * metadata cache has them, the headings in it, and the ids of the articles
 * whose rows point at it.
 */
const noteState = (notePath: string) =>
  window.evaluate(async (at) => {
    const { app } = window as unknown as { app: PageApp };
    const file = app.vault.getFileByPath(at);
    const cache = file ? app.metadataCache.getFileCache(file) : null;
    const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
    const rows = await repo.query(
      'SELECT id FROM article WHERE reference = $1',
      [at]
    );
    return {
      irId: (cache?.frontmatter?.['ir-id'] as string | undefined) ?? null,
      tags: (cache?.frontmatter?.tags as string[] | undefined) ?? [],
      headings: cache?.headings?.map(({ heading }) => heading) ?? [],
      rowIds: rows.map((row) => row.id as string),
    };
  }, notePath);

/** How many articles the database holds. */
const articleCount = () =>
  window.evaluate(async () => {
    const { app } = window as unknown as { app: PageApp };
    const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
    const [row] = await repo.query('SELECT COUNT(*) AS count FROM article');
    return row.count as number;
  });

/**
 * Import whatever the watcher has queued now, rather than once it settles, and
 * wait for it: nothing queued means nothing is imported.
 */
const flushAutoImports = () =>
  window.evaluate(async () => {
    const { app } = window as unknown as { app: PageApp };
    await app.plugins.plugins[
      'incremental-reading'
    ].autoImportWatcher.flushNow();
  });

/** Wait for the note at `notePath` to be an article, and return its id. */
async function expectImported(notePath: string): Promise<string> {
  await expect
    .poll(async () => {
      const { irId, tags, rowIds } = await noteState(notePath);
      return irId !== null && tags.includes(ARTICLE_TAG) && rowIds[0] === irId
        ? rowIds
        : null;
    })
    .toHaveLength(1);
  return (await noteState(notePath)).irId!;
}

// #endregion

test('imports a note written into the vault with a trigger tag, once, however often it changes after', async () => {
  const notices = await watchNotices(window);
  const settings = await openPluginSettings(app, window);
  const toggle = settings
    .locator('.vertical-tab-content .setting-item')
    .filter({
      has: settings
        .locator('.setting-item-name')
        .getByText('Auto-import notes by tag', { exact: true }),
    })
    .locator('.checkbox-container');
  await toggle.click();
  await expect(toggle).toHaveClass(/is-enabled/);
  await window.evaluate(() =>
    (window as unknown as { app: PageApp }).app.setting.close()
  );
  const before = await articleCount();
  const notePath = 'inbox/Clipped article.md';

  await writeVaultFile(
    notePath,
    `---\ntags: [${AUTO_IMPORT_TAG}]\n---\nA clipped page.\n`
  );

  const id = await expectImported(notePath);
  expect(await articleCount()).toBe(before + 1);

  // Changed again from outside, once Obsidian has written the import back
  const written = await fs.readFile(path.join(vaultPath, notePath), 'utf8');
  await writeVaultFile(notePath, `${written}\n## Edited later\n`);
  await expect
    .poll(async () => (await noteState(notePath)).headings)
    .toContain('Edited later');
  // Whatever that change queued is imported now, not when it would settle
  await flushAutoImports();

  expect(await noteState(notePath)).toMatchObject({ irId: id, rowIds: [id] });
  expect(await articleCount()).toBe(before + 1);
  expect((await notices()).filter((text) => text.includes('Imported'))).toEqual(
    ['Imported 1 article']
  );
});

test('imports a note when its trigger tag is typed into its frontmatter', async () => {
  await setPluginSetting(window, 'autoImportOnTag', true);
  await setDefaultEditingMode(window, 'source');
  const notePath = 'sources/Security Principles.md';
  await openNote(window, notePath);
  expect((await noteState(notePath)).rowIds).toEqual([]);

  await window.evaluate(() => {
    const { editor } = (window as unknown as { app: PageApp }).app.workspace
      .activeEditor;
    editor.setSelection(editor.offsetToPos(0));
    editor.focus();
  });
  await window.keyboard.type(`---\ntags: ${AUTO_IMPORT_TAG}\n---\n`);

  await expectImported(notePath);
});

test('shows the action bar on a note open in reading mode once a trigger tag set on it imports it', async () => {
  await setPluginSetting(window, 'autoImportOnTag', true);
  const notePath = 'sources/Security Principles.md';
  await openNote(window, notePath);
  await executeCommandById(window, 'markdown:toggle-preview');
  const leaf = window.locator('.workspace-leaf.mod-active');
  await expect(leaf.locator('.markdown-reading-view')).toBeVisible();
  const bar = leaf.locator('.ir-reading-mode-bar');
  await expect(bar).toHaveCount(0);

  // As the properties widget does in reading mode: written to the file at once
  await window.evaluate(
    async ({ at, tag }) => {
      const { app } = window as unknown as { app: PageApp };
      await app.fileManager.processFrontMatter(
        app.vault.getFileByPath(at),
        (frontmatter) => {
          frontmatter.tags = [tag];
        }
      );
    },
    { at: notePath, tag: AUTO_IMPORT_TAG }
  );

  // Nothing else happens in the workspace, so only the import itself can bring
  // the bar, and it should take about a second, not the "few seconds" an
  // unrelated workspace event used to
  await expect(bar).toBeVisible({ timeout: 5_000 });
  await expectImported(notePath);
});

test('imports a note again by its trigger tag once the database has lost its row', async () => {
  await setPluginSetting(window, 'autoImportOnTag', true);
  const notePath = 'inbox/Read before the reset.md';
  await writeVaultFile(
    notePath,
    `---
tags: [${AUTO_IMPORT_TAG}]
---
A page read before the reset.
`
  );
  const id = await expectImported(notePath);
  const before = await articleCount();

  // As deleting the data folder does: the note keeps its ir-id, with no row
  // behind it
  await window.evaluate(async (articleId) => {
    const { repo } = (window as unknown as { app: PageApp }).app.plugins
      .plugins['incremental-reading'].reviewManager;
    await repo.mutate('DELETE FROM article_review WHERE article_id = $1', [
      articleId,
    ]);
    await repo.mutate('DELETE FROM article WHERE id = $1', [articleId]);
  }, id);
  expect(await noteState(notePath)).toMatchObject({ irId: id, rowIds: [] });

  // Any later change, the trigger tag kept
  await window.evaluate(async (at) => {
    const { app } = window as unknown as { app: PageApp };
    await app.fileManager.processFrontMatter(
      app.vault.getFileByPath(at),
      (frontmatter) => {
        frontmatter.read = true;
      }
    );
  }, notePath);

  await expectImported(notePath);
  expect(await articleCount()).toBe(before);
});
