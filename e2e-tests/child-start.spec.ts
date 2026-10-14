import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import { readMarkdown, setDefaultEditingMode } from './helpers';
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

/** The page-side Obsidian and plugin these tests reach. */
type PageApp = {
  vault: {
    create(path: string, data: string): Promise<unknown>;
    getFileByPath(path: string): unknown;
    cachedRead(file: unknown): Promise<string>;
  };
  workspace: {
    getLeaf(newLeaf: 'tab'): { openFile(file: unknown): Promise<void> };
    setActiveLeaf(leaf: unknown, params: { focus: boolean }): void;
    activeEditor: { editor?: { cm: CM } } | null;
  };
  metadataCache: {
    getFileCache(file: unknown): Record<string, unknown> | null;
  };
  plugins: {
    plugins: Record<
      string,
      {
        reviewManager: {
          repo: { query(sql: string): Record<string, unknown>[] };
        };
      }
    >;
  };
};
type CM = {
  state: {
    doc: { toString(): string };
    selection: { main: { anchor: number; head: number } };
  };
  dispatch(spec: { selection: { anchor: number; head: number } }): void;
};

/** Make a note of `text` and open it in a tab of its own, active. */
const openNewNote = (page: Page, path: string, text: string) =>
  page.evaluate(
    async ([path, text]) => {
      const { app } = window as unknown as { app: PageApp };
      const file = await app.vault.create(path, text);
      const leaf = app.workspace.getLeaf('tab');
      await leaf.openFile(file);
      app.workspace.setActiveLeaf(leaf, { focus: true });
    },
    [path, text] as const
  );

// #endregion

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('child-start');
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
 * What Obsidian 1.13.7 was seen to read, which `Markdown.escapeCutStart`
 * relies on. Should an update change it, these fail.
 */
test("reads syntax at a note's start as escaping it from mid-line relies on", async () => {
  const tags = async (text: string) =>
    ((await readMarkdown(window, text)).cache.found.tags ?? []) as unknown[];
  // Reading view and the cache start a tag after an escape, so an escape
  // makes what follows it a tag
  expect(await tags(String.raw`\##tag`)).toHaveLength(1);
  expect(await tags(String.raw`\>#tag`)).toHaveLength(1);
  // A `#` before a `#` or a number starts none at a line's start
  expect(await tags('##tag')).toHaveLength(0);
  expect(await tags('#1 x')).toHaveLength(0);
  // Math opens after a letter as at a line's start, so a `$` cut from after
  // one changes nothing
  for (const text of ['US$5 and 6$ x', '$5 and 6$ x']) {
    expect((await readMarkdown(window, text)).reading.syntax[0]).toMatch(
      /math/
    );
  }
  // Escaping its first char is enough to end a block
  for (const text of [
    String.raw`\~~~` + '\ncode',
    '\\```\ncode',
    String.raw`\***`,
    String.raw`\___`,
    String.raw`\[a]: https://e.x`,
    String.raw`\[^1]: x`,
  ]) {
    const { reading, cache } = await readMarkdown(window, text);
    expect(reading.blocks.map(({ tag }) => tag)).toEqual(['P']);
    expect(cache.sections).toEqual(['paragraph']);
  }
});

test.describe('Snippets and cards of an ordinary note, from mid-line', () => {
  const LINES = [
    'word#evil',
    'see #tag',
    'a > quote',
    'x - item',
    'a 1. list',
    'C# and x',
  ];

  test.beforeEach(async () => {
    await setDefaultEditingMode(window, 'source');
    await openNewNote(window, 'Cut start.md', LINES.join('\n'));
  });
});

/*
 * What Obsidian 1.13.7 was seen to read in code, math, comments and under
 * a line, which `Markdown.escapeCutStart` and `escapeCutUnderline` rely on.
 */
