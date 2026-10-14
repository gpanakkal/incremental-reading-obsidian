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
  noteBody,
  openNote,
  readSnippetState,
  selectParagraph,
} from './helpers';
import {
  closeElectron,
  createVaultCopy,
  launchElectron,
  openVault,
  shouldCleanup,
  waitForLayoutReady,
} from './setup/helpers';

let app: ElectronApplication;
let window: Page;
let vaultPath: string;

const NOTE = 'testing/Reading highlights';
const NOTE_PATH = `${NOTE}.md`;

/** The line the test turns into a card, so a snippet can sit below its embed. */
const CARD_LINE =
  'This whole line becomes a card before anything is extracted.';

/** Text each snippet is extracted from, picked to sit after a block of each kind. */
const SNIPPETS = [
  // In the note's first paragraph: nothing above it but a heading
  'opening words of the note',
  // A list item's own text
  'second list item text',
  // A whole list line, marker and all, ending the list's section
  '- third list item text',
  // A paragraph right after a list
  'paragraph straight after the list',
  // A heading's text, not the whole line
  'heading words here',
  // A paragraph after a card's embed
  'paragraph below the card embed',
  // Two sections' worth of text, run across a paragraph break
  'end of one paragraph.\n\nStart of the next',
  // Starting on bold text (extracting widens a selection inside it to this)
  '**bold words** and',
  // Starting on an underscore's emphasis, which a letter right before it breaks
  '_slanted words_ close',
  // Inside highlighted code, whose tokens split the text into many nodes
  'compute(input, 42)',
];

const NOTE_TEXT = [
  '# A note to read',
  '',
  'These are the opening words of the note, in a plain paragraph.',
  '',
  '- first list item text',
  '- second list item text',
  '- third list item text',
  '',
  'A paragraph straight after the list, with nothing between.',
  '',
  '## Some heading words here',
  '',
  CARD_LINE,
  '',
  'A paragraph below the card embed, the last of the plain ones.',
  '',
  'This sentence is the end of one paragraph.',
  '',
  'Start of the next one, which closes the note.',
  '',
  'Some **bold words** and more.',
  '',
  'Then _slanted words_ close the line.',
  '',
  '```js',
  'const result = compute(input, 42);',
  '```',
  '',
].join('\n');

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('reading');
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
 * Select `text` in the active editor and extract it.
 *
 * Unofficial: `window.app`.
 */
async function extract(page: Page, text: string) {
  await page.evaluate((text) => {
    const editor = (window as unknown as { app: App }).app.workspace
      .activeEditor?.editor;
    if (!editor) throw new Error('No active editor');
    const start = editor.getValue().indexOf(text);
    if (start < 0) throw new Error(`Not in the note: ${text}`);
    editor.setSelection(
      editor.offsetToPos(start),
      editor.offsetToPos(start + text.length)
    );
  }, text);
  await executeCommandById(page, 'incremental-reading:extract-selection');
}

/** Each snippet's stored text, as its offsets cut it from the note on disk. */
async function storedTexts(page: Page) {
  const { rows, diskText } = await readSnippetState(page, NOTE_PATH);
  const body = noteBody(diskText);
  return Object.fromEntries(
    rows.map(({ id, start_offset, end_offset }) => [
      id,
      body.slice(start_offset, end_offset),
    ])
  );
}

/** The text each snippet's highlight paints in the active tab's reading view. */
function paintedInReadingView(page: Page, ids: string[]) {
  return page.evaluate((ids) => {
    const view = document.querySelector(
      '.workspace-leaf.mod-active .markdown-reading-view'
    );
    return Object.fromEntries(
      ids.map((id) => [
        id,
        Array.from(
          view?.querySelectorAll(
            `.ir-snippet-highlight[data-snippet-id="${id}"]`
          ) ?? []
        )
          .map((el) => el.textContent)
          .join(''),
      ])
    );
  }, ids);
}

/**
 * What a highlight on `text` from the note shows: no block markers or
 * emphasis marks, and no line breaks, which a highlight across blocks paints
 * none of.
 */
