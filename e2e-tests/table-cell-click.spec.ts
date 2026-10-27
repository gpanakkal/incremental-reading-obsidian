import { POSITIONS_KEY } from '#/lib/reading-positions';
import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  executeCommandById,
  expectExtractSettled,
  importArticle,
  scrollToText,
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

type EditorPos = { line: number; ch: number };

/** The slice of Obsidian's `window.app` this test reaches into. */
type TableTestWindow = {
  app: {
    workspace: {
      activeEditor: {
        editor?: {
          getValue(): string;
          scrollTo(x: number, y: number): void;
          scrollIntoView(
            range: { from: EditorPos; to: EditorPos },
            center?: boolean
          ): void;
        };
      } | null;
      getActiveFile(): { path: string } | null;
      getLeavesOfType(type: string): {
        view: { file?: { path: string } | null };
        detach(): void;
      }[];
      getLeaf(type: 'tab'): { openFile(file: unknown): Promise<void> };
    };
    vault: { getFileByPath(path: string): unknown };
    metadataCache: {
      getFileCache(file: unknown): {
        frontmatter?: Record<string, unknown>;
      } | null;
    };
    loadLocalStorage(key: string): unknown;
  };
};

/** A note long enough that its table can sit mid-view. */
const NOTE = 'testing/Table scroll';

/** A note short enough that all of it, highlights and all, is on screen. */
const SHORT_NOTE = 'testing/Table snippets';

/** `count` paragraphs of text, each told apart by `label` and its number. */
const paragraphs = (label: string, count: number) =>
  Array.from(
    { length: count },
    (_, i) => `${label} paragraph ${i + 1}: lorem ipsum dolor sit amet.`
  ).join('\n\n');

const TABLE =
  '| Name | Value |\n| --- | --- |\n| Spaced repetition | one |\n| beta | two |\n| gamma | three |';

/** The text of a note with `count` paragraphs either side of the table. */
const noteText = (count: number) =>
  [paragraphs('Before', count), TABLE, paragraphs('After', count)].join('\n\n');

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('table-cell');
  await fs.writeFile(path.join(vaultPath, `${NOTE}.md`), noteText(40));
  await fs.writeFile(path.join(vaultPath, `${SHORT_NOTE}.md`), noteText(3));
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

/** The note tab that is active: its editor's scroller. */
const SCROLLER =
  '.workspace-leaf.mod-active [data-type="markdown"] .markdown-source-view .cm-scroller';

const scrollTop = () =>
  window.evaluate(
    (selector) => document.querySelector<HTMLElement>(selector)?.scrollTop ?? 0,
    SCROLLER
  );

/**
 * The reading position this device holds for the item `id`, or 0 while it
 * holds none.
 *
 * Unofficial: `window.app`. `loadLocalStorage` is API.
 */
const heldPosition = (id: string) =>
  window.evaluate(
    ([itemId, key]) => {
      const { app } = window as unknown as TableTestWindow;
      const entries = app.loadLocalStorage(key) as Record<
        string,
        { position?: number }
      > | null;
      return entries?.[itemId]?.position ?? 0;
    },
    [id, POSITIONS_KEY] as const
  );

/**
 * How far a scroll may move on a click, in px: a caret placed in a cell can
 * nudge the view by a row at most; the bug moved it by half a screen.
 */
const MAX_CLICK_SCROLL_PX = 30;

/** Import a note as an article: its path once imported, and its id. */
async function importNote(note: string) {
  await importArticle(window, note);
  let notePath = '';
  let id = '';
  await expect
    .poll(async () => {
      [notePath, id] = await window.evaluate(() => {
        const { app } = window as unknown as TableTestWindow;
        const file = app.workspace.getActiveFile();
        const irId = file
          ? app.metadataCache.getFileCache(file)?.frontmatter?.['ir-id']
          : undefined;
        return [file?.path ?? '', typeof irId === 'string' ? irId : ''];
      });
      return id;
    })
    .not.toBe('');
  return { notePath, id };
}

