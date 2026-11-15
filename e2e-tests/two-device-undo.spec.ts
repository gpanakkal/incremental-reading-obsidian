import { POSITIONS_KEY } from '#/lib/reading-positions';
import { expect, type Page } from '@playwright/test';
import * as path from 'node:path';
import {
  closeMenu,
  executeCommandById,
  finalizeArticleImport,
  REVIEW_VIEW_TYPE,
  reviewNewCard,
  scrollToText,
  setDefaultEditingMode,
  setNativeMenus,
  watchNotices,
} from './helpers';
import { test } from './setup/fixtures';
import { createVaultCopy } from './setup/helpers';
import {
  bringSnippetsDue,
  confirmation,
  highlights,
  openNote,
  query,
  reviewing,
  reviewUntil,
  select,
  snippetIds,
} from './setup/item-steps';
import {
  closeDevices,
  launchDevice,
  launchSecondDevice,
  waitForTakenOn,
  type Device,
} from './setup/two-device';

let deviceA: Device | undefined;
let deviceB: Device | undefined;

// #region HELPERS

const SOURCE = 'Source note.md';

/** A passage long enough that its snippet scrolls in the review tab. */
const PASSAGE = Array.from(
  { length: 80 },
  (_, line) => `Passage line ${line + 1} of the long read.`
).join('\n\n');

/**
 * On `page`, import a new note of `text` as an article and take a snippet of
 * `excerpt` from it, due now so that review can bring it up.
 */
async function snippetOfArticle(page: Page, text: string, excerpt: string) {
  await setDefaultEditingMode(page, 'source');
  await openNote(page, SOURCE, text);
  await executeCommandById(page, 'incremental-reading:import-article');
  await finalizeArticleImport(page);
  let article = '';
  await expect
    .poll(async () => {
      const [row] = await query(
        page,
        `SELECT id FROM article WHERE reference = '${SOURCE}'`
      );
      article = row ? String(row.id) : '';
      return article;
    })
    .not.toBe('');
  await select(page, excerpt);
  await executeCommandById(page, 'incremental-reading:extract-selection');
  const [snippet] = await snippetIds(page, 1);
  await expect(highlights(page).first()).toBeVisible();
  const [{ parent }] = await query(
    page,
    `SELECT parent FROM snippet WHERE id = '${snippet}'`
  );
  expect(parent).toBe(article);
  await bringSnippetsDue(page);
  return { article, snippet };
}

/** The cards not deleted for good on `page`, and what each sits under. */
const cards = async (page: Page) =>
  (
    await query(
      page,
      "SELECT id, parent FROM srs_card WHERE reference NOT LIKE '/ir-deleted/%'"
    )
  ).map(({ id, parent }) => ({ id: String(id), parent: String(parent) }));

/**
 * In the review tab on `page`, showing `snippet`, make a card of `excerpt`,
 * and wait for its row under the snippet.
 */
async function cardOfSnippet(page: Page, snippet: string, excerpt: string) {
  // The tab shows its bar a frame or so before its editor is the active one
  await scrollToText(page, excerpt);
  await select(page, excerpt);
  await executeCommandById(page, 'incremental-reading:create-card');
  await expect
    .poll(async () => (await cards(page)).map(({ parent }) => parent))
    .toEqual([snippet]);
  const [{ id }] = await cards(page);
  return id;
}

/** The question undo asks about the children of the item it takes back. */
const childrenPrompt = (page: Page) =>
  confirmation(page).filter({ has: page.locator('.ir-children-row') });

/**
 * Answer the question undo asks about the snippet's one child, its card, by
 * keeping it, which moves the card up to the snippet's parent; then no
 * prompt is left.
 */
async function keepChildren(page: Page) {
  await expect(childrenPrompt(page)).toBeVisible();
  await expect(childrenPrompt(page).locator('.ir-children-row')).toHaveCount(1);
  await childrenPrompt(page)
    .locator('.modal-button-container > button.mod-cta')
    .click();
  await expect(confirmation(page)).toHaveCount(0);
}

/**
 * Run undo on `page`, which must not ask about another device's changes nor
 * fail: wait for the undo's own outcome, the snippet's row gone, or for a
 * prompt, whichever shows first, then require no prompt. Bounded by the
 * outcome, not by a wait for something never to appear. With
 * `keepingChildren`, the one prompt allowed is the question about the
 * snippet's children, answered by keeping them.
 */
async function undoWithoutPrompt(page: Page, keepingChildren = false) {
  const live = async () =>
    (
      await query(
        page,
        "SELECT id FROM snippet WHERE reference NOT LIKE '/ir-deleted/%'"
      )
    ).length;
  await executeCommandById(page, 'incremental-reading:undo');
  await expect
    .poll(
      async () => (await confirmation(page).count()) > 0 || (await live()) === 0
    )
    .toBe(true);
  if (keepingChildren) await keepChildren(page);
  await expect(confirmation(page)).toHaveCount(0);
  await snippetIds(page, 0);
  await expect(highlights(page)).toHaveCount(0);
}

