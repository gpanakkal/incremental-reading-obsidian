import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import {
  emulateMobile,
  executeCommandById,
  importArticle,
  openNote,
  REVIEW_VIEW_TYPE,
  reviewNewCard,
  waitForReviewItem,
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

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('core');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
  if (shouldCleanup) {
    // Best-effort, as in core.spec.ts: a surviving Electron child on Windows
    // can still hold a handle inside the disposable vault.
    await fs
      .rm(vaultPath, { recursive: true, force: true, maxRetries: 3 })
      .catch(() => {});
  }
});

const LEAF = '.workspace-leaf.mod-active';
const REVIEW_BAR = `${LEAF} [data-type="${REVIEW_VIEW_TYPE}"] .ir-review-interface > .ir-action-bar`;
const EDIT_BAR = `${LEAF} .markdown-source-view .ir-action-bar-panel`;
const READING_BAR = `${LEAF} .ir-reading-mode-bar`;

const ARTICLE =
  'sources/Memorizing a programming language using spaced repetition';

/** Viewports pinned for every check: CI's headed window is ~1024px wide. */
const WIDE = { width: 1600, height: 900 };
const PHONE = { width: 420, height: 900 };

/** The review bar's height on mobile, its own `min-height` as main set it. */
const MOBILE_REVIEW_HEIGHT = 50;

/** How tall the element is laid out, or null while it isn't there. */
function heightOf(page: Page, selector: string) {
  return page.evaluate(
    (selector) =>
      document.querySelector(selector)?.getBoundingClientRect().height ?? null,
    selector
  );
}

/**
 * How a note's bar is boxed: its padding above and below, the length
 * `--size-4-2` resolves to there (the padding main gave it on mobile), and how
 * much taller than its tallest button it stands. Measured against the buttons
 * rather than as a pixel height, since their size is Obsidian's and can change
 * between versions.
 */
async function panelBox(page: Page, selector: string) {
  await expect(page.locator(selector)).toBeVisible();
  return page.evaluate((selector) => {
    const el = document.querySelector(selector)!;
    const px = (value: string) => Number.parseFloat(value);
    // A custom property computes to its tokens unevaluated, so read it
    // through a box sized by it
    const probe = document.createElement('div');
    probe.style.cssText =
      'position: absolute; visibility: hidden; width: var(--size-4-2);';
    el.appendChild(probe);
    const step = px(getComputedStyle(probe).width);
    probe.remove();
    const style = getComputedStyle(el);
    const tallest = Math.max(
      ...Array.from(el.querySelectorAll('button')).map(
        (button) => button.getBoundingClientRect().height
      )
    );
    return {
      step,
      paddingTop: px(style.paddingTop),
      paddingBottom: px(style.paddingBottom),
      beyondButtons: el.getBoundingClientRect().height - tallest,
    };
  }, selector);
}

/** A note's bar on mobile is boxed as main boxed it. */
async function expectMobilePanel(page: Page, selector: string) {
  const box = await panelBox(page, selector);
  expect(box.step).toBeGreaterThan(0);
  expect(box.paddingTop).toBe(box.step);
  expect(box.paddingBottom).toBe(box.step);
  expect(box.beyondButtons).toBeCloseTo(2 * box.step, 0);
}

/** Wait for a visible element, then read its height. */
async function settledHeight(page: Page, selector: string) {
  await expect(page.locator(selector)).toBeVisible();
  return (await heightOf(page, selector))!;
}

/** Obsidian's own bar: the active note tab's view header. */
function headerHeight(page: Page) {
  return settledHeight(page, `${LEAF} .view-header`);
}

/**
 * Every control in the bar sits level in it, as much room above as below, and
 * every icon button the bar or one of its zones holds directly is drawn at its
 * own height — its icon plus its padding and border — rather than stretched to
 * a taller control beside it, so their hover fills line up. Leaves out the
 * hidden copy of the grades the bar measures (`.ir-grade-ghost`).
 */