test('clicking a table cell in an article with a reading position leaves the scroll where it was', async () => {
  // Pinned so the table's place mid-view is the same headless and in CI
  await window.setViewportSize({ width: 1024, height: 768 });
  const { notePath, id } = await importNote(NOTE);

  // Reopened, so the tab's editor keeps a reading position for the article:
  // a new tab on it, then the one it was imported in closed
  await window.evaluate(async (p) => {
    const { app } = window as unknown as TableTestWindow;
    const stale = app.workspace
      .getLeavesOfType('markdown')
      .filter((leaf) => leaf.view.file?.path === p);
    const file = app.vault.getFileByPath(p);
    if (!file) throw new Error(`Cannot open ${p}`);
    await app.workspace.getLeaf('tab').openFile(file);
    for (const leaf of stale) leaf.detach();
  }, notePath);
  const scroller = window.locator(SCROLLER);
  await expect(scroller).toBeVisible();

  // The table halfway down the screen. The scroll listener goes on once the
  // mount-time restore has run, so scroll until one is kept.
  const table = scroller.locator('.cm-table-widget');
  await expect(async () => {
    // From the top each time, so every try is a scroll the listener can see.
    // `Editor.scrollTo` and `scrollIntoView` are API; `activeEditor` is too.
    await window.evaluate(async () => {
      const { editor } =
        (window as unknown as TableTestWindow).app.workspace.activeEditor ?? {};
      if (!editor) throw new Error('No note editor');
      const line = editor
        .getValue()
        .split('\n')
        .findIndex((text) => text.startsWith('| Name'));
      const at = { line, ch: 0 };
      editor.scrollTo(0, 0);
      await new Promise(requestAnimationFrame);
      editor.scrollIntoView({ from: at, to: at }, true);
    });
    await expect(table).toBeInViewport();
    await expect
      .poll(() => heldPosition(id), { timeout: 2000 })
      .toBeGreaterThan(0);
  }).toPass({ timeout: 30_000 });

  // Until the scroll comes to rest
  let last = '';
  await expect
    .poll(async () => {
      const now = JSON.stringify([await heldPosition(id), await scrollTop()]);
      const settled = now === last;
      last = now;
      return settled;
    })
    .toBe(true);
  const before = await scrollTop();
  expect(before).toBeGreaterThan(0);

  // Record every scroll from the click on, in the page: the cell editor's
  // restore ran two frames and 300 ms after it, and only the largest move
  // over that window says whether it ran.
  await window.evaluate((selector) => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) throw new Error('No note editor on screen');
    const start = el.scrollTop;
    const diag = { maxDrift: 0 };
    (window as unknown as { __diag: typeof diag }).__diag = diag;
    el.addEventListener('scroll', () => {
      diag.maxDrift = Math.max(diag.maxDrift, Math.abs(el.scrollTop - start));
    });
  }, SCROLLER);

  await table.locator('td').nth(1).click();
  await expect(table.locator('td .cm-editor').first()).toBeVisible();

  // Absence of a scroll can only be shown by watching for one: give the
  // restore three times its delay to show up.
  const maxDrift = await window.evaluate(
    () =>
      new Promise<number>((resolve) => {
        setTimeout(
          () =>
            resolve(
              (window as unknown as { __diag: { maxDrift: number } }).__diag
                .maxDrift
            ),
          1000
        );
      })
  );
  expect(maxDrift).toBeLessThanOrEqual(MAX_CLICK_SCROLL_PX);
  expect(Math.abs((await scrollTop()) - before)).toBeLessThanOrEqual(
    MAX_CLICK_SCROLL_PX
  );
});

/** Snippets made from the note: one before the table, one after it. */
const BEFORE_TABLE = 'Before';
const AFTER_TABLE = 'After paragraph 2: lorem ipsum';

/** Where the open table cell's editor is. */
const CELL_EDITOR = 'td .cm-editor';

/** The slice of the `Editor` API the snippets are selected with. */
type SelectingWindow = {
  app: {
    workspace: {
      activeEditor: {
        editor: {
          getValue(): string;
          offsetToPos(offset: number): unknown;
          setSelection(from: unknown, to: unknown): void;
        };
      };
    };
  };
};

test("a table cell's editor paints no highlights, and an edit in it leaves the note's in place", async () => {
  await window.setViewportSize({ width: 1024, height: 768 });
  const { notePath } = await importNote(SHORT_NOTE);

  // Unofficial: `window.app`. `activeEditor`, `Editor.setSelection` and
  // `offsetToPos` are API.
  for (const [i, text] of [BEFORE_TABLE, AFTER_TABLE].entries()) {
    await scrollToText(window, text);
    await window.evaluate((text) => {
      const { editor } = (window as unknown as SelectingWindow).app.workspace
        .activeEditor;
      const at = editor.getValue().indexOf(text);
      editor.setSelection(
        editor.offsetToPos(at),
        editor.offsetToPos(at + text.length)
      );
    }, text);
    await executeCommandById(window, 'incremental-reading:extract-selection');
    await expectExtractSettled(window, notePath, i + 1);
  }

  const pastEndWarnings: string[] = [];
  window.on('console', (message) => {
    if (/reaches past the end/.test(message.text())) {
      pastEndWarnings.push(message.text());
    }
  });

  const scroller = window.locator(SCROLLER);
  await scrollToText(window, '| Name');
  const cell = scroller.locator('.cm-table-widget td', {
    hasText: 'Spaced repetition',
  });
  await cell.click();
  await expect(cell.locator('.cm-editor')).toBeVisible();

  /** The text the note's highlights paint on screen, outside any cell. */
  const paintedOutsideCells = () =>
    window.evaluate(
      ([selector, cellEditor]) =>
        Array.from(
          document
            .querySelector(selector)
            ?.querySelectorAll<HTMLElement>('.ir-snippet-highlight') ?? []
        )
          .filter((el) => !el.closest(cellEditor))
          .map((el) => el.textContent ?? '')
          .join(''),
      [SCROLLER, CELL_EDITOR] as const
    );

  // The cell editor's highlights loaded asynchronously when it drew them:
  // their absence can only be shown by giving them time to appear.
  await window.evaluate(
    () => new Promise((resolve) => setTimeout(resolve, 1000))
  );
  await expect(
    scroller.locator(`${CELL_EDITOR} .ir-snippet-highlight`)
  ).toHaveCount(0);
  expect(pastEndWarnings).toEqual([]);
  await expect.poll(paintedOutsideCells).toBe(BEFORE_TABLE + AFTER_TABLE);

  // One character typed into the cell moves the note's text after the table
  // by one, and its highlight with it, once
  await window.keyboard.press('End');
  await window.keyboard.type('X');
  await expect(cell.locator('.cm-editor')).toContainText('Spaced repetitionX');
  await expect.poll(paintedOutsideCells).toBe(BEFORE_TABLE + AFTER_TABLE);
});