/** Close every review tab on `page`. Unofficial: `window.app`. */
const closeReviewTabs = (page: Page) =>
  page.evaluate((viewType) => {
    const { app } = window as unknown as {
      app: {
        workspace: {
          getLeavesOfType(type: string): { detach(): void }[];
        };
      };
    };
    for (const leaf of app.workspace.getLeavesOfType(viewType)) leaf.detach();
  }, REVIEW_VIEW_TYPE);

/**
 * Close every review tab on `page` and open review's home afresh, so its
 * queue is read now rather than kept from before. Returns once the queue
 * shows its rows, or says it has none.
 */
async function freshReviewHome(page: Page) {
  await closeReviewTabs(page);
  await executeCommandById(page, 'incremental-reading:learn');
  await expect(
    page
      .locator('.ir-queue-panel')
      .locator('.ir-queue-row, .ir-review-placeholder')
      .first()
  ).toBeVisible();
}

const cardRows = (page: Page) =>
  page.locator('.ir-queue-row[data-type="card"]');

/**
 * The schedule and dismissal of the card `id` on `page`, and how many grades
 * of it stand: an undone grade stays behind as a row marked deleted.
 */
async function cardState(page: Page, id: string) {
  const [row] = await query(
    page,
    `SELECT dismissed, reps, state FROM srs_card WHERE id = '${id}'`
  );
  const grades = await query(
    page,
    `SELECT id FROM srs_card_review WHERE card_id = '${id}' AND deleted = 0`
  );
  return {
    dismissed: Number(row.dismissed),
    reps: Number(row.reps),
    state: Number(row.state),
    grades: grades.length,
  };
}

/**
 * Where the reading position of `id` stands on `page`: this device's own,
 * kept in localStorage until the last tab on the item closes.
 * Unofficial: `window.app`, `App.loadLocalStorage`.
 */
const storedPosition = (page: Page, id: string) =>
  page.evaluate(
    ([key, id]) => {
      const { app } = window as unknown as {
        app: { loadLocalStorage(key: string): unknown };
      };
      const entries = app.loadLocalStorage(key) as Record<
        string,
        { position?: number }
      > | null;
      return entries?.[id]?.position ?? 0;
    },
    [POSITIONS_KEY, id] as const
  );

// #endregion

test.beforeEach(async () => {
  // One vault copy, two installs: each its own device to the plugin, each
  // seeing the other's saves through its own file watcher, as Sync delivers
  const vaultPath = await createVaultCopy('two-undo');
  deviceA = await launchDevice(vaultPath);
  deviceB = await launchSecondDevice(vaultPath);
});

test.afterEach(async () => {
  await closeDevices([deviceA, deviceB]);
  deviceA = undefined;
  deviceB = undefined;
});

test('undoing a snippet another device reviewed and carded asks about the review alone; Undo anyway keeps the card under the article', async () => {
  const a = deviceA!.window;
  const b = deviceB!.window;

  const { article, snippet } = await snippetOfArticle(
    a,
    'Intro\n\nSpaced repetition text.',
    'repetition'
  );
  await waitForTakenOn(a, b);

  // On B: make a card of the snippet in review, then mark it reviewed
  await reviewUntil(b, snippet);
  const card = await cardOfSnippet(b, snippet, 'repetition');
  await expect.poll(() => reviewing(b)).toBe(snippet);
  await executeCommandById(b, 'incremental-reading:mark-review');
  await expect
    .poll(async () =>
      (await query(b, 'SELECT snippet_id FROM snippet_review')).map(
        ({ snippet_id }) => String(snippet_id)
      )
    )
    .toEqual([snippet]);
  await waitForTakenOn(b, a);

  // On A: the prompt lists the review, and no line for the card, which
  // outlives the undo
  await executeCommandById(a, 'incremental-reading:undo');
  await expect(confirmation(a)).toBeVisible();
  await expect(confirmation(a).locator('li')).toHaveText([/^1 review$/]);

  // Cancel: everything stays, and undo still asks
  await confirmation(a).locator('button.mod-cancel').click();
  await expect(confirmation(a)).toHaveCount(0);
  await expect(highlights(a)).toHaveText(['repetition']);
  expect(await snippetIds(a, 1)).toEqual([snippet]);
  expect(await cards(a)).toEqual([{ id: card, parent: snippet }]);
  await executeCommandById(a, 'incremental-reading:undo');
  await expect(confirmation(a)).toBeVisible();
  await expect(confirmation(a).locator('li')).toHaveText([/^1 review$/]);

  // Undo anyway, then keep the card when asked about the snippet's children:
  // the snippet goes, and its card moves up to the article
  await confirmation(a).locator('button.mod-cta').click();
  await keepChildren(a);
  await expect(highlights(a)).toHaveCount(0);
  await snippetIds(a, 0);
  await expect.poll(() => cards(a)).toEqual([{ id: card, parent: article }]);
  await waitForTakenOn(a, b);

  // On B as well
  await snippetIds(b, 0);
  expect(await cards(b)).toEqual([{ id: card, parent: article }]);
});