const shownFromSource = (text: string) =>
  text
    .replace(/^(?:[-#]+ )+/gm, '')
    .replace(/\*\*|_/g, '')
    .replace(/\n/g, '');

/** A highlight's painted text, less the line breaks between its blocks. */
const shownOnPage = (text: string) => text.replace(/\n/g, '');

/** Make the card, extract every snippet, and wait for them all to be stored. */
async function setUpNote() {
  await openNote(window, NOTE);
  await selectParagraph(window, CARD_LINE);
  await executeCommandById(window, 'incremental-reading:create-card');
  await expect(
    window.locator(
      '.workspace-leaf.mod-active .internal-embed[alt*="ir-hide-title"]'
    )
  ).toHaveCount(1);
  for (const text of SNIPPETS) await extract(window, text);
  // Polled: snippets and the card's embed reach the disk on their own debounces
  await expect
    .poll(async () => Object.values(await storedTexts(window)).sort())
    .toEqual([...SNIPPETS].sort());
  return storedTexts(window);
}

async function expectReadingViewHighlights(stored: Record<string, string>) {
  const ids = Object.keys(stored);
  const expected = Object.fromEntries(
    ids.map((id) => [id, shownFromSource(stored[id])])
  );
  await expect
    .poll(async () => {
      const painted = await paintedInReadingView(window, ids);
      return Object.fromEntries(
        ids.map((id) => [id, shownOnPage(painted[id])])
      );
    })
    .toEqual(expected);
}

test.describe('Snippet highlights in reading mode', () => {
  test('cover each snippet on its exact text', async () => {
    const stored = await setUpNote();
    await executeCommandById(window, 'markdown:toggle-preview');
    await expect(
      window.locator('.workspace-leaf.mod-active .markdown-reading-view')
    ).toBeVisible();
    await expectReadingViewHighlights(stored);
  });

  test('open their snippet when clicked, in a new tab with a modifier or the middle button', async () => {
    const stored = await setUpNote();
    const [id] = Object.entries(stored).find(
      ([, text]) => text === 'paragraph straight after the list'
    )!;
    // Not a check: the snippet's note is named by nothing on screen until it
    // opens, so its title is read from the database to know it by.
    // Unofficial: `window.app`, `app.plugins.plugins`, `reviewManager.repo`
    const reference = await window.evaluate((id) => {
      const { app } = window as unknown as {
        app: {
          plugins: {
            plugins: Record<
              string,
              {
                reviewManager: {
                  repo: {
                    query(
                      sql: string,
                      params: unknown[]
                    ): { reference: string }[];
                  };
                };
              }
            >;
          };
        };
      };
      return app.plugins.plugins[
        'incremental-reading'
      ].reviewManager.repo.query(
        'SELECT reference FROM snippet WHERE id = $1',
        [id]
      )[0].reference;
    }, id);
    const snippetTitle = path.posix.basename(reference, '.md');
    const noteTitle = path.posix.basename(NOTE);
    /** Every tab header in the main area, and the active one's title. */
    const tabHeaders = window.locator('.mod-root .workspace-tab-header');
    const activeTitle = window.locator(
      '.mod-root .workspace-tabs.mod-active .workspace-tab-header.is-active .workspace-tab-header-inner-title'
    );
    await executeCommandById(window, 'markdown:toggle-preview');
    const highlight = window
      .locator(
        `.workspace-leaf.mod-active .markdown-reading-view .ir-snippet-highlight[data-snippet-id="${id}"]`
      )
      .first();

    const tabs = await tabHeaders.count();
    await highlight.click({ modifiers: ['ControlOrMeta'] });
    await expect(tabHeaders).toHaveCount(tabs + 1);
    await expect(activeTitle).toHaveText(snippetTitle);

    await executeCommandById(window, 'workspace:close');
    await expect(activeTitle).toHaveText(noteTitle);
    // A middle click opens a new tab too, as in live preview
    await highlight.click({ button: 'middle' });
    await expect(tabHeaders).toHaveCount(tabs + 1);
    await expect(activeTitle).toHaveText(snippetTitle);

    await executeCommandById(window, 'workspace:close');
    await expect(activeTitle).toHaveText(noteTitle);
    await highlight.click();
    await expect(activeTitle).toHaveText(snippetTitle);
    await expect(tabHeaders).toHaveCount(tabs);
  });

  test('show on a tab restored in reading mode', async () => {
    const stored = await setUpNote();
    await executeCommandById(window, 'markdown:toggle-preview');
    await expect(
      window.locator('.workspace-leaf.mod-active .markdown-reading-view')
    ).toBeVisible();
    // Unofficial: `workspace.saveLayout`, the `app:reload` command
    await window.evaluate(async () => {
      await (
        window as unknown as {
          app: App & { workspace: { saveLayout(): Promise<void> } };
        }
      ).app.workspace.saveLayout();
    });
    await window.evaluate(() => {
      (
        window as unknown as {
          app: { commands: { executeCommandById(id: string): boolean } };
        }
      ).app.commands.executeCommandById('app:reload');
    });
    await waitForLayoutReady(window);
    await expect(
      window.locator('.workspace-leaf.mod-active .markdown-reading-view')
    ).toBeVisible();
    await expectReadingViewHighlights(stored);
  });
});
