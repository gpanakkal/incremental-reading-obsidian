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
  expectFlashLitOnceScrolled,
  openFileInActiveLeaf,
  openNote,
  readSnippetState,
  recordFlash,
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

/** The active tab's note, and its mode. Unofficial: `window.app`. */
function activeMode(page: Page) {
  return page.evaluate(() => {
    const { app } = window as unknown as { app: App };
    const view = app.workspace.getMostRecentLeaf()?.view as
      | { getMode?(): string; file?: { path: string } | null }
      | undefined;
    return { mode: view?.getMode?.() ?? null, path: view?.file?.path ?? null };
  });
}

/**
 * What the active tab shows of the flash: the text of what is lit, whether
 * the flash's own easing applies to it, and how many of Obsidian's own
 * `is-flashing` marks are left.
 */
function flashState(page: Page) {
  return page.evaluate(() => {
    const leaf = document.querySelector('.workspace-leaf.mod-active');
    const lit = [
      ...(leaf?.querySelectorAll<HTMLElement>(
        '.ir-context-flashing .ir-context-flash, .ir-context-flash-lit'
      ) ?? []),
    ];
    return {
      lit: lit.map((el) => el.textContent ?? '').join(''),
      eased:
        lit.length > 0 &&
        lit.every(
          (el) => getComputedStyle(el).transitionDuration === '0.75s, 0.75s'
        ),
      flashes: leaf?.querySelectorAll('.ir-context-flash').length ?? 0,
      obsidianFlashes: leaf?.querySelectorAll('.is-flashing').length ?? 0,
    };
  });
}

/** Go to context from the item at `itemPath`, opened in the active tab. */
async function goToContextFrom(itemPath: string) {
  await openFileInActiveLeaf(window, itemPath);
  await expect.poll(async () => (await activeMode(window)).path).toBe(itemPath);
  await recordFlash(window);
  // As the tab's file menu runs it. Unofficial: `window.app`,
  // `app.plugins.plugins`
  await window.evaluate(async (itemPath) => {
    const { app } = window as unknown as {
      app: App & {
        plugins: {
          plugins: Record<
            string,
            { actions: { goToContext(file: unknown): Promise<void> } }
          >;
        };
      };
    };
    await app.plugins.plugins['incremental-reading'].actions.goToContext(
      app.vault.getFileByPath(itemPath)
    );
  }, itemPath);
  expect((await activeMode(window)).path).toBe(NOTE_PATH);
}

/**
 * The flash shows on `text`, lit only once the scroll there is done, eased in
 * and out, and then goes, leaving nothing lit behind, nor Obsidian's own
 * highlight.
 */
async function expectFlashOn(text: RegExp) {
  await expectFlashLitOnceScrolled(window, text);
  expect(await flashState(window)).toEqual({
    lit: '',
    eased: false,
    flashes: 0,
    obsidianFlashes: 0,
  });
}

test.describe('Go to context flashes the place it opens at', () => {
  test("in live preview, on a snippet's passage", async () => {
    const snippet = await setUpNote();

    await goToContextFrom(snippet);
    expect((await activeMode(window)).mode).toBe('source');
    await expectFlashOn(new RegExp(`^${SNIPPET_TEXT}$`));
  });

  test("in reading view, on a snippet's highlight", async () => {
    const snippet = await setUpNote();
    // The tab stays in reading view as it opens the item, and its context
    await executeCommandById(window, 'markdown:toggle-preview');
    await expect
      .poll(async () => (await activeMode(window)).mode)
      .toBe('preview');

    await goToContextFrom(snippet);
    expect((await activeMode(window)).mode).toBe('preview');
    await expectFlashOn(new RegExp(`^${SNIPPET_TEXT}$`));
  });
});
