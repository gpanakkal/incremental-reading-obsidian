import { POSITIONS_KEY } from '#/lib/reading-positions';
import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import {
  executeCommandById,
  expectExtractSettled,
  importArticle,
  readSnippetState,
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

/** The slice of Obsidian's `window.app` these tests reach into. */
type PositionTestWindow = {
  app: {
    workspace: {
      getActiveFile(): { path: string } | null;
      getLeavesOfType(type: string): {
        view: { file?: { path: string } | null };
        detach(): void;
      }[];
      getMostRecentLeaf(): { openFile(file: unknown): Promise<void> } | null;
    };
    vault: { getFileByPath(path: string): unknown };
    metadataCache: {
      getFileCache(file: unknown): {
        frontmatter?: Record<string, unknown>;
      } | null;
    };
    loadLocalStorage(key: string): unknown;
    saveLocalStorage(key: string, value: unknown): void;
  };
};

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('core');
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

/**
 * The first line with text at the top edge of the active note's editor, and
 * where it sits against that edge, in px.
 */
async function topVisibleLine() {
  return await window.evaluate((selector) => {
    const scroller = document.querySelector<HTMLElement>(selector);
    if (!scroller) return null;
    const top = scroller.getBoundingClientRect().top;
    const line = [...scroller.querySelectorAll('.cm-line')].find(
      (el) =>
        el.getBoundingClientRect().bottom > top + 1 &&
        (el.textContent ?? '').trim() !== ''
    );
    return {
      text: (line?.textContent ?? '').slice(0, 80),
      scrollTop: scroller.scrollTop,
      lineTop: line ? line.getBoundingClientRect().top - top : 0,
    };
  }, SCROLLER);
}

/**
 * The reading position this device holds for the item `id`, or 0 while it
 * holds none. Not a check: what a scroll is waited on by, since nothing on
 * screen says when it has been kept.
 *
 * Unofficial: `window.app`. `loadLocalStorage` is API.
 */
const heldPosition = (id: string) =>
  window.evaluate(
    ([itemId, key]) => {
      const { app } = window as unknown as PositionTestWindow;
      const entries = app.loadLocalStorage(key) as Record<
        string,
        { position?: number }
      > | null;
      return entries?.[itemId]?.position ?? 0;
    },
    [id, POSITIONS_KEY] as const
  );

/**
 * How far the line reading `text` sits below the top edge of the active
 * note's editor, in px, or `null` when no line on screen reads that way.
 */
async function distanceFromTop(text: string) {
  return await window.evaluate(
    ([selector, wanted]) => {
      const scroller = document.querySelector<HTMLElement>(selector);
      if (!scroller) return null;
      const top = scroller.getBoundingClientRect().top;
      const distances = [...scroller.querySelectorAll('.cm-line')]
        .filter((el) => (el.textContent ?? '').slice(0, 80) === wanted)
        .map((el) => el.getBoundingClientRect().top - top);
      if (distances.length === 0) return null;
      return distances.reduce((best, distance) =>
        Math.abs(distance) < Math.abs(best) ? distance : best
      );
    },
    [SCROLLER, text] as const
  );
}

/** Close every tab showing the note at `path`. */
const closeNote = (path: string) =>
  window.evaluate((notePath) => {
    const { app } = window as unknown as PositionTestWindow;
    for (const leaf of app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view.file?.path === notePath) leaf.detach();
    }
  }, path);

/** Open the note at `path` in the most recent tab. */
const openNoteAt = (path: string) =>
  window.evaluate(async (notePath) => {
    const { app } = window as unknown as PositionTestWindow;
    const file = app.vault.getFileByPath(notePath);
    const leaf = app.workspace.getMostRecentLeaf();
    if (!file || !leaf) throw new Error(`Cannot open ${notePath}`);
    await leaf.openFile(file);
  }, path);

/**
 * How far the line the reader left may come back from where it sat, in px:
 * roughly two lines of text, as in `nav.spec.ts` (the anchor's row depends on
 * a platform's font metrics).
 */
const MAX_RESTORE_DRIFT_PX = 60;

async function expectScrolledTo(position: { text: string; lineTop: number }) {
  const drift = async () => {
    const distance = await distanceFromTop(position.text);
    return distance === null
      ? Number.POSITIVE_INFINITY
      : Math.abs(distance - position.lineTop);
  };
  await expect
    .poll(drift, {
      timeout: 10000,
      message: `The note never came back to "${position.text.trim()}"`,
    })
    .toBeLessThanOrEqual(MAX_RESTORE_DRIFT_PX);
}

/**
 * Import the fixture article and open it afresh: the tab it was imported in
 * opened it as a plain note, and its editor keeps no reading position.
 *
 * @returns the note's path and its item id
 */
