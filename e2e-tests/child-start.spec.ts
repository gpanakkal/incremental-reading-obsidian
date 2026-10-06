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
 * relies on (task 0043's probe). Should an update change it, these fail.
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
