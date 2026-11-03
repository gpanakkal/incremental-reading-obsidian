import test, {
  expect,
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
  vault: { getFileByPath(path: string): unknown };
  workspace: {
    getLeaf(newLeaf: 'tab'): {
      openFile(file: unknown, state?: unknown): Promise<void>;
    };
    setActiveLeaf(leaf: unknown, params: { focus: boolean }): void;
    getMostRecentLeaf(): {
      view: {
        containerEl: HTMLElement;
        getViewData(): string;
        currentMode: { applyScroll(line: number): void };
      };
    } | null;
    getActiveFile(): { path: string } | null;
    activeEditor: {
      editor?: {
        cm: {
          state: { doc: { toString(): string } };
          dispatch(spec: {
            selection?: { anchor: number; head: number };
            changes?: { from: number; insert: string };
            scrollIntoView?: boolean;
          }): void;
        };
      };
    } | null;
  };
};

const NOTE = 'testing/block-examples.md';
const LINE = 'a^2 + b^2 = c^2';
const BLOCK = String.raw`$$
a^2 + b^2 = c^2
\quad\text{and}\quad
e^{i\pi} + 1 = 0
$$`;
const NEIGHBOUR = 'Line after the math block';

/** Open the note in a tab of its own, active, in `mode`. */
const openNote = (page: Page, mode: 'source' | 'preview' = 'source') =>
  page.evaluate(
    async ([path, mode]) => {
      const { app } = window as unknown as { app: PageApp };
      const leaf = app.workspace.getLeaf('tab');
      // Undocumented: the view state of live preview and reading view
      await leaf.openFile(app.vault.getFileByPath(path), {
        active: true,
        state: { mode },
      });
      app.workspace.setActiveLeaf(leaf, { focus: true });
    },
    [NOTE, mode] as const
  );

/**
 * Select `text` in the active editor, from `from` to `to` within it, and
 * scroll there: live preview draws only the lines in view. Found and
 * selected at once, as the note's frontmatter can change between two calls.
 * Returns where `text` is, or -1.
 */
const selectIn = (page: Page, text: string, from = 0, to = text.length) =>
  page.evaluate(
    ([text, from, to]) => {
      const { app } = window as unknown as { app: PageApp };
      const { cm } = app.workspace.activeEditor!.editor!;
      const at = cm.state.doc.toString().indexOf(text);
      if (at >= 0) {
        cm.dispatch({
          selection: { anchor: at + from, head: at + to },
          scrollIntoView: true,
        });
      }
      return at;
    },
    [text, from, to] as const
  );

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
  expect(await selectIn(page, text)).toBeGreaterThan(-1);
  await executeCommandById(page, 'incremental-reading:extract-selection');
  return snippetNotes(page, count);
}

/**
 * Scroll the reading view in the active tab to the line holding `text`, until
 * its math is drawn. Reading view draws only the sections near the screen, so
 * math further down the note has no rendering at all until it is scrolled to;
 * and a scroll made while the view is still opening is undone by its own.
 */
const scrollReadingTo = (page: Page, text: string) =>
  expect
    .poll(() =>
      page.evaluate((text) => {
        const { app } = window as unknown as { app: PageApp };
        const { view } = app.workspace.getMostRecentLeaf()!;
        const data = view.getViewData();
        const line = data.slice(0, data.indexOf(text)).split('\n').length - 1;
        view.currentMode.applyScroll(line);
        return view.containerEl.querySelectorAll(
          '.markdown-preview-view .math-block'
        ).length;
      }, text)
    )
    .toBeGreaterThan(0);

/**
 * Put the cursor on the line after the math, out of it, and the math on
 * screen: live preview draws only the lines in view.
 */
const cursorAfterMath = (page: Page) => selectIn(page, NEIGHBOUR, 0, 0);

/** Type `insert` right after `text` in the active editor, the cursor there. */
const typeAfter = (page: Page, text: string, insert: string) =>
  page.evaluate(
    ([text, insert]) => {
      const { app } = window as unknown as { app: PageApp };
      const { cm } = app.workspace.activeEditor!.editor!;
      const at = cm.state.doc.toString().indexOf(text) + text.length;
      cm.dispatch({ changes: { from: at, insert } });
      cm.dispatch({
        selection: { anchor: at + insert.length, head: at + insert.length },
      });
    },
    [text, insert] as const
  );

const activePath = (page: Page) =>
  page.evaluate(() => {
    const { app } = window as unknown as { app: PageApp };
    return app.workspace.getActiveFile()?.path ?? null;
  });

const leafEl = (page: Page) => page.locator('.workspace-leaf.mod-active');
const livePreviewMath = (page: Page) =>
  leafEl(page).locator('.markdown-source-view .cm-embed-block.math-block');
const readingMath = (page: Page) =>
  leafEl(page).locator('.markdown-preview-view .math-block');

/** The length of the text of the formula and of its marked part. */
const markedShare = (math: ReturnType<typeof livePreviewMath>) =>
  math.evaluate((el) => ({
    formula: el.querySelector('mjx-container')!.textContent.length,
    marked: Array.from(
      el.querySelectorAll('mjx-container .ir-snippet-highlight'),
      (mark) => mark.textContent
    ).join('').length,
  }));

