import { POSITIONS_KEY } from '#/lib/reading-positions';
import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import { executeCommandById, importArticle } from './helpers';
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

test('a pane split off right after a scroll opens there, and the note reopens there from the database', async () => {
  await importArticle(
    window,
    'sources/Memorizing a programming language using spaced repetition'
  );
  // The imported article, in the active tab
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
  // Opened afresh: the tab it was imported in opened it as a plain note,
  // and its editor keeps no reading position
  await closeNote(path);
  await openNoteAt(path);
  const scroller = window.locator(SCROLLER);
  await expect(scroller).toBeVisible();

  // Read well down it. The scroll listener goes on once the mount-time
  // restore has run, so try until a scroll is kept.
  await scroller.hover();
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
  await expect(scroller).toBeVisible();
  await expectScrolledTo(position);
});
