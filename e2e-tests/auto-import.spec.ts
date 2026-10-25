import {
  ARTICLE_DIRECTORY,
  ARTICLE_TAG,
  AUTO_IMPORT_TAG,
  DATA_DIRECTORY,
} from '#/lib/constants';
import { deleteRowStatements, NOT_PURGED } from '#/lib/items/row-delete';
import { WATCHED_FOLDER_LEDGER_KEY } from '#/lib/watched-folder-ledger';
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
  pendingSaves,
  setDefaultEditingMode,
  setPluginSetting,
  setToggle,
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
  loadLocalStorage(key: string): unknown;
  vault: {
    getFileByPath(path: string): unknown;
    getFiles(): { path: string }[];
    createFolder(path: string): Promise<unknown>;
    create(path: string, data: string): Promise<unknown>;
    createBinary(path: string, data: ArrayBuffer): Promise<unknown>;
    readBinary(file: unknown): Promise<ArrayBuffer>;
    /** Unofficial: sets one of the vault's own config keys. */
    setConfig(key: string, value: unknown): void;
  };
  fileManager: {
    renameFile(file: unknown, newPath: string): Promise<void>;
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
            db: { exec(sql: string): unknown };
          };
        };
        autoImportWatcher: { flushNow(): Promise<void> };
        saveSettings(): Promise<void>;
      }
    >;
    disablePlugin(id: string): Promise<void>;
    enablePlugin(id: string): Promise<boolean>;
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

/** How many articles the database holds, not counting those deleted for good. */
const articleCount = () =>
  window.evaluate(async (notPurged) => {
    const { app } = window as unknown as { app: PageApp };
    const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
    const [row] = await repo.query(
      `SELECT COUNT(*) AS count FROM article WHERE ${notPurged}`
    );
    return row.count as number;
  }, NOT_PURGED);

/**
 * The paths the database's articles point at, sorted, not counting those
 * deleted for good: a count that comes out wrong names no culprit.
 */
const articleReferences = () =>
  window.evaluate(async (notPurged) => {
    const { app } = window as unknown as { app: PageApp };
    const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
    const rows = await repo.query(
      `SELECT reference FROM article WHERE ${notPurged}`
    );
    return rows.map((row) => row.reference as string).sort();
  }, NOT_PURGED);

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

/** The paths of the files in the articles folder, sorted. */
const articleFiles = () =>
  window.evaluate((folder) => {
    const { app } = window as unknown as { app: PageApp };
    return app.vault
      .getFiles()
      .map((file) => file.path)
      .filter((at) => at.startsWith(`${folder}/`))
      .sort();
  }, `${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}`);
/** The ids of the articles whose rows point at `reference`. */
const rowIdsAt = (reference: string) =>
  window.evaluate(async (at) => {
    const { repo } = (window as unknown as { app: PageApp }).app.plugins
      .plugins['incremental-reading'].reviewManager;
    const rows = await repo.query(
      'SELECT id FROM article WHERE reference = $1',
      [at]
    );
    return rows.map((row) => row.id as string);
  }, reference);

/** Set the frontmatter key `key` of the note at `notePath` to `value`. */
const setFrontmatter = (notePath: string, key: string, value: unknown) =>
  window.evaluate(
    async ({ at, name, to }) => {
      const { app } = window as unknown as { app: PageApp };
      await app.fileManager.processFrontMatter(
        app.vault.getFileByPath(at),
        (frontmatter) => {
          if (to === undefined) delete frontmatter[name];
          else frontmatter[name] = to;
        }
      );
    },
    { at: notePath, name: key, to: value }
  );

/**
 * Remove the article row `id` with its history outright, leaving no tombstone,
 * as a database that never had it would be. The plugin refuses `DELETE`s of
 * synced rows with temporary triggers (see `armRowStamps` in
 * `src/lib/repository/row-stamps.ts`), so they are dropped first, as
 * `withHardDeletesAllowed` does; the repository arms them again on its next
 * save.
 */