// #endregion

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('math-hl');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
  // CI's window is this small and local ones are far larger: pinned, the math
  // starts off screen everywhere, so every run scrolls to it the same way.
  await window.setViewportSize({ width: 1024, height: 768 });
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
  if (shouldCleanup) {
    await fs
      .rm(vaultPath, { recursive: true, force: true, maxRetries: 3 })
      .catch(() => {});
  }
});

test('shows a snippet cut from one line of a math block on that line of the rendered math', async () => {
  await setDefaultEditingMode(window, 'live-preview');
  await openNote(window);
  const [neighbour] = await extract(window, NEIGHBOUR, 1);
  const snippet = (await extract(window, LINE, 2)).find((n) => n !== neighbour);
  await cursorAfterMath(window);

  // Live preview: a mark inside the rendered math, over part of it only
  const math = livePreviewMath(window);
  await expect(math.locator('mjx-container .ir-snippet-highlight')).toHaveCount(
    1
  );
  await expect(math.locator('mjx-container.ir-snippet-highlight')).toHaveCount(
    0
  );
  const live = await markedShare(math);
  expect(live.marked).toBeGreaterThan(0);
  expect(live.marked).toBeLessThan(live.formula);
  // The neighbouring line's own mark is still there
  await expect(
    leafEl(window).locator('.cm-line .ir-snippet-highlight', {
      hasText: NEIGHBOUR,
    })
  ).toHaveCount(1);

  // A click on the mark is the math's, as before: no snippet opens
  await math.locator('mjx-container .ir-snippet-highlight').click();
  await expect.poll(() => activePath(window)).toBe(NOTE);

  // The cursor in the math shows its source, marked; out of it, the
  // rendered math shows its mark again
  await selectIn(window, LINE, 2, 2);
  // Split by the source's own highlighting into a mark per token
  await expect(
    leafEl(window)
      .locator('.cm-line', { hasText: LINE })
      .locator('.ir-snippet-highlight')
      .first()
  ).toBeVisible();
  // The preview Obsidian draws below the source carries the mark too
  const preview = livePreviewMath(window);
  await expect(
    preview.locator('mjx-container .ir-snippet-highlight')
  ).toHaveCount(1);
  expect((await markedShare(preview)).marked).toBe(live.marked);
  // Out of the math, its one rendering shows the mark once
  await cursorAfterMath(window);
  await expect(livePreviewMath(window)).toHaveCount(1);
  await expect(math.locator('mjx-container .ir-snippet-highlight')).toHaveCount(
    1
  );

  // Reading view: the same part marked, opening the snippet on a click
  await openNote(window, 'preview');
  await scrollReadingTo(window, LINE);
  const reading = readingMath(window);
  await expect(
    reading.locator('mjx-container .ir-snippet-highlight')
  ).toHaveCount(1);
  const read = await markedShare(reading);
  expect(read.marked).toBe(live.marked);
  await expect(
    leafEl(window).locator('.markdown-preview-view p .ir-snippet-highlight', {
      hasText: NEIGHBOUR,
    })
  ).toHaveCount(1);
  await reading.locator('mjx-container .ir-snippet-highlight').click();
  await expect.poll(() => activePath(window)).toBe(snippet);
});

test('shows a snippet over a whole math block on the whole rendered math', async () => {
  await setDefaultEditingMode(window, 'live-preview');
  await openNote(window);
  await extract(window, BLOCK, 1);
  await cursorAfterMath(window);

  await expect(
    livePreviewMath(window).locator('mjx-container.ir-snippet-highlight')
  ).toHaveCount(1);
  await expect(
    livePreviewMath(window).locator('mjx-container .ir-snippet-highlight')
  ).toHaveCount(0);

  await openNote(window, 'preview');
  await scrollReadingTo(window, LINE);
  await expect(
    readingMath(window).locator('mjx-container.ir-snippet-highlight')
  ).toHaveCount(1);
});

test('keeps the mark on the preview below the math as the math is typed in', async () => {
  await setDefaultEditingMode(window, 'live-preview');
  await openNote(window);
  await extract(window, LINE, 1);
  await cursorAfterMath(window);
  await expect(
    livePreviewMath(window).locator('mjx-container .ir-snippet-highlight')
  ).toHaveCount(1);
  const live = await markedShare(livePreviewMath(window));
  await selectIn(window, LINE, 2, 2);
  const preview = livePreviewMath(window);
  await typeAfter(window, '+ 1 = 0', ' + x');
  await expect(
    preview.locator('mjx-container .ir-snippet-highlight')
  ).toHaveCount(1);
  const typed = await markedShare(preview);
  expect(typed.marked).toBe(live.marked);
  expect(typed.formula).toBeGreaterThan(live.formula);
  await cursorAfterMath(window);
  await expect(livePreviewMath(window)).toHaveCount(1);
  await expect(
    livePreviewMath(window).locator('mjx-container .ir-snippet-highlight')
  ).toHaveCount(1);
});