test('reads tags in spans, and underlines, as escaping a cut start relies on', async () => {
  const read = async (text: string) => {
    const { reading, cache, live } = await readMarkdown(window, text);
    return {
      syntax: reading.syntax,
      tags: ((cache.found.tags ?? []) as { tag: string }[]).map(
        ({ tag }) => tag
      ),
      headings: ((cache.found.headings ?? []) as unknown[]).length,
      sections: cache.sections,
      // Undocumented: live preview's class for a heading's line
      liveHeading: live.classes.some((name) => /^cm-header-\d$/.test(name)),
    };
  };
  // Quote and list markers nest before a fence in any order and depth, and
  // a list item's lines may indent their `>`
  for (const text of [
    '- > ```\n  > see #tag\n  > ```',
    '1.  > ```\n    > x #tag',
    '- > - ```\n  >   x #tag',
  ]) {
    expect((await read(text)).tags).toEqual([]);
  }
  // CommonMark's type-6 tags interrupt a paragraph with an HTML block, which
  // holds the lines after it; one that starts a paragraph is underlined
  expect(await read('a\n<div>\nfoo\n---')).toMatchObject({ headings: 0 });
  expect(await read('a\n<table>\nfoo\n---')).toMatchObject({ headings: 0 });
  expect(await read('a\n<span>\nfoo\n---')).toMatchObject({
    sections: ['paragraph', 'thematicBreak'],
  });
  expect(await read('<div>x y\n---')).toMatchObject({ headings: 1 });
  // Live preview underlines a paragraph of any length, of its own lines
  expect(await read('x foo\nbar\n---')).toMatchObject({
    headings: 0,
    liveHeading: true,
  });
  expect(await read('- x foo\nbar\n---')).toMatchObject({
    headings: 0,
    liveHeading: false,
  });
  expect(await read('foo\nbar\n\n---')).toMatchObject({ liveHeading: false });
  // A lone `-` under more than one line is a list there; an indented
  // underline still one
  expect(await read('foo\nbar x\n-')).toMatchObject({ liveHeading: false });
  expect(await read('milk\n  ---')).toMatchObject({
    headings: 0,
    liveHeading: true,
  });
  // A paragraph after a heading's line is underlined as one of its own
  expect(await read('# h foo\nbar\n---')).toMatchObject({ headings: 2 });
  expect(await read('foo\n\nbar\n---')).toMatchObject({ headings: 1 });
  // Type-6 tags of any case; a `>` past three columns of indent is a
  // quote only in a list item
  expect(await read('a\n<DIV>\nfoo\n---')).toMatchObject({ headings: 0 });
  expect((await read('    > ```\n> x #b')).tags).toEqual(['#b']);
  expect((await read('1.  > ```\n    > x #t')).tags).toEqual([]);
  // Inline code, math and HTML comments hold no tag; cut from its `#`, a
  // tag is one. The span opened first holds the rest
  for (const text of [
    '`see #tag`',
    '$a #b c$',
    '$$a #b$$',
    '$a `#b` c$',
    'a <!-- #b --> c',
    // A line that opens with a comment is an HTML block, to its end
    '<!-- `x --> #b`',
  ]) {
    expect((await read(text)).tags).toEqual([]);
  }
  for (const text of ['#tag`', '#b c$', '#b -->', '`<!--` #b -->']) {
    expect((await read(text)).tags).toHaveLength(1);
  }
  // The cache reads a tag in a `%%` comment, though reading view hides it
  expect(await read('%% see #x %%')).toMatchObject({
    tags: ['#x'],
    syntax: [],
  });
  // Math never opens before a space, nor closes after one or before a digit
  for (const text of ['$ a #b$', '$a #b $', '$x #b$1']) {
    expect((await read(text)).tags).toEqual(['#b']);
  }
  // Escaped, the start forms nothing
  expect(await read(String.raw`\#tag` + '`')).toMatchObject({
    tags: [],
    syntax: [],
  });
  expect((await read(String.raw`\$b$c` + '`')).syntax).toEqual([]);
  // Only a paragraph of one line is underlined into a heading, by `-` or
  // `=` alone; one under a heading so made is one too
  expect(await read('milk\n-')).toMatchObject({ headings: 1 });
  expect(await read('milk\n==')).toMatchObject({ headings: 1 });
  expect(await read('a\n-\nfoo x\n---')).toMatchObject({ headings: 2 });
  for (const text of ['foo\nbar x\n---', 'milk\n---  ']) {
    expect(await read(text)).toMatchObject({
      headings: 0,
      sections: ['paragraph', 'thematicBreak'],
    });
  }
  expect(await read('- buy milk\n---')).toMatchObject({
    headings: 0,
    sections: ['list', 'thematicBreak'],
  });
  expect(await read('# T x\n===')).toMatchObject({
    headings: 1,
    sections: ['heading', 'paragraph'],
  });
  // A tab after it makes no rule, but a list's text
  expect(await read('- milk\n---\t')).toMatchObject({
    headings: 0,
    sections: ['list'],
  });
  // A comment alone on its line ends a paragraph above it, and is still
  // underlined as one
  expect(await read('a\n<!-- c -->\nfoo\n---')).toMatchObject({ headings: 1 });
  expect(await read('<!-- c -->\n---')).toMatchObject({ headings: 1 });
  expect(await read('<!-- c -->\nfoo\n---')).toMatchObject({ headings: 1 });
  expect(await read('<!-- c --> foo\n---')).toMatchObject({ headings: 1 });
  // After list or quote markers, a comment opens an HTML block too
  for (const text of ['- <!-- c --> #tag', '> <!-- c --> #tag']) {
    expect((await read(text)).tags).toEqual([]);
  }
  // The cache takes no underline under an empty list item
  expect(await read('# h\n-\nfoo\n---')).toMatchObject({ headings: 1 });
  // A fence closes only in its own quote or list item, unindented as code;
  // a line out of the item ends it, and may open another
  for (const text of [
    '```\n> ```\nx #tag\n```',
    '```\n    ```\nx #tag\n```',
    '- ```\n  x #t\n```\ny #u',
    `\`\`\`${String.fromCharCode(0x2028)}x\nfoo #t`,
  ]) {
    expect((await read(text)).tags).toEqual([]);
  }
  for (const text of ['> ```\n> x\n> ```\ny #t', '```\n  ```\ny #t']) {
    expect((await read(text)).tags).toEqual(['#t']);
  }
  // A blank line keeps a rule one, and an escape makes text of the rest
  expect(await read('milk\n\n---')).toMatchObject({
    headings: 0,
    sections: ['paragraph', 'thematicBreak'],
  });
  for (const text of [
    'milk\n' + String.raw`\---`,
    'milk\n' + String.raw`\===`,
    'milk\n' + String.raw`\-`,
  ]) {
    expect(await read(text)).toMatchObject({
      headings: 0,
      sections: ['paragraph'],
    });
  }
});