const loseArticleRow = (articleId: string) =>
  window.evaluate(async (id) => {
    const { repo } = (window as unknown as { app: PageApp }).app.plugins
      .plugins['incremental-reading'].reviewManager;
    const hardDelete = async (sql: string) => {
      const triggers = (await repo.query(
        `SELECT name FROM sqlite_temp_master
         WHERE type = 'trigger' AND tbl_name IN ('article', 'article_review')`
      )) as { name: string }[];
      for (const { name } of triggers) {
        repo.db.exec(`DROP TRIGGER temp.${name}`);
      }
      await repo.mutate(sql, [id]);
    };
    await hardDelete('DELETE FROM article_review WHERE article_id = $1');
    await hardDelete('DELETE FROM article WHERE id = $1');
  }, articleId);

/** Delete the article row `id` for good, with the writes un-importing runs. */
const unimportArticleRow = (articleId: string) =>
  window.evaluate(
    async (statements) => {
      const { repo } = (window as unknown as { app: PageApp }).app.plugins
        .plugins['incremental-reading'].reviewManager;
      for (const { query, params } of statements) {
        await repo.mutate(query, params);
      }
    },
    deleteRowStatements('article', articleId)
  );

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
  await setToggle(toggle, true);
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
  expect(
    (await notices()).filter((text) => /\b\d+ articles?\b/.test(text))
  ).toEqual([expect.stringMatching(/\b1 article\b/)]);
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
  await loseArticleRow(id);
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

test('imports the notes tagged while Obsidian was closed when it next starts, once, but none tagged before importing by tag was on', async () => {
  const saveSettings = () =>
    window.evaluate(() =>
      (window as unknown as { app: PageApp }).app.plugins.plugins[
        'incremental-reading'
      ].saveSettings()
    );
  // On from the first launch, so off while the first note is tagged
  await setPluginSetting(window, 'autoImportOnTag', false);
  await saveSettings();
  const taggedBefore = 'inbox/Tagged before.md';
  await writeVaultFile(
    taggedBefore,
    `---\ntags: [${AUTO_IMPORT_TAG}]\n---\nTagged before importing by tag was on.\n`
  );
  await expect
    .poll(async () => (await noteState(taggedBefore)).tags)
    .toContain(AUTO_IMPORT_TAG);
  await setPluginSetting(window, 'autoImportOnTag', true);
  await saveSettings();
  const before = await articleCount();
  const tagged = ['inbox/First.md', 'inbox/Second.md', 'notes/Third.md'];
  /** Close Obsidian, tag `notePaths` from outside it, and start it again. */
  const tagWhileClosed = async (notePaths: string[]) => {
    await expect.poll(() => pendingSaves(window)).toBe(0);
    await closeElectron(app);
    for (const notePath of notePaths) {
      await writeVaultFile(
        notePath,
        `---\ntags: [${AUTO_IMPORT_TAG}]\n---\nTagged while Obsidian was closed.\n`
      );
    }
    app = await launchElectron(vaultPath);
    window = await openVault(app, vaultPath);
  };
  const importNotices = () =>
    window.locator('.notice', { hasText: /\b\d+ articles?\b/ });

  await tagWhileClosed(tagged);

  await expect(importNotices()).toHaveText([/\b3 articles\b/]);
  const ids = [];
  for (const notePath of tagged) ids.push(await expectImported(notePath));
  expect(await articleCount()).toBe(before + 3);
  expect(await noteState(taggedBefore)).toMatchObject({
    irId: null,
    rowIds: [],
  });

  // Started twice more, each time with one more note tagged while closed, so
  // there is a sign that the look at the vault is over
  for (const [i, witness] of ['inbox/Fourth.md', 'inbox/Fifth.md'].entries()) {
    await tagWhileClosed([witness]);

    await expect(importNotices()).toHaveText([/\b1 article\b/]);
    await expectImported(witness);
    expect(await articleCount()).toBe(before + 4 + i);
    for (const [j, notePath] of tagged.entries()) {
      expect(await noteState(notePath)).toMatchObject({
        irId: ids[j],
        rowIds: [ids[j]],
      });
    }
    expect(await noteState(taggedBefore)).toMatchObject({
      irId: null,
      rowIds: [],
    });
  }
});

