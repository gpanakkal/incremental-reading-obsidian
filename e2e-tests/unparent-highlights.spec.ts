import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { App } from 'obsidian';
import {
  chooseFromMenu,
  executeCommandById,
  expectExtractSettled,
  importArticle,
  setNativeMenus,
  setPluginSetting,
  type RepoWindow,
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

/** An article's note at the vault's top, so its row shows in Files. */
const NOTE = 'Parent article';
const NOTE_PATH = `${NOTE}.md`;

const FIRST_TEXT = 'the first passage a snippet is taken from';
const SECOND_TEXT = 'the second passage a snippet is taken from';
const NOTE_TEXT = `# ${NOTE}\n\nA paragraph holding ${FIRST_TEXT}.\n\nAnother paragraph holding ${SECOND_TEXT}.\n`;

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('unparent');
  await fs.writeFile(path.join(vaultPath, NOTE_PATH), NOTE_TEXT);
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
  // Pinned: CI's window is much narrower than a local headless run's
  await window.setViewportSize({ width: 1000, height: 900 });
  // No success notices: one still up over a menu takes the click meant for it
  await setPluginSetting(window, 'successNoticesOutsideReview', 'none');
  await setPluginSetting(window, 'successNoticesInReview', 'none');
  // macOS defaults to native menus, which Electron draws outside the page
  await setNativeMenus(window, false);
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
 * Import the note and take a snippet of each passage from it, leaving the
 * note open in its tab. Returns the snippets' note paths, first then second.
 *
 * Unofficial: `window.app`, `app.plugins.plugins`, `reviewManager.repo`.
 */
async function importWithSnippets(): Promise<[string, string]> {
  await importArticle(window, NOTE_PATH);
  for (const [i, text] of [FIRST_TEXT, SECOND_TEXT].entries()) {
    await window.evaluate((text) => {
      const editor = (window as unknown as { app: App }).app.workspace
        .activeEditor?.editor;
      if (!editor) throw new Error('No active editor');
      const start = editor.getValue().indexOf(text);
      editor.setSelection(
        editor.offsetToPos(start),
        editor.offsetToPos(start + text.length)
      );
    }, text);
    await executeCommandById(window, 'incremental-reading:extract-selection');
    await expectExtractSettled(window, NOTE_PATH, i + 1);
  }
  const references = await window.evaluate(async () => {
    const { repo } = (window as unknown as RepoWindow).app.plugins.plugins[
      'incremental-reading'
    ].reviewManager;
    const rows = await repo.query(
      'SELECT reference FROM snippet ORDER BY start_offset'
    );
    return (rows ?? []).map(({ reference }) => String(reference));
  });
  expect(references).toHaveLength(2);
  return [references[0], references[1]];
}

/**
 * The note's tab on screen. A split shows the note in both panes until the
 * queue opens in one of them, in a tab of its own in front of the note's.
 */
const noteLeaf = () =>
  window
    .locator('.workspace-leaf')
    .filter({ has: window.locator('.view-header-title', { hasText: NOTE }) })
    .filter({ visible: true });

/** The highlights the note's editor paints: live preview or source mode. */
const editorHighlights = () =>
  noteLeaf().locator('.cm-content .ir-snippet-highlight');

/** The highlights the note's reading view paints. */
const readingHighlights = () =>
  noteLeaf().locator('.markdown-reading-view .ir-snippet-highlight');

/** Highlighted text, whichever mode paints it: one passage per entry. */
async function paintedTexts(
  painted: ReturnType<typeof editorHighlights>
): Promise<string[]> {
  return (await painted.allTextContents()).filter((t) => t.trim() !== '');
}

/** Un-import the note from its row in Files, answering its confirmation. */
async function unimportFromFiles() {
  await chooseFromMenu(
    window,
    window.locator(`.nav-file-title[data-path="${NOTE_PATH}"]`),
    ['Un-import article']
  );
  const confirm = window
    .locator('.modal-container.mod-confirmation')
    .getByRole('button', { name: 'Un-import' });
  await expect(async () => {
    if (await confirm.isVisible()) await confirm.click();
    await expect(
      window.locator('.modal-container.mod-confirmation')
    ).toHaveCount(0, { timeout: 2_000 });
  }).toPass();
}

/** Bring every row due, so each shows in the queue. */
async function bringAllDue() {
  await window.evaluate(async () => {
    const { repo } = (window as unknown as RepoWindow).app.plugins.plugins[
      'incremental-reading'
    ].reviewManager;
    const due = Date.now() - 60_000;
    await repo.mutate('UPDATE article SET due = $1', [due]);
    await repo.mutate('UPDATE snippet SET due = $1', [due]);
  });
}

/** Open the review tab's queue, in a split beside the note's tab. */
async function openQueueBeside() {
  await bringAllDue();
  await executeCommandById(window, 'workspace:split-vertical');
  await executeCommandById(window, 'incremental-reading:learn');
}

/** The queue row of the note at `at`, which its path cell shows in full. */
const queueRow = (at: string) =>
  window.locator('.ir-queue-row').filter({
    has: window.locator('.ir-queue-cell').getByText(at, { exact: true }),
  });

/** Delete the item of the queue row of the note at `at`, from that row's menu. */
async function deleteFromQueue(at: string) {
  const row = queueRow(at);
  await expect(row).toHaveCount(1);
  await chooseFromMenu(window, row.locator('.ir-queue-cell').first(), [
    'Delete',
  ]);
  await expect(row).toHaveCount(0);
}

// #endregion

for (const source of [false, true]) {
  test(`un-importing an article takes its snippet highlights off the note open in ${source ? 'source mode' : 'live preview'} at once`, async () => {
    await importWithSnippets();
    if (source) await executeCommandById(window, 'editor:toggle-source');
    await expect(editorHighlights().first()).toBeVisible();

    await unimportFromFiles();

    await expect(editorHighlights()).toHaveCount(0);
  });
}

test('un-importing an article takes its snippet highlights off the note open in reading view at once', async () => {
  await importWithSnippets();
  await executeCommandById(window, 'markdown:toggle-preview');
  await expect(readingHighlights().first()).toBeVisible();

  await unimportFromFiles();

  await expect(readingHighlights()).toHaveCount(0);
});

test('deleting a snippet from the queue takes only its highlight off its open parent', async () => {
  const [first] = await importWithSnippets();
  await openQueueBeside();

  await deleteFromQueue(first);

  await expect
    .poll(() => paintedTexts(editorHighlights()))
    .toEqual([SECOND_TEXT]);
});
