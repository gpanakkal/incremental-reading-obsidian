import { CLOZE_DELIMITERS } from '#/lib/constants';
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

const [LEFT, RIGHT] = CLOZE_DELIMITERS;

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

/**
 * Select in the active editor from `from` past the start of the line `line`
 * to that line's end, in its state, and fail if the editor moves it.
 * `editor.cm`, the CodeMirror view, is undocumented Obsidian API.
 */
const selectToLineEnd = (page: Page, line: string, from: number) =>
  page.evaluate(
    async ([line, from]) => {
      const { app } = window as unknown as { app: PageApp };
      const cm = app.workspace.activeEditor?.editor?.cm;
      const at = cm?.state.doc.toString().indexOf(line) ?? -1;
      if (!cm || at < 0) throw new Error(`No editor holds ${line}`);
      cm.dispatch({
        selection: { anchor: at + from, head: at + line.length },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const { anchor, head } = cm.state.selection.main;
      if (anchor !== at + from || head !== at + line.length) {
        throw new Error(`Selection moved to ${anchor}-${head}`);
      }
    },
    [line, from] as const
  );

/**
 * The body of the note of each row of `table`, and what the metadata cache
 * finds in it, once it has read the note's frontmatter.
 */
const children = (page: Page, table: 'snippet' | 'srs_card') =>
  page.evaluate(async (table) => {
    const { app } = window as unknown as { app: PageApp };
    // Undocumented: `app.plugins`, Obsidian's plugin registry
    const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
    return Promise.all(
      repo.query(`SELECT reference FROM ${table}`).map(async (row) => {
        const file = app.vault.getFileByPath(row.reference as string);
        const note = file ? await app.vault.cachedRead(file) : '';
        const cache: Record<string, unknown> =
          (file ? app.metadataCache.getFileCache(file) : null) ?? {};
        const found = (key: string) =>
          ((cache[key] ?? []) as { tag?: string }[]).map(
            (entry) => entry.tag ?? key
          );
        return {
          body: note.replace(/^---\n[\s\S]*?\n---\n/, '').trim(),
          read: 'frontmatter' in cache,
          tags: found('tags'),
          headings: found('headings'),
          listItems: found('listItems'),
          sections: ((cache.sections ?? []) as { type: string }[]).map(
            ({ type }) => type
          ),
        };
      })
    );
  }, table);

/** The child of `table` whose body is `body`, once the cache has read it. */
async function child(page: Page, table: 'snippet' | 'srs_card', body: string) {
  await expect
    .poll(async () =>
      (await children(page, table)).some(
        (note) => note.body === body && note.read
      )
    )
    .toBe(true);
  return (await children(page, table)).find((note) => note.body === body)!;
}

/**
 * Make a card of the text the active note holds as `block`, from `from` to
 * its end, its answer at `answer` in that span, as selection mode makes one.
 */
const cardFrom = (
  page: Page,
  block: string,
  from: number,
  answer: [number, number]
) =>
  page.evaluate(
    async ([block, from, answer]) => {
      const { app } = window as unknown as {
        app: PageApp & {
          workspace: { activeEditor: { editor: { getValue(): string } } };
          plugins: {
            plugins: Record<
              string,
              {
                // Undocumented: the plugin's actions, as its commands and
                // selection mode reach them
                actions: {
                  createCard(fromSelection: {
                    selection: { from: number; to: number; text: string };
                    answer: [number, number];
                  }): Promise<unknown>;
                };
              }
            >;
          };
        };
      };
      const doc = app.workspace.activeEditor.editor.getValue();
      const at = doc.indexOf(block);
      if (at < 0) throw new Error(`No editor holds ${block}`);
      const text = block.slice(from);
      await app.plugins.plugins['incremental-reading'].actions.createCard({
        selection: { from: at + from, to: at + block.length, text },
        answer,
      });
    },
    [block, from, answer] as const
  );

/**
 * Whether live preview shows a heading in `text`. Undocumented: its
 * `cm-header-N` class for a heading's line.
 */
const liveHeading = async (page: Page, text: string) =>
  (await readMarkdown(page, text)).live.classes.some((name) =>
    /^cm-header-\d$/.test(name)
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

  test('makes a snippet of no tag, heading, quote or list the note did not show there, and keeps a tag it did', async () => {
    const cuts: [string, number][] = [
      ['word#evil', 4],
      ['see #tag', 4],
      ['a > quote', 2],
      ['x - item', 2],
      ['a 1. list', 2],
      ['C# and x', 1],
    ];
    for (const [line, from] of cuts) {
      await selectToLineEnd(window, line, from);
      await executeCommandById(window, 'incremental-reading:extract-selection');
    }

    const plain = { tags: [], headings: [], listItems: [] };
    expect(await child(window, 'snippet', String.raw`\#evil`)).toMatchObject({
      ...plain,
      sections: ['yaml', 'paragraph'],
    });
    expect(await child(window, 'snippet', '#tag')).toMatchObject({
      tags: ['#tag'],
    });
    for (const body of [
      String.raw`\> quote`,
      String.raw`\- item`,
      String.raw`1\. list`,
      String.raw`\# and x`,
    ]) {
      expect(await child(window, 'snippet', body)).toMatchObject({
        ...plain,
        sections: ['yaml', 'paragraph'],
      });
    }
  });

  test('makes a card of no tag, quote or list where its answer starts that the note did not show, and keeps a tag it did', async () => {
    const cuts: [string, number][] = [
      ['word#evil', 4],
      ['see #tag', 4],
      ['a > quote', 2],
      ['x - item', 2],
      ['a 1. list', 2],
    ];
    for (const [line, from] of cuts) {
      await selectToLineEnd(window, line, from);
      await executeCommandById(window, 'incremental-reading:create-card');
    }

    const plain = {
      tags: [],
      headings: [],
      listItems: [],
      sections: ['yaml', 'paragraph'],
    };
    expect(
      await child(window, 'srs_card', String.raw`word${LEFT} \#evil ${RIGHT}`)
    ).toMatchObject(plain);
    expect(
      await child(window, 'srs_card', `see ${LEFT} #tag ${RIGHT}`)
    ).toMatchObject({ tags: ['#tag'] });
    // After a cloze delimiter, no marker starts its line
    for (const body of [
      `a ${LEFT} > quote ${RIGHT}`,
      `x ${LEFT} - item ${RIGHT}`,
      `a ${LEFT} 1. list ${RIGHT}`,
    ]) {
      expect(await child(window, 'srs_card', body)).toMatchObject(plain);
    }
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

  test('makes a snippet of no tag from inside inline code, math, an HTML comment or a code block, keeps a `%%` comment tag, and makes no heading the note did not show', async () => {
    const cuts: [string, number][] = [
      ['`see #tag` x', 5],
      ['$a #b c$', 3],
      ['%% see #x %%', 7],
      ['a <!-- #h --> y', 7],
      ['see #code', 4],
      ['- buy milk\n---', 6],
      ['# Title part\n===', 8],
      ['> q x\n---', 4],
      ['foo bar\n---', 4],
      // From the start of a paragraph's second line
      ['foo\nbar\n---', 4],
    ];
    for (const [line, from] of cuts) {
      await selectToLineEnd(window, line, from);
      await executeCommandById(window, 'incremental-reading:extract-selection');
    }

    const plain = { tags: [], headings: [], sections: ['yaml', 'paragraph'] };
    for (const body of [
      String.raw`\#tag` + '` x',
      String.raw`\#b c$`,
      String.raw`\#h --> y`,
      String.raw`\#code`,
      'part\n' + String.raw`\===`,
    ]) {
      expect(await child(window, 'snippet', body)).toMatchObject(plain);
    }
    // A tag in a `%%` comment, which the cache read there too
    expect(await child(window, 'snippet', '#x %%')).toMatchObject({
      tags: ['#x'],
    });
    // A rule under a list item, a quote or a longer paragraph stays a rule
    for (const body of ['milk\n\n---', 'x\n\n---', 'bar\n\n---']) {
      expect(await child(window, 'snippet', body)).toMatchObject({
        ...plain,
        sections: ['yaml', 'paragraph', 'thematicBreak'],
      });
    }
    // The heading the note showed stays one
    expect(await child(window, 'snippet', 'bar\n---')).toMatchObject({
      tags: [],
      headings: ['headings'],
    });
  });

  test('makes a card of a span from inside a span or over an underline of no tag or heading the note did not show', async () => {
    const card = (block: string, from: number, answer: [number, number]) =>
      cardFrom(window, block, from, answer);

    await card('`see #tag` x', 5, [6, 7]);
    await card('$a #b c$', 3, [3, 4]);
    await card('a <!-- #h --> y', 7, [7, 8]);
    await card('see #code', 4, [4, 5]);
    await card('%% see #x %%', 7, [3, 5]);
    await card('- buy milk\n---', 6, [0, 4]);
    await card('# Title part\n===', 8, [0, 4]);
    await card('> q x\n---', 4, [0, 1]);
    // From the start of a paragraph's second line
    await card('foo\nbar\n---', 4, [0, 3]);

    const plain = { tags: [], headings: [], sections: ['yaml', 'paragraph'] };
    for (const body of [
      String.raw`\#tag` + `\` ${LEFT} x ${RIGHT}`,
      String.raw`\#b ${LEFT} c ${RIGHT}$`,
      String.raw`\#h --> ${LEFT} y ${RIGHT}`,
      String.raw`\#cod${LEFT} e ${RIGHT}`,
      `${LEFT} part ${RIGHT}\n` + String.raw`\===`,
    ]) {
      expect(await child(window, 'srs_card', body)).toMatchObject(plain);
    }
    // A tag in a `%%` comment, which the cache read there too
    expect(
      await child(window, 'srs_card', `#x ${LEFT} %% ${RIGHT}`)
    ).toMatchObject({ tags: ['#x'] });
    // A rule under a list item, a quote or a longer paragraph stays a rule
    for (const word of ['milk', 'x', 'bar']) {
      expect(
        await child(window, 'srs_card', `${LEFT} ${word} ${RIGHT}\n\n---`)
      ).toMatchObject({
        ...plain,
        sections: ['yaml', 'paragraph', 'thematicBreak'],
      });
    }
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

  test('makes a snippet and a card of no tag from a fence in a quote in a list, and of no heading the note did not show, in reading view or live preview', async () => {
    const snips: [string, number][] = [
      ['- > ```\n  > see #fen', 16],
      ['- x lp\nbar\n---', 4],
      ['- y qr\nbar\n===\n===', 4],
      ['a\n<div>\nh6 hb\n---', 11],
      // Cut from a heading's text: the paragraph after it keeps its heading
      ['# h hd\nhe\n---', 4],
    ];
    for (const [line, from] of snips) {
      await selectToLineEnd(window, line, from);
      await executeCommandById(window, 'incremental-reading:extract-selection');
    }
    await cardFrom(window, '- > ```\n  > see #fec x', 16, [5, 6]);
    await cardFrom(window, '- z cd\nbar\n---', 4, [0, 2]);
    await cardFrom(window, 'b\n<p>\nh6 hc\n---', 9, [0, 2]);

    for (const [table, body] of [
      ['snippet', String.raw`\#fen`],
      ['srs_card', String.raw`\#fec ${LEFT} x ${RIGHT}`],
    ] as const) {
      expect(await child(window, table, body)).toMatchObject({ tags: [] });
    }
    // An HTML block held the rule's line as text
    for (const [table, body] of [
      ['snippet', 'lp\nbar\n\n---'],
      ['snippet', 'qr\nbar\n' + String.raw`\===` + '\n' + String.raw`\===`],
      ['srs_card', `${LEFT} cd ${RIGHT}\nbar\n\n---`],
      ['snippet', 'hb\n' + String.raw`\---`],
      ['srs_card', `${LEFT} hc ${RIGHT}\n` + String.raw`\---`],
    ] as const) {
      expect(await child(window, table, body)).toMatchObject({
        headings: [],
      });
      expect(await liveHeading(window, body)).toBe(false);
    }
    // `he`, a heading in the note, stays one, apart from `hd`
    expect(await child(window, 'snippet', 'hd\n\nhe\n---')).toMatchObject({
      headings: ['headings'],
    });
  });
});