test('imports what is created in, moved into or copied into a watched folder, and nothing that was there before or was un-imported', async () => {
  // A folder made while Obsidian runs, holding a note from before it is watched
  await window.evaluate(async () => {
    const { app } = window as unknown as { app: PageApp };
    await app.vault.createFolder('Inbox');
    await app.vault.create('Inbox/Here before.md', 'Here before watching.\n');
  });
  await setPluginSetting(window, 'autoImportOnFolder', true);
  await setPluginSetting(window, 'autoImportFolders', ['Inbox']);
  const before = await articleCount();

  // A new note made where new notes go, here the inbox, and typed into
  await window.evaluate(() => {
    const { vault } = (window as unknown as { app: PageApp }).app;
    vault.setConfig('newFileLocation', 'folder');
    vault.setConfig('newFileFolderPath', 'Inbox');
  });
  await executeCommandById(window, 'file-explorer:new-file');
  const created = 'Inbox/Untitled.md';
  const body = window.locator('.workspace-leaf.mod-active .cm-content');
  await body.click();
  await window.keyboard.type('Typed into a new note.');
  // Typed before the import lands, so the import is what could lose it: an
  // empty note open in the editor takes the file's text over unsaved typing
  expect((await noteState(created)).irId).toBeNull();
  await expectImported(created);
  await expect(body).toContainText('Typed into a new note.');

  // Moved in from elsewhere in the vault
  const moved = 'Inbox/Security Principles.md';
  await window.evaluate(async (to) => {
    const { app } = window as unknown as { app: PageApp };
    await app.fileManager.renameFile(
      app.vault.getFileByPath('sources/Security Principles.md'),
      to
    );
  }, moved);
  await expectImported(moved);

  // A PDF copied in
  const pdf = 'Inbox/Paper.pdf';
  await window.evaluate(async (to) => {
    const { vault } = (window as unknown as { app: PageApp }).app;
    const data = await vault.readBinary(
      vault.getFileByPath('testing/PDF fixture.pdf')
    );
    await vault.createBinary(to, data);
  }, pdf);
  await expect.poll(() => rowIdsAt(pdf)).toHaveLength(1);

  // As un-importing does: the row deleted, the plugin's frontmatter stripped
  const id = (await noteState(moved)).irId!;
  await unimportArticleRow(id);
  await setFrontmatter(moved, 'ir-id', undefined);
  await setFrontmatter(moved, 'tags', undefined);
  // Edited after, as is the note that was there before watching began
  await setFrontmatter(moved, 'read', true);
  await setFrontmatter('Inbox/Here before.md', 'read', true);
  await expect.poll(async () => (await noteState(moved)).irId).toBeNull();
  await flushAutoImports();

  expect(await noteState(moved)).toMatchObject({ irId: null, rowIds: [] });
  expect(await noteState('Inbox/Here before.md')).toMatchObject({
    irId: null,
    rowIds: [],
  });
  expect(await articleCount()).toBe(before + 2);
});