async function openImportedArticle() {
  await importArticle(
    window,
    'sources/Memorizing a programming language using spaced repetition'
  );
  let path = '';
  let id = '';
  await expect
    .poll(async () => {
      [path, id] = await window.evaluate(() => {
        const { app } = window as unknown as PositionTestWindow;
        const file = app.workspace.getActiveFile();
        const irId = file
          ? app.metadataCache.getFileCache(file)?.frontmatter?.['ir-id']
          : undefined;
        return [file?.path ?? '', typeof irId === 'string' ? irId : ''];
      });
      return id;
    })
    .not.toBe('');
  await closeNote(path);
  await openNoteAt(path);
  await expect(window.locator(SCROLLER)).toBeVisible();
  return { path, id };
}

/**
 * Scroll the active note's editor well down, until the scroll comes to rest
 * and the item `id` holds a reading position for it.
 *
 * @returns the line at the top edge once at rest
 */
async function readWellDown(id: string) {
  // The scroll listener goes on once the mount-time restore has run, so try
  // until a scroll is kept.
  await window.locator(SCROLLER).hover();
  const scrollTop = async () => (await topVisibleLine())?.scrollTop ?? 0;
  await expect(async () => {
    await window.mouse.wheel(0, -100000);
    await expect.poll(scrollTop, { timeout: 2000 }).toBe(0);
    for (let i = 0; i < 6; i++) await window.mouse.wheel(0, 600);
    await expect.poll(scrollTop, { timeout: 2000 }).toBeGreaterThan(1000);
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
  const position = await topVisibleLine();
  if (!position) throw new Error('No note editor on screen');
  return position;
}

test('a pane split off right after a scroll opens there, and the note reopens there from the database', async () => {
  const { path, id } = await openImportedArticle();
  const position = await readWellDown(id);

  // Split right at once: the new pane opens where the reader is
  await executeCommandById(window, 'workspace:split-vertical');
  await expect
    .poll(() =>
      window.evaluate(
        (notePath) =>
          (window as unknown as PositionTestWindow).app.workspace
            .getLeavesOfType('markdown')
            .filter((leaf) => leaf.view.file?.path === notePath).length,
        path
      )
    )
    .toBe(2);
  await expectScrolledTo(position);

  // Close both panes, and let the device forget the position: what reopens
  // is what the database kept
  await closeNote(path);
  await expect.poll(() => heldPosition(id)).toBe(0);
  await window.evaluate((key) => {
    (window as unknown as PositionTestWindow).app.saveLocalStorage(key, null);
  }, POSITIONS_KEY);

  await openNoteAt(path);
  await expect(window.locator(SCROLLER)).toBeVisible();
  await expectScrolledTo(position);
});

/** The active note tab's reading view: its scroller. */
const PREVIEW_SCROLLER =
  '.workspace-leaf.mod-active [data-type="markdown"] .markdown-reading-view .markdown-preview-view';

/**
 * The first heading on screen in the active note's editor, and how far it
 * sits below the top edge, in px. A heading, not the top line: it is one line
 * in both modes and reads the same in both, where a paragraph's top line is
 * one of several in a reading-view block.
 */
async function headingOnScreen() {
  return await window.evaluate((selector) => {
    const scroller = document.querySelector<HTMLElement>(selector);
    if (!scroller) return null;
    const { top, bottom } = scroller.getBoundingClientRect();
    const heading = [
      ...scroller.querySelectorAll('.cm-line.HyperMD-header'),
    ].find((el) => {
      const rect = el.getBoundingClientRect();
      return rect.top >= top && rect.bottom <= bottom;
    });
    if (!heading) return null;
    return {
      text: heading.textContent ?? '',
      lineTop: heading.getBoundingClientRect().top - top,
    };
  }, SCROLLER);
}

/**
 * How far the heading reading `text` sits below the top edge of the active
 * note, in px, in whichever mode the note is showing, or `null` when no
 * heading on screen reads that way.
 *
 * Unofficial: `isShown`, Obsidian's DOM helper.
 */
async function headingDistance(text: string) {
  return await window.evaluate(
    ([source, preview, wanted]) => {
      // The editor shows a heading's `#`s while the cursor is on it
      const squash = (s: string) =>
        s.replace(/\s+/g, ' ').trim().replace(/^#+ /, '');
      const editor = document.querySelector<HTMLElement>(source);
      const reading = document.querySelector<HTMLElement>(preview);
      const scroller = editor?.isShown()
        ? editor
        : reading?.isShown()
          ? reading
          : null;
      if (!scroller) return null;
      const headings =
        scroller === editor
          ? '.cm-line.HyperMD-header'
          : 'h1, h2, h3, h4, h5, h6';
      const top = scroller.getBoundingClientRect().top;
      const distances = [...scroller.querySelectorAll(headings)]
        .filter((el) => squash(el.textContent ?? '') === squash(wanted))
        .map((el) => el.getBoundingClientRect().top - top);
      if (distances.length === 0) return null;
      return distances.reduce((best, distance) =>
        Math.abs(distance) < Math.abs(best) ? distance : best
      );
    },
    [SCROLLER, PREVIEW_SCROLLER, text] as const
  );
}

/**
 * How long a view has to hold still to count as having stayed put, in ms.
 */
const HOLD_STILL_MS = 1000;

/**
 * How long to leave the page alone after a switch or an undo, in ms: past the
 * reading view's re-render, which moved it a few hundred ms after either.
 */
const QUIET_MS = 1500;

/**
 * Wait {@link QUIET_MS} without asking the page for any layout.
 *
 * Everything else a test waits with — a locator's visibility, a rect — makes
 * the page lay out at once, and the jump depends on when the page lays out
 * while the reading view re-renders: with a test polling the layout through
 * it, it showed in about half the runs here, left alone, in every one.
 */
const leaveAlone = () =>
  window.evaluate(
    (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    QUIET_MS
  );

/**
 * Expect the note, in whichever mode it shows, to be at `position` and stay
 * there for {@link HOLD_STILL_MS}.
 */
async function expectStaysAt(position: { text: string; lineTop: number }) {
  const drift = async () => {
    const distance = await headingDistance(position.text);
    return distance === null
      ? Number.POSITIVE_INFINITY
      : Math.abs(distance - position.lineTop);
  };
  const message = `The note did not stay at "${position.text.trim()}"`;
  await expect
    .poll(drift, { timeout: 10000, message })
    .toBeLessThanOrEqual(MAX_RESTORE_DRIFT_PX);
  const until = Date.now() + HOLD_STILL_MS;
  while (Date.now() < until) {
    expect(await drift(), message).toBeLessThanOrEqual(MAX_RESTORE_DRIFT_PX);
  }
}

test('the view stays put across mode switches around making a snippet and undoing it', async () => {
  await window.setViewportSize({ width: 1280, height: 800 });
  const { path, id } = await openImportedArticle();
  // Read once in reading view first, as a reader switching back and forth
  // does: its rendering is then already on screen when the snippet's
  // highlight asks for a new one.
  await executeCommandById(window, 'markdown:toggle-preview');
  await expect(window.locator(PREVIEW_SCROLLER)).toBeVisible();
  await executeCommandById(window, 'markdown:toggle-preview');
  await expect(window.locator(SCROLLER)).toBeVisible();
  await readWellDown(id);
  const position = await headingOnScreen();
  if (!position) throw new Error('No heading on screen to keep track of');

  // A snippet of a paragraph on screen, found by the plain text it opens
  // with: live preview shows the markup of the line the cursor is on, so
  // text past the first `**bold**` or link reads differently once the first
  // round has selected the line.
  const paragraph = await window.evaluate((selector) => {
    const scroller = document.querySelector<HTMLElement>(selector);
    if (!scroller) return '';
    const { top, bottom } = scroller.getBoundingClientRect();
    /** The text before the line's first element with text of its own. */
    const plainStart = (el: Element) => {
      let text = '';
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
        // Widgets with no text, such as the fold indicator, don't count
        else if (node.textContent) break;
      }
      return text;
    };
    const line = [...scroller.querySelectorAll('.cm-line')].find((el) => {
      const rect = el.getBoundingClientRect();
      return (
        rect.top > top + 150 &&
        rect.bottom < bottom - 50 &&
        plainStart(el).trim().length >= 30
      );
    });
    return line ? plainStart(line).slice(0, 30) : '';
  }, SCROLLER);
  expect(paragraph).not.toBe('');
  // Twice over: the jump comes with most passes here, not every one, as it
  // depends on whether the page happens to lay out part way through the
  // re-render
  for (let round = 0; round < 2; round++) {
    // In the editor: a notice names the snippet by its opening words too
    await window
      .locator(SCROLLER)
      .getByText(paragraph)
      .click({ clickCount: 3 });
    await expect
      .poll(() => window.evaluate(() => getSelection()?.toString() ?? ''))
      .toContain(paragraph.trim());
    await executeCommandById(window, 'incremental-reading:extract-selection');
    await expectExtractSettled(window, path, 1);
    await expectStaysAt(position);

    await executeCommandById(window, 'markdown:toggle-preview');
    await leaveAlone();
    await expectStaysAt(position);

    await executeCommandById(window, 'incremental-reading:undo');
    // Reads no layout
    await expect
      .poll(
        async () =>
          Object.keys((await readSnippetState(window, path)).tracked).length
      )
      .toBe(0);
    await leaveAlone();
    await expectStaysAt(position);

    await executeCommandById(window, 'markdown:toggle-preview');
    await leaveAlone();
    await expectStaysAt(position);
  }
});
