import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { App } from 'obsidian';
import {
  executeCommandById,
  openFileInActiveLeaf,
  openNote,
  readSnippetState,
  recordedFlash,
  recordFlash,
  setNativeMenus,
  setPluginSetting,
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

const NOTE = 'testing/Flash context';
const NOTE_PATH = `${NOTE}.md`;

/** The text the test extracts as a snippet. */
const SNIPPET_TEXT = 'the passage Go to context flashes';

/** Paragraphs enough to push the snippet's out of the first screenful. */
const FILLER = Array.from(
  { length: 60 },
  (_, i) => `Filler paragraph number ${i + 1}, to scroll past.\n`
);

const NOTE_TEXT = [
  '# A note with a context to go to',
  '',
  ...FILLER,
  `A paragraph holding ${SNIPPET_TEXT}, and some words after it.`,
  '',
  'A last paragraph, closing the note.',
  '',
].join('\n');

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('flash');
  await fs.writeFile(path.join(vaultPath, NOTE_PATH), NOTE_TEXT);
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
  // Pinned: CI's window is much narrower than a local headless run's
  await window.setViewportSize({ width: 1000, height: 900 });
  // No success notices: one still up over the view header's ⋮ takes the click
  // meant for it, and Obsidian keeps a notice up while the pointer is on it
  await setPluginSetting(window, 'successNoticesOutsideReview', 'none');
  await setPluginSetting(window, 'successNoticesInReview', 'none');
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
  if (shouldCleanup) {
    await fs
      .rm(vaultPath, { recursive: true, force: true, maxRetries: 3 })
      .catch(() => {});
  }
});

/**
 * Extract the snippet from the note; its note's path, once it is stored.
 *
 * Unofficial: `window.app`, `app.plugins.plugins`, `reviewManager.repo`.
 */
async function setUpNote(): Promise<string> {
  await openNote(window, NOTE);
  await window.evaluate((text) => {
    const editor = (window as unknown as { app: App }).app.workspace
      .activeEditor?.editor;
    if (!editor) throw new Error('No active editor');
    const start = editor.getValue().indexOf(text);
    editor.setSelection(
      editor.offsetToPos(start),
      editor.offsetToPos(start + text.length)
    );
  }, SNIPPET_TEXT);
  await executeCommandById(window, 'incremental-reading:extract-selection');
  // Polled: the snippet's offsets reach the database on their own debounce
  await expect
    .poll(async () => (await readSnippetState(window, NOTE_PATH)).rows.length)
    .toBe(1);
  return window.evaluate(() => {
    type Repo = {
      query(sql: string, params: unknown[]): { reference: string }[];
    };
    const { app } = window as unknown as {
      app: {
        plugins: {
          plugins: Record<string, { reviewManager: { repo: Repo } }>;
        };
      };
    };
    const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
    return repo.query('SELECT reference FROM snippet', [])[0].reference;
  });
}

/** The title in the active tab's header: the name the user reads it by. */
const activeTabTitle = () =>
  window.locator(
    '.workspace-tabs.mod-active .workspace-tab-header.is-active .workspace-tab-header-inner-title'
  );

/** A note's tab title: its basename. */
const titleOf = (notePath: string) =>
  path.posix.basename(notePath).replace(/\.md$/, '');

/**
 * Open the item at `itemPath` in the active tab, and choose Go to context from
 * its view's ⋮ menu.
 */
async function goToContextFrom(itemPath: string) {
  await openFileInActiveLeaf(window, itemPath);
  await expect(activeTabTitle()).toHaveText(titleOf(itemPath));
  await recordFlash(window);
  // macOS defaults to native menus, which Electron draws outside the page
  await setNativeMenus(window, false);
  await window
    .locator('.workspace-leaf.mod-active .view-header')
    .getByLabel('More options')
    .click();
  await window
    .locator('.menu')
    .getByText('Go to context', { exact: true })
    .click();
  await expect(activeTabTitle()).toHaveText(titleOf(NOTE_PATH));
}

/**
 * Go to context lit `text` on screen, and then nothing is left lit, nor
 * Obsidian's own highlight.
 *
 * Lit is read from what {@link recordFlash} saw in the page: the flash is lit
 * for under a second, which a poll from the test, backing off to 1s between
 * tries, can step right over.
 */
async function expectFlashOn(text: RegExp) {
  await expect
    .poll(() => recordedFlash(window), { timeout: 5000 })
    .not.toBeNull();
  expect(await recordedFlash(window)).toMatchObject({
    text: expect.stringMatching(text),
    onScreen: true,
  });
  const leaf = window.locator('.workspace-leaf.mod-active');
  await expect(leaf.locator('.ir-context-flash')).toHaveCount(0);
  await expect(leaf.locator('.is-flashing')).toHaveCount(0);
}

test.describe('Go to context flashes the place it opens at', () => {
  test("in live preview, on a snippet's passage", async () => {
    const snippet = await setUpNote();

    await goToContextFrom(snippet);
    await expect(
      window.locator(
        '.workspace-leaf.mod-active .markdown-source-view.is-live-preview'
      )
    ).toBeVisible();
    await expectFlashOn(new RegExp(`^${SNIPPET_TEXT}$`));
  });

  const readingView = () =>
    window.locator('.workspace-leaf.mod-active .markdown-reading-view');

  test("in reading view, on a snippet's highlight", async () => {
    const snippet = await setUpNote();
    // The tab stays in reading view as it opens the item, and its context
    await executeCommandById(window, 'markdown:toggle-preview');
    await expect(readingView()).toBeVisible();

    await goToContextFrom(snippet);
    await expect(readingView()).toBeVisible();
    await expectFlashOn(new RegExp(`^${SNIPPET_TEXT}$`));
  });
});