test('imports what was added to a watched folder while Obsidian was closed when it next starts, once, but not what was there before or was un-imported', async () => {
  const folder = 'Clippings';
  const hereBefore = `${folder}/Here before.md`;
  await writeVaultFile(hereBefore, 'Here before watching.\n');
  // Written from outside, so in the vault only once Obsidian's file watcher
  // tells of it, which can take longer than the settings below take to
  // change (macOS): it would arrive after watching began, and be imported
  await expect
    .poll(() =>
      window.evaluate(
        (at) =>
          (window as unknown as { app: PageApp }).app.vault.getFileByPath(
            at
          ) !== null,
        hereBefore
      )
    )
    .toBe(true);
  expect((await noteState(hereBefore)).rowIds).toEqual([]);
  await setPluginSetting(window, 'autoImportOnFolder', true);
  await setPluginSetting(window, 'autoImportFolders', [folder]);
  // Saving tells the watcher, as the settings tab does
  await window.evaluate(() =>
    (window as unknown as { app: PageApp }).app.plugins.plugins[
      'incremental-reading'
    ].saveSettings()
  );
  // What the folder holds now is seen, by the startup look or the save
  await expect
    .poll(() =>
      window.evaluate(
        (key) =>
          (window as unknown as { app: PageApp }).app.loadLocalStorage(key),
        WATCHED_FOLDER_LEDGER_KEY
      )
    )
    .toEqual({ folders: [folder], paths: [hereBefore] });
  const before = await articleReferences();
  /** Close Obsidian, run `whileClosed` from outside it, and start it again. */
  const restart = async (whileClosed: () => Promise<void>) => {
    await expect.poll(() => pendingSaves(window)).toBe(0);
    await closeElectron(app);
    await whileClosed();
    app = await launchElectron(vaultPath);
    window = await openVault(app, vaultPath);
  };
  /** Write a note into the watched folder, as Web Clipper or a script would. */
  const clip = (name: string) =>
    writeVaultFile(`${folder}/${name}.md`, `Clipped while closed: ${name}.\n`);
  const importNotices = () =>
    window.locator('.notice', { hasText: /\b\d+ articles?\b/ });

  const notes = [`${folder}/First.md`, `${folder}/Second.md`];
  const pdf = `${folder}/Paper.pdf`;
  await restart(async () => {
    await clip('First');
    await clip('Second');
    await fs.copyFile(
      path.join(vaultPath, 'testing/PDF fixture.pdf'),
      path.join(vaultPath, pdf)
    );
  });

  await expect(importNotices()).toHaveText([/\b3 articles\b/]);
  const ids = [];
  for (const notePath of notes) ids.push(await expectImported(notePath));
  await expect.poll(() => rowIdsAt(pdf)).toHaveLength(1);
  expect(await articleReferences()).toEqual([...before, ...notes, pdf].sort());
  expect(await noteState(hereBefore)).toMatchObject({
    irId: null,
    rowIds: [],
  });

  // Started again with one more note added while closed, so there is a sign
  // that the look at the folder is over. Nothing marks the PDF, so only the
  // record of what was seen keeps it from being imported again at every launch
  const third = `${folder}/Third.md`;
  await restart(() => clip('Third'));

  await expect(importNotices()).toHaveText([/\b1 article\b/]);
  const thirdId = await expectImported(third);
  expect(await articleReferences()).toEqual(
    [...before, ...notes, pdf, third].sort()
  );

  // As un-importing does: the row deleted, the plugin's frontmatter stripped
  const [unimported] = notes;
  await unimportArticleRow(ids[0]);
  await setFrontmatter(unimported, 'ir-id', undefined);
  await setFrontmatter(unimported, 'tags', undefined);
  await expect.poll(async () => (await noteState(unimported)).irId).toBeNull();
  await restart(() => clip('Fourth'));

  await expect(importNotices()).toHaveText([/\b1 article\b/]);
  await expectImported(`${folder}/Fourth.md`);
  expect(await articleReferences()).toEqual(
    [...before, notes[1], pdf, third, `${folder}/Fourth.md`].sort()
  );
  expect(await noteState(third)).toMatchObject({
    irId: thirdId,
    rowIds: [thirdId],
  });
  expect(await noteState(unimported)).toMatchObject({
    irId: null,
    rowIds: [],
  });
  expect(await noteState(notes[1])).toMatchObject({
    irId: ids[1],
    rowIds: [ids[1]],
  });
  expect(await rowIdsAt(pdf)).toHaveLength(1);
  expect(await noteState(hereBefore)).toMatchObject({
    irId: null,
    rowIds: [],
  });
});