async function expectControlsLevel(page: Page, bar: string) {
  const measured = await page.evaluate((bar) => {
    const el = document.querySelector(bar)!;
    const { top, bottom } = el.getBoundingClientRect();
    const offCentre = Array.from(el.querySelectorAll('button, input'))
      .filter((control) => !control.closest('.ir-grade-ghost'))
      .map((control) => control.getBoundingClientRect())
      .filter((box) => box.height > 0)
      .filter((box) => Math.abs(box.top - top - (bottom - box.bottom)) > 1)
      .map((box) => [box.top, box.bottom, top, bottom]);
    const icons = Array.from(
      el.querySelectorAll(
        [
          ':scope > button.clickable-icon',
          ':scope > .ir-bar-lead > button.clickable-icon',
          ':scope > .ir-bar-center > button.clickable-icon',
          ':scope > .ir-bar-trail > button.clickable-icon',
        ].join(', ')
      )
    )
      .filter((button) => button.getBoundingClientRect().height > 0)
      .map((button) => {
        const svg = button.querySelector(':scope > svg');
        const style = getComputedStyle(button);
        const px = (value: string) => Number.parseFloat(value);
        return {
          height: button.getBoundingClientRect().height,
          natural:
            (svg?.getBoundingClientRect().height ?? Number.NaN) +
            px(style.paddingTop) +
            px(style.paddingBottom) +
            px(style.borderTopWidth) +
            px(style.borderBottomWidth),
        };
      });
    return { offCentre, icons };
  }, bar);
  expect(measured.offCentre).toEqual([]);
  expect(measured.icons.length).toBeGreaterThan(0);
  for (const icon of measured.icons) {
    expect(icon.height).toBeCloseTo(icon.natural, 0);
  }
}

async function beginReview(page: Page) {
  await executeCommandById(page, 'incremental-reading:learn');
  await page.locator('css=#begin-review-button').click();
  await waitForReviewItem(page);
}

function articlePriority(page: Page) {
  return page.evaluate(async () => {
    const rows = await (window as unknown as RepoWindow).app.plugins.plugins[
      'incremental-reading'
    ].reviewManager.repo.query('SELECT priority FROM article');
    return rows?.map((row) => row['priority']);
  });
}

test.describe('Action bars on desktop', () => {
  test('stand as tall as the view header, the priority field usable', async () => {
    await window.setViewportSize(WIDE);
    await importArticle(window, ARTICLE);
    const header = await headerHeight(window);

    expect(
      Math.abs((await settledHeight(window, EDIT_BAR)) - header)
    ).toBeLessThanOrEqual(2);
    await expectControlsLevel(window, EDIT_BAR);

    await executeCommandById(window, 'markdown:toggle-preview');
    expect(
      Math.abs((await settledHeight(window, READING_BAR)) - header)
    ).toBeLessThanOrEqual(2);
    await expectControlsLevel(window, READING_BAR);

    await beginReview(window);
    expect(
      Math.abs((await settledHeight(window, REVIEW_BAR)) - header)
    ).toBeLessThanOrEqual(2);
    await expectControlsLevel(window, REVIEW_BAR);

    // The field takes a new priority from the bar
    const [before] = (await articlePriority(window))!;
    expect(before).not.toBe(45);
    const field = window.locator(`${REVIEW_BAR} .ir-priority-input`);
    await field.click();
    await field.fill('4.5');
    await field.press('Enter');
    await expect.poll(() => articlePriority(window)).toEqual([45]);
    await expect(field).toHaveValue('4.5');
  });

  test('keep the view header height with a card graded from the bar', async () => {
    await window.setViewportSize(WIDE);
    await openNote(window, ARTICLE);
    const header = await headerHeight(window);

    await reviewNewCard(window);
    await window.getByRole('button', { name: 'Show answer' }).click();
    const grades = window.locator(
      `${REVIEW_BAR} > .ir-bar-center > .ir-grade-group`
    );
    await expect(grades).toBeVisible();
    expect(
      Math.abs((await settledHeight(window, REVIEW_BAR)) - header)
    ).toBeLessThanOrEqual(2);
    await expectControlsLevel(window, REVIEW_BAR);

    await grades.getByRole('button', { name: /^Good\b/ }).click();
    await expect(
      window.getByRole('button', { name: 'Show answer' })
    ).toBeHidden();
    await expect(grades).toBeHidden();
  });
});

test.describe('Action bars on mobile', () => {
  test('keep the height they had before desktop bars were made compact', async () => {
    const expectNotePanels = async () => {
      await openNote(window, ARTICLE);
      await expectMobilePanel(window, EDIT_BAR);
      await executeCommandById(window, 'markdown:toggle-preview');
      await expectMobilePanel(window, READING_BAR);
      await executeCommandById(window, 'markdown:toggle-preview');
    };

    await emulateMobile(window, true);
    await window.setViewportSize(WIDE);
    await expect(window.locator('body')).toHaveClass(/\bis-tablet\b/);
    await importArticle(window, ARTICLE);
    await expectNotePanels();

    await window.setViewportSize(PHONE);
    await expect(window.locator('body')).toHaveClass(/\bis-phone\b/);
    await expectNotePanels();

    await beginReview(window);
    expect(await settledHeight(window, REVIEW_BAR)).toBeCloseTo(
      MOBILE_REVIEW_HEIGHT,
      1
    );
    await window.setViewportSize(WIDE);
    await expect(window.locator('body')).toHaveClass(/\bis-tablet\b/);
    expect(await settledHeight(window, REVIEW_BAR)).toBeCloseTo(
      MOBILE_REVIEW_HEIGHT,
      1
    );
  });
});