test('undoing a snippet another device only made a card of runs without asking, and the card stays', async () => {
  const a = deviceA!.window;
  const b = deviceB!.window;

  const { article, snippet } = await snippetOfArticle(
    a,
    'Intro\n\nSpaced repetition text.',
    'repetition'
  );
  await waitForTakenOn(a, b);

  // On B: a card of the snippet, and nothing else
  await reviewUntil(b, snippet);
  const card = await cardOfSnippet(b, snippet, 'repetition');
  await waitForTakenOn(b, a);

  // On A: the card is no change the undo discards, so it asks nothing about
  // B, only whether to keep the card, which it does
  await undoWithoutPrompt(a, true);
  await expect.poll(() => cards(a)).toEqual([{ id: card, parent: article }]);
  await waitForTakenOn(a, b);
  expect(await cards(b)).toEqual([{ id: card, parent: article }]);
});

test('undoing a snippet another device only opened and scrolled runs without asking', async () => {
  const a = deviceA!.window;
  const b = deviceB!.window;

  const { snippet } = await snippetOfArticle(a, `Intro\n\n${PASSAGE}`, PASSAGE);
  await waitForTakenOn(a, b);

  // On B: open the snippet in review and scroll well down it
  await reviewUntil(b, snippet);
  const scroller = b.locator(
    `.workspace-leaf.mod-active [data-type="${REVIEW_VIEW_TYPE}"] .cm-scroller`
  );
  await scroller.hover();
  // The position is kept only once the editor has restored the last one, a
  // few frames after it mounts: a scroll before that keeps nothing, so try
  // again from the top until one is kept
  await expect(async () => {
    await b.mouse.wheel(0, -100000);
    for (let i = 0; i < 6; i++) await b.mouse.wheel(0, 600);
    await expect
      .poll(() => storedPosition(b, snippet), { timeout: 2000 })
      .toBeGreaterThan(0);
  }).toPass();
  // Closing the last tab on it is what writes the position to the database
  await closeReviewTabs(b);
  const savedScroll = async (page: Page) =>
    (
      await query(
        page,
        `SELECT scroll_top FROM snippet WHERE id = '${snippet}'`
      )
    ).map(({ scroll_top }) => Number(scroll_top))[0];
  await expect.poll(() => savedScroll(b)).toBeGreaterThan(0);
  await waitForTakenOn(b, a);

  // On A, which holds B's position now: where B's reader stopped is no work
  // the undo discards
  expect(await savedScroll(a)).toBeGreaterThan(0);
  await undoWithoutPrompt(a);
});

test("undoing a grade keeps another device's dismissal of the card, on both devices", async () => {
  const a = deviceA!.window;
  const b = deviceB!.window;

  // On A: grade a new card
  await reviewNewCard(a);
  const [{ id: card, reference }] = await query(
    a,
    'SELECT id, reference FROM srs_card'
  );
  const id = String(card);
  await executeCommandById(a, 'incremental-reading:mark-review');
  await executeCommandById(a, 'incremental-reading:grade-card-good');
  await expect.poll(async () => (await cardState(a, id)).grades).toBe(1);
  await waitForTakenOn(a, b);

  // On B: dismiss it from the queue's row menu. Drawn in the page: macOS
  // defaults to native menus, which no locator sees, and a click on the row's
  // button there opens one that every later try then waits on in vain
  await setNativeMenus(b, false);
  await freshReviewHome(b);
  await expect(cardRows(b)).toHaveCount(1);
  const menu = b.locator('.menu');
  const dismiss = menu.locator('.menu-item:has(.lucide-ban)');
  await expect(async () => {
    if ((await menu.count()) > 0) await closeMenu(b);
    await cardRows(b).locator('.ir-queue-row-menu').click();
    await expect(dismiss).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 60_000 });
  await dismiss.click();
  await expect.poll(async () => (await cardState(b, id)).dismissed).toBe(1);
  await waitForTakenOn(b, a);

  // On A: undo the grade. The grade goes, the dismissal stays
  const notices = await watchNotices(a);
  await executeCommandById(a, 'incremental-reading:undo');
  await expect.poll(async () => (await cardState(a, id)).grades).toBe(0);
  expect(await cardState(a, id)).toEqual({
    dismissed: 1,
    reps: 0,
    state: 0,
    grades: 0,
  });
  // The notice names the card the undo was for
  const name = path.posix.basename(String(reference), '.md');
  await expect
    .poll(async () => (await notices()).some((text) => text.includes(name)))
    .toBe(true);
  await freshReviewHome(a);
  await expect(cardRows(a)).toHaveCount(0);
  await waitForTakenOn(a, b);

  // On B as well
  expect(await cardState(b, id)).toEqual({
    dismissed: 1,
    reps: 0,
    state: 0,
    grades: 0,
  });
  await freshReviewHome(b);
  await expect(cardRows(b)).toHaveCount(0);
});