test('adds a watched folder on Enter as a chip under the field, refuses one that is missing, and removes it by its button', async () => {
  await window.evaluate(async () => {
    const { app } = window as unknown as { app: PageApp };
    await app.vault.createFolder('Inbox');
  });
  const settings = await openPluginSettings(app, window);
  const settingRow = (name: string) =>
    settings.locator('.vertical-tab-content .setting-item').filter({
      has: settings
        .locator('.setting-item-name')
        .getByText(name, { exact: true }),
    });
  const toggle = settingRow('Auto-import files added to folders').locator(
    '.checkbox-container'
  );
  const row = settingRow('Watched folders');
  const field = row.getByRole('textbox');
  const message = row.locator('.setting-item-error');
  const chips = row.locator('.ir-folder-chip');

  // Watching with no folders says so
  await toggle.click();
  await expect(toggle).toHaveClass(/is-enabled/);
  await expect(message).toBeVisible();

  await field.fill('Not here');
  await field.press('Enter');
  await expect(field).toHaveValue('Not here');
  await expect(message).toContainText('Not here');
  await expect(chips).toHaveCount(0);

  await field.fill('/Inbox/');
  await field.press('Enter');
  await expect(field).toHaveValue('');
  await expect(chips).toHaveText(['Inbox']);
  await expect(message).toBeHidden();

  await chips.getByRole('button', { name: /Inbox/ }).click();
  await expect(chips).toHaveCount(0);
  await expect(message).toBeVisible();

  // Turning watching off leaves an empty list nothing to say
  await toggle.click();
  await expect(toggle).not.toHaveClass(/is-enabled/);
  await expect(message).toBeHidden();
});

