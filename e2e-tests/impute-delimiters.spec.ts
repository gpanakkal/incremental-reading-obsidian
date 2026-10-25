import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import {
  executeCommandById,
  readMarkdown,
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
    activeEditor: {
      editor?: {
        cm: {
          state: { doc: { toString(): string } };
          dispatch(spec: { selection: { anchor: number; head: number } }): void;
        };
      };
    } | null;
  };
  metadataCache: {
    // Undocumented: what the cache's worker reads a note's bytes as
    computeMetadataAsync(data: ArrayBuffer): Promise<{
      sections?: {
        type: string;
        position: { start: { offset: number }; end: { offset: number } };
      }[];
    } | null>;
  };
};

/** Make a note of `text` and open it in a tab of its own, active, in `mode`. */
const openNewNote = (
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

/** Select `anchor` to `head` in the active editor. */
const select = (page: Page, anchor: number, head: number) =>
  page.evaluate(
    ([anchor, head]) => {
      const { app } = window as unknown as { app: PageApp };
      app.workspace.activeEditor!.editor!.cm.dispatch({
        selection: { anchor, head },
      });
    },
    [anchor, head] as const
  );

/** The notes of the items in `table`, once there are `count` of them. */
async function itemNotes(page: Page, table: string, count: number) {
  const read = () =>
    page.evaluate(async (table) => {
      const rows =
        (await (window as unknown as RepoWindow).app.plugins.plugins[
          'incremental-reading'
        ].reviewManager.repo.query(`SELECT reference FROM ${table}`)) ?? [];
      return rows.map(({ reference }) => String(reference));
    }, table);
  await expect.poll(async () => (await read()).length).toBe(count);
  return read();
}

/** The types of Obsidian's top-level sections of `text`, and their text. */
const sectionsOf = (page: Page, text: string) =>
  page.evaluate(async (text) => {
    const { app } = window as unknown as { app: PageApp };
    const metadata = await app.metadataCache.computeMetadataAsync(
      new TextEncoder().encode(text).buffer
    );
    return (metadata?.sections ?? []).map(
      ({ type, position }) =>
        [type, text.slice(position.start.offset, position.end.offset)] as const
    );
  }, text);

// #endregion

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('impute-delimiters');
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

/*
 * What Obsidian 1.13.7 was seen to read, which `imputeDelimiters` relies on.
 * Should an update change it, this fails.
 */
test('reads blocks as imputing delimiters relies on', async () => {
  // Code, math and comments run over blank lines; an unclosed fence to the end
  expect(await sectionsOf(window, '```js\na\n\nb\n```\n\np')).toEqual([
    ['code', '```js\na\n\nb\n```'],
    ['paragraph', 'p'],
  ]);
  expect(await sectionsOf(window, '```\na\n\nb')).toEqual([
    ['code', '```\na\n\nb'],
  ]);
  expect(await sectionsOf(window, '$$ a\n\nb $$\np')).toEqual([
    ['math', '$$ a\n\nb $$'],
    ['paragraph', 'p'],
  ]);
  expect(await sectionsOf(window, '%%\na\n\nb\n%%\np')).toEqual([
    ['comment', '%%\na\n\nb\n%%'],
    ['paragraph', 'p'],
  ]);
  // A quote ends at a blank line, and takes in a lazy line; three spaces
  // before it still start one, four start code
  expect(await sectionsOf(window, '> a\nlazy\n\n> b')).toEqual([
    ['blockquote', '> a\nlazy'],
    ['blockquote', '> b'],
  ]);
  expect(await sectionsOf(window, '   > a')).toEqual([
    ['blockquote', '   > a'],
  ]);
  expect(await sectionsOf(window, '    > a')).toEqual([['code', '    > a']]);
  expect(await sectionsOf(window, '> [!note] T\n> b')).toEqual([
    ['callout', '> [!note] T\n> b'],
  ]);
  // A table ends at a line of an embed, its alias's pipe and all, which
  // starts a paragraph
  expect(
    await sectionsOf(window, '| a |\n| - |\n![[c|ir-hide-title]]')
  ).toEqual([
    ['table', '| a |\n| - |'],
    ['paragraph', '![[c|ir-hide-title]]'],
  ]);
  // Offsets count UTF-16 code units, as JavaScript's strings do
  expect(await sectionsOf(window, '😀\n```\nx\n```')).toEqual([
    ['paragraph', '😀'],
    ['code', '```\nx\n```'],
  ]);
  // Emptied cells keep a table's columns, a row of the body short of cells
  // is still one, and an embed between two halves of code leaves both code
  const { reading } = await readMarkdown(
    window,
    '| | b |\n| - | - |\n| | c\n\n```\nx\n```\n![[c]]\n```\ny\n```'
  );
  expect(reading.blocks.map(({ tag }) => tag)).toEqual([
    'TABLE',
    'PRE',
    'P',
    'PRE',
  ]);
  // A pipe in inline code still parts two cells, its backticks then shown as
  // text, and a row with only its opening pipe ends the table, the lines
  // from it on a paragraph
  const table = await readMarkdown(
    window,
    '| a | b |\n| - | - |\n| `p|q` | r |\n| ends\n| c | d |'
  );
  expect(table.reading.blocks.map(({ tag }) => tag)).toEqual(['TABLE', 'P']);
  expect(table.reading.blocks[0].text).toContain('`p');
  expect(table.reading.blocks[1].text).toContain('ends');
});

test('gives a snippet cut from inside a code block its fence', async () => {
  await setDefaultEditingMode(window, 'source');
  const doc =
    'Intro\n\n```python\nfirst = 1\nsecond = 2\n```\n\nAfter the code.';
  await openNewNote(window, 'Code note.md', doc);
  await select(window, doc.indexOf('second'), doc.indexOf(' the code'));
  await executeCommandById(window, 'incremental-reading:extract-selection');

  const [snippet] = await itemNotes(window, 'snippet', 1);
  await openNewNote(window, snippet, '', 'preview');

  const preview = window.locator(
    '.workspace-leaf.mod-active .markdown-preview-view'
  );
  // Its frontmatter renders as a hidden code block of its own
  await expect(preview.locator('pre:not(.frontmatter) > code')).toHaveText(
    /second = 2/
  );
  await expect(preview.locator('p', { hasText: 'After' })).toBeVisible();
});

test('parts the embed of a card made in a code block from the code around it', async () => {
  await setDefaultEditingMode(window, 'live-preview');
  const doc =
    'Intro\n\n```python\nfirst = 1\nsecond = 2\n```\n\nAfter the code.';
  await openNewNote(window, 'Card code note.md', doc);
  const answer = doc.indexOf('1\n');
  await select(window, answer, answer + 1);
  await executeCommandById(window, 'incremental-reading:create-card');
  await itemNotes(window, 'srs_card', 1);

  const editor = window.locator(
    '.workspace-leaf.mod-active .markdown-source-view'
  );
  // The embed renders as one, out of the code, and what followed the code
  // is still text
  await expect(editor.locator('.internal-embed')).toBeVisible();
  await expect(
    editor.locator('.cm-line', { hasText: 'After the code.' })
  ).not.toHaveClass(/HyperMD-codeblock/);
  await expect(
    editor.locator('.cm-line.HyperMD-codeblock', { hasText: 'second = 2' })
  ).toBeVisible();
});

test('gives a snippet cut from a cell of a table only that column, first column too', async () => {
  await setDefaultEditingMode(window, 'source');
  const doc = [
    'Intro',
    '',
    '| Technique          | Purpose                  | Interval |',
    '| ------------------ | ------------------------ | -------- |',
    '| Spaced repetition  | Remember facts over time | Growing  |',
    '| Cloze deletion     | Recall a missing word    | Varies   |',
  ].join('\n');
  await openNewNote(window, 'Table note.md', doc);
  for (const [k, text] of ['deletion', 'facts over'].entries()) {
    // The first snippet tags the note, so its text moves
    const now = await window.evaluate(() => {
      const { app } = window as unknown as { app: PageApp };
      return app.workspace.activeEditor!.editor!.cm.state.doc.toString();
    });
    await select(window, now.indexOf(text), now.indexOf(text) + text.length);
    await executeCommandById(window, 'incremental-reading:extract-selection');
    await itemNotes(window, 'snippet', k + 1);
  }

  const tables: string[][][] = [];
  for (const snippet of await itemNotes(window, 'snippet', 2)) {
    await openNewNote(window, snippet, '', 'preview');
    const table = window.locator(
      '.workspace-leaf.mod-active .markdown-preview-view table'
    );
    await expect(table).toBeVisible();
    tables.push(
      await table.evaluate((el) =>
        [...el.querySelectorAll('tr')].map((tr) =>
          [...tr.children].map((cell) => cell.textContent.trim())
        )
      )
    );
  }
  expect(tables).toEqual(
    expect.arrayContaining([
      [['Technique'], ['deletion']],
      [['Purpose'], ['facts over']],
    ])
  );
});
