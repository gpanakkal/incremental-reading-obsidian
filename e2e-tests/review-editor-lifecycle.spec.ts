import { TRANSCLUSION_HIDE_TITLE_ALIAS } from '#/lib/constants';
import {
  expect,
  type ConsoleMessage,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import {
  executeCommandById,
  importArticle,
  REVIEW_VIEW_TYPE,
  reviewTitle,
  waitForReviewItem,
  type ShownItem,
} from './helpers';
import { test } from './setup/fixtures';
import {
  closeElectron,
  createVaultCopy,
  launchElectron,
  openVault,
} from './setup/helpers';

// The review editor as Obsidian's own editor settings change under it, and as
// review moves it from item to item and finally closes it: each item's editor
// is put away cleanly, and a reconfigure leaves the reader where they were.

let app: ElectronApplication;
let window: Page;

test.beforeEach(async () => {
  const vaultPath = await createVaultCopy('ed-life');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
});

// #region HELPERS

const CARD_PATH = 'Embedded card.md';
const CARD_TEXT = 'The text of the embedded card';
const REVIEWED_NOTE = 'sources/Security Principles.md';

/** The review editor of the active tab. */
const reviewEditor = (page: Page) =>
  page.locator(
    `.workspace-leaf.mod-active [data-type="${REVIEW_VIEW_TYPE}"] .ir-editor`
  );

/** The review editor's embeds of the card. */
const cardEmbed = (page: Page) =>
  reviewEditor(page).locator(
    `.internal-embed[alt*="${TRANSCLUSION_HIDE_TITLE_ALIAS}"]`
  );

/**
 * What the page-side calls below reach on Obsidian. `window.app` and
 * `workspace.activeEditor` are unofficial Obsidian API: stable in practice,
 * but undocumented.
 */
type PageApp = {
  vault: {
    getFileByPath(path: string): unknown;
    create(path: string, text: string): Promise<unknown>;
    process(file: unknown, fn: (text: string) => string): Promise<string>;
  };
  workspace: {
    activeEditor: {
      editor: { getCursor(): { line: number; ch: number } };
    } | null;
  };
};

/**
 * Make the card's note, and embed it after the first paragraph of
 * {@link REVIEWED_NOTE}, as a card made from that note embeds itself.
 */
const embedCard = (page: Page) =>
  page.evaluate(
    async ({ card, text, note, alias }) => {
      const { app } = window as unknown as { app: PageApp };
      await app.vault.create(card, text);
      await app.vault.process(app.vault.getFileByPath(note), (body) =>
        body.replace(/\n\n/, `\n\n![[Embedded card|${alias}]]\n\n`)
      );
    },
    {
      card: CARD_PATH,
      text: `${CARD_TEXT}\n`,
      note: REVIEWED_NOTE,
      alias: TRANSCLUSION_HIDE_TITLE_ALIAS,
    }
  );

/** The review editor's cursor, as its editor reports it. */
const cursor = (page: Page) =>
  page.evaluate(() => {
    const { app } = window as unknown as { app: PageApp };
    return app.workspace.activeEditor?.editor.getCursor() ?? null;
  });

/** Collect the warnings and errors `page` logs from now on. */
function collectConsoleProblems(page: Page) {
  const problems: string[] = [];
  const onConsole = (message: ConsoleMessage) => {
    if (['warning', 'error'].includes(message.type())) {
      problems.push(`${message.type()}: ${message.text()}`);
    }
  };
  const onPageError = (error: Error) => problems.push(`pageerror: ${error}`);
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  return problems;
}

// #endregion

test('keeps the item, its scroll, its cursor and its card embed as the spellcheck setting changes, and follows the setting', async () => {
  await importArticle(window, REVIEWED_NOTE.replace(/\.md$/, ''));
  await embedCard(window);
  await executeCommandById(window, 'incremental-reading:learn');
  await window.locator('css=#begin-review-button').click();
  await expect(reviewTitle(window, 'Security Principles')).toBeVisible();
  const item = await waitForReviewItem(window);
  const embed = cardEmbed(window);
  await expect(embed).toContainText(CARD_TEXT, { timeout: 15_000 });

  // A place of the reader's own: the editor scrolled down a way, and the
  // cursor put on a line in view
  const scroller = reviewEditor(window).locator('.cm-scroller');
  await scroller.hover();
  await window.mouse.wheel(0, 300);
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await reviewEditor(window).locator('.cm-line').nth(12).click();
  const place = {
    scrollTop: await scroller.evaluate((el) => el.scrollTop),
    cursor: await cursor(window),
  };
  expect(place.cursor).not.toBeNull();
  const content = reviewEditor(window).locator('.cm-content');
  const spellcheckAt = async () => await content.getAttribute('spellcheck');
  const before = await spellcheckAt();
  const problems = collectConsoleProblems(window);

  for (const expected of [
    before === 'true' ? 'false' : 'true',
    before === 'true' ? 'true' : 'false',
  ]) {
    await test.step(`spellcheck ${expected === 'true' ? 'on' : 'off'}`, async () => {
      await executeCommandById(window, 'editor:toggle-spellcheck');

      await expect.poll(spellcheckAt).toBe(expected);
      expect((await waitForReviewItem(window)).id).toBe(item.id);
      await expect(embed).toContainText(CARD_TEXT);
      const scrollTop = await scroller.evaluate((el) => el.scrollTop);
      expect(Math.abs(scrollTop - place.scrollTop)).toBeLessThanOrEqual(1);
      expect(await cursor(window)).toEqual(place.cursor);
    });
  }
  expect(problems).toEqual([]);
});

test('logs no warning or error as review moves its editor from item to item and back, and closes', async () => {
  await importArticle(window, REVIEWED_NOTE.replace(/\.md$/, ''));
  await importArticle(
    window,
    'sources/Memorizing a programming language using spaced repetition'
  );
  await importArticle(window, 'sources/Curse of dimensionality - Wikipedia');
  await embedCard(window);
  await executeCommandById(window, 'incremental-reading:learn');
  await window.locator('css=#begin-review-button').click();
  const first = await waitForReviewItem(window);
  const problems = collectConsoleProblems(window);

  /** Run `command`, and wait for review to show an item other than `from`. */
  async function moveWith(command: string, from: ShownItem) {
    await executeCommandById(window, command);
    // Bounded well inside `CURRENT_ITEM_REFETCH_TIME`: a move review missed
    // must not pass by the five-second poll making it instead
    await expect(async () => {
      const shown = await waitForReviewItem(window);
      expect(shown.id).not.toBe(from.id);
    }).toPass({ timeout: 3_000 });
    return waitForReviewItem(window);
  }

  const second = await moveWith('incremental-reading:mark-review', first);
  const third = await moveWith('incremental-reading:skip-item', second);
  expect((await moveWith('app:go-back', third)).id).toBe(second.id);
  expect((await moveWith('app:go-forward', second)).id).toBe(third.id);
  await executeCommandById(window, 'workspace:close');
  await expect(
    window.locator(`.workspace-leaf-content[data-type="${REVIEW_VIEW_TYPE}"]`)
  ).toHaveCount(0);

  // Nothing to wait on for a warning that should never come: an editor put
  // away logs its trouble as it unloads, within a few frames of the move
  await window.evaluate(
    () => new Promise((resolve) => setTimeout(resolve, 1_000))
  );
  expect(problems).toEqual([]);
});