test("suggests the vault's tags in the trigger tags field, but the plugin's item-type tags, and a pick joins the list", async () => {
  // Body tags: frontmatter ones would make the note an item
  await writeVaultFile('inbox/Tagged.md', 'Text #e2e-suggest #ir-card/e2e\n');
  // The metadata cache catches up on its own time (`getTags` is undocumented)
  await expect
    .poll(() =>
      window.evaluate(
        () =>
          (
            window as unknown as {
              app: { metadataCache: { getTags(): Record<string, number> } };
            }
          ).app.metadataCache.getTags()['#e2e-suggest'] ?? 0
      )
    )
    .toBe(1);
  const settings = await openPluginSettings(app, window);
  const settingRow = (name: string) =>
    settings.locator('.vertical-tab-content .setting-item').filter({
      has: settings
        .locator('.setting-item-name')
        .getByText(name, { exact: true }),
    });
  const toggle = settingRow('Auto-import notes by tag').locator(
    '.checkbox-container'
  );
  await setToggle(toggle, true);
  const field = settingRow('Trigger tags').getByRole('textbox');

  await field.click();
  await field.press('End');
  await field.pressSequentially(' ');

  const items = settings.locator('.suggestion-container .suggestion-item');
  await expect(items.filter({ hasText: /^#e2e-suggest$/ })).toHaveCount(1);
  await expect(
    items.filter({ hasText: /ir-(article|card|text-snippet)/i })
  ).toHaveCount(0);

  await items.filter({ hasText: /^#e2e-suggest$/ }).click();

  await expect(field).toHaveValue(/^#ir-import #e2e-suggest\s*$/);
});

test('suggests the folders that could be watched as the field is typed in, a pick adding it at once with the field ready for the next', async () => {
  await window.evaluate(async () => {
    const { app } = window as unknown as { app: PageApp };
    await app.vault.createFolder('Inbox');
    await app.vault.createFolder('Reading');
    await app.vault.createFolder('Reading/Inbox');
  });
  const settings = await openPluginSettings(app, window);
  const settingRow = (name: string) =>
    settings.locator('.vertical-tab-content .setting-item').filter({
      has: settings
        .locator('.setting-item-name')
        .getByText(name, { exact: true }),
    });
  const toggle = settingRow('Auto-import files added to folders').locator(
    '.checkbox-container'
  );
  const row = settingRow('Watched folders');
  const field = row.getByRole('textbox');
  const message = row.locator('.setting-item-error');
  const chips = row.locator('.ir-folder-chip');
  const suggestions = settings.locator(
    '.suggestion-container .suggestion-item'
  );
  // Watching with no folders says so, until a pick adds one
  await toggle.click();
  await expect(message).toBeVisible();

  await field.fill('INB');
  await expect(suggestions).toHaveText(['Inbox', 'Reading/Inbox']);

  await suggestions.filter({ hasText: /^Reading\/Inbox$/ }).click();
  await expect(chips).toHaveText(['Reading/Inbox']);
  await expect(field).toHaveValue('');
  await expect(message).toBeHidden();
  await expect(suggestions).toHaveCount(0);
  await expect(field).toBeFocused();

  // Typed straight into the field the pick left focused; a folder watched is
  // offered no more
  await settings.keyboard.type('inbox');
  await expect(suggestions).toHaveText(['Inbox']);

  // Enter while the list is open picks the highlighted one, adding it too
  await field.press('Enter');
  await expect(chips).toHaveText(['Reading/Inbox', 'Inbox']);
  await expect(field).toHaveValue('');
  await expect(suggestions).toHaveCount(0);
  await expect(field).toBeFocused();
});

test('imports in place, once, a note both tagged and in a watched folder however it gets there, whatever copying on import says', async () => {
  await window.evaluate(async () => {
    const { app } = window as unknown as { app: PageApp };
    await app.vault.createFolder('Inbox');
    await app.vault.create('Inbox/Here before.md', 'Here before watching.\n');
  });
  await setPluginSetting(window, 'autoImportOnTag', true);
  await setPluginSetting(window, 'copyOnImport', true);
  // As an older version stored it; nothing reads it now
  await setPluginSetting(window, 'autoImportMode', 'copy');
  await setPluginSetting(window, 'autoImportOnFolder', true);
  await setPluginSetting(window, 'autoImportFolders', ['Inbox']);
  // Saving tells the watcher, as the settings tab does
  await window.evaluate(() =>
    (window as unknown as { app: PageApp }).app.plugins.plugins[
      'incremental-reading'
    ].saveSettings()
  );
  const before = await articleCount();
  const articlesBefore = await articleFiles();
  const tagged = `---\ntags: [${AUTO_IMPORT_TAG}]\n---\nBody.\n`;

  // Created in the folder already tagged
  await window.evaluate(async (content) => {
    const { app } = window as unknown as { app: PageApp };
    await app.vault.create('Inbox/Created tagged.md', content);
  }, tagged);
  await expectImported('Inbox/Created tagged.md');

  // Tagged while in the folder, there from before it was watched
  await setFrontmatter('Inbox/Here before.md', 'tags', [AUTO_IMPORT_TAG]);
  await expectImported('Inbox/Here before.md');

  // Moved in tagged, before the import its tag queued
  await window.evaluate(async (content) => {
    const { app } = window as unknown as { app: PageApp };
    const file = await app.vault.create('Moved tagged.md', content);
    await app.fileManager.renameFile(file, 'Inbox/Moved tagged.md');
  }, tagged);
  await expectImported('Inbox/Moved tagged.md');

  // Arrived untagged, then tagged once it is an article
  await window.evaluate(async () => {
    const { app } = window as unknown as { app: PageApp };
    await app.vault.create('Inbox/Arrived plain.md', 'Plain.\n');
  });
  const id = await expectImported('Inbox/Arrived plain.md');
  await setFrontmatter('Inbox/Arrived plain.md', 'tags', [
    AUTO_IMPORT_TAG,
    ARTICLE_TAG,
  ]);
  await expect
    .poll(async () => (await noteState('Inbox/Arrived plain.md')).tags)
    .toContain(AUTO_IMPORT_TAG);
  await flushAutoImports();

  expect(await noteState('Inbox/Arrived plain.md')).toMatchObject({
    irId: id,
    rowIds: [id],
  });
  expect(await articleCount()).toBe(before + 4);
  expect(await articleFiles()).toEqual(articlesBefore);
});
