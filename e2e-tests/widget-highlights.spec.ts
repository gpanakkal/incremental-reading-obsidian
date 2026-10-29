import {
  expect,
  default as test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import {
  executeCommandById,
  setDefaultEditingMode,
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

// #region HELPERS

/** The page-side Obsidian these tests reach. Unofficial: `window.app`. */
type PageApp = {
  vault: {
    create(path: string, data: string): Promise<unknown>;
    getFileByPath(path: string): unknown;
  };
  workspace: {
    getLeaf(newLeaf: 'tab'): {
      openFile(file: unknown, state?: unknown): Promise<void>;
    };
    setActiveLeaf(leaf: unknown, params: { focus: boolean }): void;
    getActiveFile(): { path: string } | null;
    activeEditor: {
      editor?: {
        cm: {
          state: { doc: { toString(): string; length: number } };
          dispatch(spec: { selection: { anchor: number; head: number } }): void;
        };
      };
    } | null;
  };
};

/** Open the note at `path` (made of `text` if missing) in a tab of its own, active, in `mode`. */
const openNote = (
  page: Page,
  path: string,
  text: string,
  mode: 'source' | 'preview' = 'source'
) =>
  page.evaluate(
    async ([path, text, mode]) => {
      const { app } = window as unknown as { app: PageApp };
      const file =
        app.vault.getFileByPath(path) ?? (await app.vault.create(path, text));
      const leaf = app.workspace.getLeaf('tab');
      // Undocumented: the view state of live preview and reading view
      await leaf.openFile(file, { active: true, state: { mode } });
      app.workspace.setActiveLeaf(leaf, { focus: true });
    },
    [path, text, mode] as const
  );

/** The active editor's text. */
const docOf = (page: Page) =>
  page.evaluate(() => {
    const { app } = window as unknown as { app: PageApp };
    return app.workspace.activeEditor!.editor!.cm.state.doc.toString();
  });

/** Select `anchor` to `head` in the active editor; `head` defaults to `anchor`. */
const select = (page: Page, anchor: number, head = anchor) =>
  page.evaluate(
    ([anchor, head]) => {
      const { app } = window as unknown as { app: PageApp };
      app.workspace.activeEditor!.editor!.cm.dispatch({
        selection: { anchor, head },
      });
    },
    [anchor, head] as const
  );

/** Put the cursor at the end of the active editor's text. */
const cursorToEnd = async (page: Page) =>
  select(page, (await docOf(page)).length);

/** The notes of the snippets, once there are `count` of them. */
async function snippetNotes(page: Page, count: number) {
  const read = () =>
    page.evaluate(async () => {
      const rows =
        (await (window as unknown as RepoWindow).app.plugins.plugins[
          'incremental-reading'
        ].reviewManager.repo.query('SELECT reference FROM snippet')) ?? [];
      return rows.map(({ reference }) => String(reference));
    });
  await expect.poll(async () => (await read()).length).toBe(count);
  return read();
}

/** Extract `text`, as it is in the active editor now, as a snippet. */
async function extract(page: Page, text: string, count: number) {
  const doc = await docOf(page);
  const at = doc.indexOf(text);
  expect(at).toBeGreaterThan(-1);
  await select(page, at, at + text.length);
  await executeCommandById(page, 'incremental-reading:extract-selection');
  return snippetNotes(page, count);
}

const activePath = (page: Page) =>
  page.evaluate(() => {
    const { app } = window as unknown as { app: PageApp };
    return app.workspace.getActiveFile()?.path ?? null;
  });

const activeEditorEl = (page: Page) =>
  page.locator('.workspace-leaf.mod-active .markdown-source-view');

// #endregion

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('widget-highlights');
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

test('shows a snippet cut from a callout in the rendered callout, and opens it on click', async () => {
  await setDefaultEditingMode(window, 'source');
  const doc = [
    'Intro',
    '',
    '> [!note] Title',
    '> The body of the callout holds spaced repetition text.',
    '> > [!tip]- Folded',
    '> > Nested text.',
    '',
    'After.',
  ].join('\n');
  await openNote(window, 'Callout note.md', doc);
  const [snippet] = await extract(window, 'spaced repetition', 1);

  // Source mode marks the text itself
  await expect(
    activeEditorEl(window).locator('.cm-line .ir-snippet-highlight')
  ).toHaveText('spaced repetition');

  await setDefaultEditingMode(window, 'live-preview');
  await openNote(window, 'Callout note.md', '');
  await cursorToEnd(window);
  const callout = activeEditorEl(window).locator('.cm-embed-block.cm-callout');
  await expect(callout.locator('.ir-snippet-highlight')).toHaveText(
    'spaced repetition'
  );

  await callout.locator('.ir-snippet-highlight').click();
  await expect.poll(() => activePath(window)).toBe(snippet);

  // Reading view shows it once, as before
  await openNote(window, 'Callout note.md', '', 'preview');
  await expect(
    window.locator(
      '.workspace-leaf.mod-active .markdown-preview-view .callout .ir-snippet-highlight'
    )
  ).toHaveText('spaced repetition');
});

test('repaints a callout as its snippets come and go', async () => {
  await setDefaultEditingMode(window, 'live-preview');
  const doc = [
    'Intro',
    '',
    '> [!note]',
    '> First words and second words.',
    '',
    'After.',
  ].join('\n');
  await openNote(window, 'Callout change note.md', doc);
  await extract(window, 'First words', 1);
  await cursorToEnd(window);
  const marks = activeEditorEl(window).locator(
    '.cm-embed-block.cm-callout .ir-snippet-highlight'
  );
  await expect(marks).toHaveText(['First words']);

  // A second snippet, cut with the cursor in the callout, shows once it leaves
  await extract(window, 'second words', 2);
  await cursorToEnd(window);
  await expect(marks).toHaveText(['First words', 'second words']);

  // Undoing the snippets takes their highlights away
  await executeCommandById(window, 'incremental-reading:undo');
  await expect(marks).toHaveText(['First words']);
  await executeCommandById(window, 'incremental-reading:undo');
  await expect(marks).toHaveCount(0);
});

test('shows a snippet cut from a table cell in that cell, through edits to the table', async () => {
  await setDefaultEditingMode(window, 'live-preview');
  // Pinned, as CI's window is smaller than the local headless one
  await window.setViewportSize({ width: 1024, height: 768 });
  // Padded as Obsidian's table editor pads it, with room in each column for
  // the edits below: past that, it pads every row anew
  const doc = [
    'Intro',
    '',
    '| Technique         | Purpose                             | Interval |',
    '| ----------------- | ----------------------------------- | -------- |',
    '| Spaced repetition | Remember facts over time            | Growing  |',
    '| Cloze deletion    | Recall a missing word in a sentence | Varies   |',
    '',
    'After.',
  ].join('\n');
  await openNote(window, 'Table note.md', doc);
  const [snippet] = await extract(window, 'facts over', 1);
  await cursorToEnd(window);

  const table = activeEditorEl(window).locator('.cm-table-widget');
  const marked = table.locator('td', { hasText: 'Remember' });
  const mark = marked.locator('.ir-snippet-highlight');
  await expect(mark).toHaveText('facts over');

  // Editing another cell leaves the mark
  await table.locator('td', { hasText: 'Growing' }).click();
  await window.keyboard.press('End');
  await window.keyboard.type('!');
  await expect(table.locator('td .cm-editor')).toBeVisible();
  await expect(mark).toHaveText('facts over');

  // Editing the marked cell, then leaving it, paints it again
  await marked.click({ position: { x: 12, y: 12 } });
  await expect(marked.locator('.cm-editor')).toBeVisible();
  await window.keyboard.press('End');
  await window.keyboard.type(' now');
  await activeEditorEl(window)
    .locator('.cm-line', { hasText: 'After.' })
    .click();
  await expect(marked.locator('.cm-editor')).toHaveCount(0);
  await expect(marked).toContainText('now');
  await expect(mark).toHaveText('facts over');

  await mark.click();
  await expect.poll(() => activePath(window)).toBe(snippet);
});

test("shows a table cell's highlight in the cell's editor, through typing in it", async () => {
  await setDefaultEditingMode(window, 'live-preview');
  await window.setViewportSize({ width: 1024, height: 768 });
  // Padded as Obsidian's table editor pads it, or entering a cell pads every
  // row anew. The marked cell is its column's widest: typing in it widens the
  // column, so the cell's own text changes by just what is typed.
  const doc = [
    'Intro',
    '',
    '| Technique         | Purpose                             | Interval |',
    '| ----------------- | ----------------------------------- | -------- |',
    '| Spaced repetition | Remember facts over time            | Growing  |',
    '| Cloze deletion    | Recall a missing word in a sentence | Varies   |',
    '',
    'After.',
  ].join('\n');
  await openNote(window, 'Table editor note.md', doc);
  await extract(window, 'missing word', 1);
  await cursorToEnd(window);

  const pastEndWarnings: string[] = [];
  window.on('console', (message) => {
    if (/reaches past the end/.test(message.text())) {
      pastEndWarnings.push(message.text());
    }
  });

  const marked = activeEditorEl(window).locator('.cm-table-widget td', {
    hasText: 'Recall',
  });
  await expect(marked.locator('.ir-snippet-highlight')).toHaveText(
    'missing word'
  );

  // In the cell, its editor marks the same text
  await marked.click({ position: { x: 12, y: 12 } });
  const cellEditor = marked.locator('.cm-editor');
  await expect(cellEditor).toBeVisible();
  const cellMark = cellEditor.locator('.ir-snippet-highlight');
  await expect(cellMark).toHaveText('missing word');

  // Typed before the highlight, the mark moves with its text
  await window.keyboard.press('Home');
  await window.keyboard.type('X');
  await expect(cellEditor).toContainText('XRecall a missing word');
  await expect(cellMark).toHaveText('missing word');
  expect(pastEndWarnings).toEqual([]);

  // Out of the cell, its rendered text shows it again
  await activeEditorEl(window)
    .locator('.cm-line', { hasText: 'After.' })
    .click();
  await expect(cellEditor).toHaveCount(0);
  await expect(marked).toContainText('XRecall');
  await expect(marked.locator('.ir-snippet-highlight')).toHaveText(
    'missing word'
  );
});