test.describe('Snippets and cards of an ordinary note, from inside a span or over an underline', () => {
  const BLOCKS = [
    '`see #tag` x',
    '$a #b c$',
    '%% see #x %%',
    'a <!-- #h --> y',
    '```\nsee #code\n```',
    '- buy milk\n---',
    '# Title part\n===',
    '> q x\n---',
    'foo bar\n---',
    'foo\nbar\n---',
  ];

  test.beforeEach(async () => {
    await setDefaultEditingMode(window, 'source');
    await openNewNote(window, 'Spans.md', BLOCKS.join('\n\n'));
  });
});

test.describe('Snippets and cards of an ordinary note, from a fence nested in a list, over a longer paragraph or by an HTML block', () => {
  const BLOCKS = [
    '- > ```\n  > see #fen\n  > ```',
    '- > ```\n  > see #fec x\n  > ```',
    '- x lp\nbar\n---',
    '- y qr\nbar\n===\n===',
    '- z cd\nbar\n---',
    'a\n<div>\nh6 hb\n---',
    'b\n<p>\nh6 hc\n---',
    '# h hd\nhe\n---',
  ];

  test.beforeEach(async () => {
    await setDefaultEditingMode(window, 'source');
    await openNewNote(window, 'Nested.md', BLOCKS.join('\n\n'));
  });
});
