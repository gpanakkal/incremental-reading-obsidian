import { ARTICLE_TAG, MAX_SQL_QUERY_PARAMS } from '#/lib/constants';
import test, {
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { App } from 'obsidian';
import {
  emulateMobile,
  executeCommandById,
  expectCompactIconBar,
  expectExtractSettled,
  expectReviewOn,
  finalizeArticleImport,
  importArticle,
  noteBody,
  openFileInActiveLeaf,
  openNote,
  openPluginSettings,
  pendingSaves,
  readSnippetState,
  REVIEW_VIEW_DEFAULT_TITLE,
  REVIEW_VIEW_TYPE,
  reviewHeader,
  reviewNewCard,
  reviewTitle,
  scrollToText,
  selectParagraph,
  setDefaultEditingMode,
  setPluginSetting,
  setShowViewHeader,
  toggleReviewSourceMode,
  waitForReviewItem,
  watchNotices,
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

/**
 * The article most tests below import, as it is named once imported.
 *
 * Not the same string the tests hand to `openNote`: that one is a prefix the
 * quick switcher resolves, while this is the note's full basename, which is
 * what the review pane displays.
 */
const ARTICLE_TITLE =
  'Memorizing a programming language using spaced repetition software';

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('core');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);

  // Renderer dialogs are answered by `launchElectron`, for every window rather
  // than just this one. Re-registering here would answer each dialog twice —
  // and answer `beforeunload` with "stay open", which is the opposite of what
  // teardown needs.
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
  if (shouldCleanup) {
    // Best-effort. On Windows a surviving Electron child can still hold a
    // handle inside the vault, and an EBUSY here would fail an otherwise
    // passing test during cleanup. The vault dir is disposable — the next run
    // makes a fresh copy — so a leftover is not worth failing over.
    await fs
      .rm(vaultPath, { recursive: true, force: true, maxRetries: 3 })
      .catch(() => {});
  }
});

test('Can open the review interface by executing the command', async () => {
  await executeCommandById(window, 'incremental-reading:learn');

  // Verify the tab header for the review interface is visible
  await expect(
    window.locator('div.workspace-tab-header[aria-label="Incremental reading"]')
  ).toBeVisible();
});

test('Can open the review interface from the ribbon button', async () => {
  await window.getByLabel('Incremental reading').click();
  // Verify the tab header for the review interface is visible
  await expect(
    window.locator('div.workspace-tab-header[aria-label="Incremental reading"]')
  ).toBeVisible();
});

test.describe('Article Importing', () => {
  test('can import Markdown from the file explorer context menu', async () => {
    // macOS uses native context menus which are invisible to Playwright
    test.skip(process.platform === 'darwin', 'Native context menus on macOS');

    await window.getByText('sources').click();

    await window.getByText('Curse of dimensionality - Wikipedia').click({
      button: 'right',
    });
    await window.getByText('Import article').click();
    await finalizeArticleImport(window);

    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    // look for the action bar to confirm we're in review
    await expect(
      window.getByRole('button', { name: 'Mark reviewed' })
    ).toBeVisible();
    await expect(
      reviewTitle(window, 'Curse of dimensionality - Wikipedia')
    ).toBeVisible();
  });

  test('can import Markdown from the note hamburger menu', async () => {
    // macOS uses native context menus which are invisible to Playwright
    test.skip(process.platform === 'darwin', 'Native context menus on macOS');

    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );

    await window.getByRole('button', { name: 'More options' }).click();
    await window.getByText('Import article').click();
    await finalizeArticleImport(window);
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();

    // look for the action bar to confirm we're in review
    await expect(
      window.getByRole('button', { name: 'Mark reviewed' })
    ).toBeVisible();
    await expect(reviewTitle(window, ARTICLE_TITLE)).toBeInViewport();
  });

  test('can import Markdown from the command palette', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();

    // look for the action bar to confirm we're in review
    await expect(
      window.getByRole('button', { name: 'Mark reviewed' })
    ).toBeVisible();
    await expect(reviewTitle(window, ARTICLE_TITLE)).toBeVisible();
  });

  test('a second import confirmation replaces the first on a phone rather than stacking over the text', async () => {
    await emulateMobile(window, true);
    // Phone width, where Obsidian stretches its notices across the screen
    await window.setViewportSize({ width: 400, height: 850 });
    const imported = (title: string) =>
      window.locator('.notice').filter({ hasText: `"${title}"` });

    await importArticle(window, 'sources/Security Principles');
    await expect(imported('Security Principles')).toBeVisible();
    await importArticle(window, 'sources/Curse of dimensionality - Wikipedia');

    await expect(imported('Curse of dimensionality - Wikipedia')).toBeVisible();
    // Well inside the first notice's own time on screen (5 s at the least), so
    // it is the second notice that hid it, not its timer
    await expect(imported('Security Principles')).toHaveCount(0, {
      timeout: 1_000,
    });
  });
});

test.describe('Action Bar', () => {
  test('Can filter which item types are reviewed', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();

    const filterButton = window.locator('css=.ir-type-filter-button');
    const menu = window.getByRole('menu');
    const articleRow = menu.locator(
      'css=.ir-type-filter-row[data-type="article"]'
    );

    await filterButton.click();

    // stop reviewing articles; the menu stays open for the next toggle
    await articleRow.click();
    await expect(articleRow).toHaveAttribute('aria-checked', 'false');
    await expect(filterButton).toHaveClass(/\bis-filtered\b/);
    await expect(reviewTitle(window, ARTICLE_TITLE)).not.toBeVisible();
    await expect(menu).toBeVisible();

    // review articles again
    await articleRow.click();
    await expect(articleRow).toHaveAttribute('aria-checked', 'true');
    await expect(filterButton).not.toHaveClass(/\bis-filtered\b/);
    await expect(reviewTitle(window, ARTICLE_TITLE)).toBeVisible();
    await expect(menu).toBeVisible();

    // a click outside closes it
    await window.locator('.ir-review-interface .cm-content').first().click();
    await expect(menu).toHaveCount(0);

    // so do a second click on the icon, and Escape
    await filterButton.click();
    await expect(menu).toBeVisible();
    await filterButton.click();
    await expect(menu).toHaveCount(0);
    await filterButton.click();
    await expect(menu).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // the cards-only command drives the same filter

    // show cards only
    await executeCommandById(window, 'incremental-reading:toggle-cards-only');
    await expect(reviewTitle(window, ARTICLE_TITLE)).not.toBeVisible();

    // show all items
    await executeCommandById(window, 'incremental-reading:toggle-cards-only');
    await expect(reviewTitle(window, ARTICLE_TITLE)).toBeVisible();
  });

  test('Can filter the upcoming items on the home screen by type', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );
    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    // A card is listed in the upcoming table though it is not due until
    // tomorrow, so it needs no backdating here
    const paragraph =
      'Explain the security functions: Confidentiality, Integrity and Availability (CIA).';
    await openNote(window, 'sources/Security Principles');
    await scrollToText(window, paragraph);
    await selectParagraph(window, paragraph);
    await executeCommandById(window, 'incremental-reading:create-card');
    await executeCommandById(window, 'incremental-reading:learn');

    const articleItem = window.locator('.ir-queue-row[data-type="article"]');
    const cardItem = window.locator('.ir-queue-row[data-type="card"]');
    const filterButton = window.locator('css=.ir-type-filter-button');
    const menu = window.getByRole('menu');
    const typeRow = (type: string) =>
      menu.locator(`css=.ir-type-filter-row[data-type="${type}"]`);
    await expect(articleItem).toHaveCount(1);
    await expect(cardItem).toHaveCount(1);

    // only articles
    await filterButton.click();
    await typeRow('card').click();
    await expect(cardItem).toHaveCount(0);
    await expect(articleItem).toHaveCount(1);

    // nothing at all, and nothing to begin a review of
    await typeRow('article').click();
    await expect(articleItem).toHaveCount(0);
    await expect(window.locator('css=#begin-review-button')).toBeDisabled();

    // articles back, cards still off
    await typeRow('article').click();
    await expect(articleItem).toHaveCount(1);
    await expect(cardItem).toHaveCount(0);

    // the filter set on the home screen is the one review draws from
    await window.keyboard.press('Escape');
    await window.locator('css=#begin-review-button').click();
    await expect(reviewTitle(window, ARTICLE_TITLE)).toBeVisible();
    await filterButton.click();
    await expect(typeRow('card')).toHaveAttribute('aria-checked', 'false');
    await expect(typeRow('article')).toHaveAttribute('aria-checked', 'true');
  });

  test('Can review articles', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    await window.getByRole('button', { name: 'Mark reviewed' }).click();

    await executeCommandById(window, 'workspace:close');

    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    await expect(reviewTitle(window, ARTICLE_TITLE)).not.toBeVisible();
  });

  test('sums up the session once the queue runs out, and closes the tab from there', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    await window.getByRole('button', { name: 'Mark reviewed' }).click();

    const summary = window.locator('.ir-review-summary');
    await expect(summary.locator('.ir-review-summary-total')).toHaveText(
      /\b1 item\b/
    );
    // Singular, because the row's label is pluralized by its own count and
    // exactly one article was reviewed here.
    await expect(
      summary
        .locator('.ir-review-summary-count', { hasText: 'Article' })
        .locator('dd')
    ).toHaveText('1');

    await summary.getByRole('button', { name: 'Close tab' }).click();
    await expect(
      window.locator(
        'div.workspace-tab-header[aria-label="Incremental reading"]'
      )
    ).toHaveCount(0);
  });

  test('undoing the last review from the summary goes back to the item', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    const item = await waitForReviewItem(window);
    await window.getByRole('button', { name: 'Mark reviewed' }).click();

    const summary = window.locator('.ir-review-summary');
    await expect(summary.locator('.ir-review-summary-total')).toBeVisible();

    await window.locator('css=#undo-button').click();

    // Bounded, and bounded well inside `CURRENT_ITEM_REFETCH_TIME`: the
    // summary is the one place review holds no item at all, so asking the
    // queue for the next one changes nothing there and the item used to come
    // back only when the five-second poll next looked at the queue. Getting
    // back to it now takes naming it, which is immediate.
    await expectReviewOn(window, item, { timeout: 1_500 });
    await expect(summary).toHaveCount(0);
  });

  test('Can skip items', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();

    const skipButton = window.getByRole('button', {
      name: 'Skip for current review session',
    });
    await expect(skipButton).toBeInViewport();
    await skipButton.click();

    const summary = window.locator('.ir-review-summary');
    await expect(summary.locator('.ir-review-summary-total')).toBeVisible();
    await expect(
      summary.getByRole('listitem').filter({ hasText: ARTICLE_TITLE })
    ).toBeVisible();
    await executeCommandById(window, 'workspace:close');

    // A skip outlives the review tab that made it: the skipped ids belong to
    // the plugin's store, not the view, and only a fresh plugin launch or the
    // day rolling over clears them. So reopening review finds the queue still
    // empty, with the item still named among the skipped rather than served
    // again.
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    await expect(
      summary.getByRole('listitem').filter({ hasText: ARTICLE_TITLE })
    ).toBeVisible();
    await expect(reviewTitle(window, ARTICLE_TITLE)).toHaveCount(0);
  });

  test('undoing the last skip from the summary goes back to the item', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    const item = await waitForReviewItem(window);
    await window
      .getByRole('button', { name: 'Skip for current review session' })
      .click();

    const summary = window.locator('.ir-review-summary');
    await expect(summary.locator('.ir-review-summary-total')).toBeVisible();

    await window.locator('css=#undo-button').click();

    // Bounded, and bounded well inside `CURRENT_ITEM_REFETCH_TIME`: the
    // summary is the one place review holds no item at all, so asking the
    // queue for the next one changes nothing there and the unskipped item came
    // back only when the five-second poll next looked at the queue.
    await expectReviewOn(window, item, { timeout: 1_500 });
    await expect(summary).toHaveCount(0);
  });

  test('Can dismiss items from review UI', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();

    const dismissButton = window.getByRole('button', {
      name: 'Stop scheduling this item for review',
    });
    await expect(dismissButton).toBeInViewport();
    await dismissButton.click();

    await executeCommandById(window, 'workspace:close');

    await executeCommandById(window, 'incremental-reading:learn');
    await expect(window.locator('css=#begin-review-button')).toBeDisabled();
  });

  test('undoing the last dismissal from the summary goes back to the item', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    const item = await waitForReviewItem(window);
    await window
      .getByRole('button', { name: 'Stop scheduling this item for review' })
      .click();

    const summary = window.locator('.ir-review-summary');
    await expect(summary).toBeVisible();

    await window.locator('css=#undo-button').click();

    // Bounded well inside `CURRENT_ITEM_REFETCH_TIME`, as for the undone skip
    // above: on the summary review holds no item, so asking the queue for the
    // next one changes nothing and the restored item came back only when the
    // five-second poll next looked.
    await expectReviewOn(window, item, { timeout: 1_500 });
    await expect(summary).toHaveCount(0);
  });

  test('Can dismiss items from note pane', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);

    const dismissButton = window.getByRole('button', {
      name: 'Dismiss',
    });
    await expect(dismissButton).toBeInViewport();
    await dismissButton.click();

    await executeCommandById(window, 'incremental-reading:learn');
    await expect(window.locator('css=#begin-review-button')).toBeDisabled();
  });

  test('Can un-dismiss items from note pane', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);

    const dismissButton = window.getByRole('button', {
      name: 'Dismiss',
    });
    await expect(dismissButton).toBeInViewport();
    await dismissButton.click();

    await executeCommandById(window, 'incremental-reading:learn');
    await expect(window.locator('css=#begin-review-button')).toBeDisabled();

    await executeCommandById(window, 'workspace:close');

    const unDismissButton = window.getByRole('button', {
      name: 'Un-dismiss',
    });
    await expect(unDismissButton).toBeInViewport();
    await unDismissButton.click();

    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    await expect(window.locator('.ir-title')).toBeVisible();
  });

  test('keeps the note pane label current after a change made in reading mode', async () => {
    // The edit-mode bar is a CodeMirror panel, built once and kept while the
    // leaf switches to reading mode and back — so a label read once at build
    // time describes whatever was true then, not what a click would now do.
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );
    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);

    const editBar = window.locator('css=.markdown-source-view .ir-action-bar');
    const readingBar = window.locator('css=.ir-reading-mode-bar');
    // `exact`, or "Dismiss" also matches the "Un-dismiss" it turns into.
    const dismiss = (bar: Locator) =>
      bar.getByRole('button', { name: 'Dismiss', exact: true });
    const unDismiss = (bar: Locator) =>
      bar.getByRole('button', { name: 'Un-dismiss', exact: true });

    await dismiss(editBar).click();
    await expect(unDismiss(editBar)).toBeVisible();

    await executeCommandById(window, 'markdown:toggle-preview');
    await unDismiss(readingBar).click();
    await expect(dismiss(readingBar)).toBeVisible();

    await executeCommandById(window, 'markdown:toggle-preview');

    await expect(dismiss(editBar)).toBeVisible();
    await expect(unDismiss(editBar)).toHaveCount(0);
  });

  test('Can change priority from the review pane', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();

    const priorityInput = window.getByRole('textbox', { name: 'Priority' });

    // change the priority twice in rapid succession
    await priorityInput.fill('11');
    await priorityInput.press('Enter');
    await expect(priorityInput).toHaveValue('1.1');
    await priorityInput.fill('49');
    await priorityInput.press('Enter');
    await expect(priorityInput).toHaveValue('4.9');

    // re-open the review interface to verify the changes persisted. No begin
    // review step: the tab was closed on this item, so reopening lands straight
    // back on it rather than on the home screen.
    await executeCommandById(window, 'workspace:close');

    await executeCommandById(window, 'incremental-reading:learn');
    const priorityInput2 = window.getByRole('textbox', { name: 'Priority' });
    await expect(priorityInput2).toHaveValue('4.9');
  });

  test('note action bar sits on the iOS keyboard, not a keyboard height above it', async () => {
    await importArticle(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );
    await emulateMobile(window, true);
    await window.setViewportSize({ width: 400, height: 850 });
    await window.evaluate(() => {
      // With auto full screen on, the editor shrinking under the keyboard reads
      // as a scroll and hides the navbar, whose rule zeroes the lift and would
      // hide the bug. On a device the open keyboard stops that from happening.
      (
        window as unknown as {
          app: { vault: { setConfig(key: string, value: unknown): void } };
        }
      ).app.vault.setConfig('autoFullScreen', false);
    });
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );

    const leaf = '.workspace-leaf.mod-active';
    const bar = window.locator(`${leaf} .ir-action-bar-panel`);
    await expect(bar).toBeVisible();

    /** How far the bar's bottom edge sits above the editor's. */
    const lift = () =>
      window.evaluate((leaf) => {
        const editor = document.querySelector(`${leaf} .cm-editor`);
        const panel = document.querySelector(`${leaf} .ir-action-bar-panel`);
        if (!editor || !panel) return null;
        return (
          editor.getBoundingClientRect().bottom -
          panel.getBoundingClientRect().bottom
        );
      }, leaf);

    // Focusing the editor brings up Obsidian's toolbar, which takes the navbar
    // away, so none of the lift is owed to the navbar any more.
    await window.locator(`${leaf} .cm-content`).click();
    await expect(window.locator('.mobile-toolbar')).toBeVisible();

    // What Obsidian's iOS app reports with the keyboard up, read on an iPhone:
    // the bottom safe-area inset grows to cover the keyboard, on top of the
    // app container already shrinking by `--keyboard-height`.
    await window.evaluate(() => {
      document.documentElement.style.setProperty('--keyboard-height', '335px');
      document.body.style.setProperty('--safe-area-inset-bottom', '335px');
    });
    await expect.poll(lift).toBeLessThanOrEqual(1);

    // Keyboard down again: the navbar comes back, and the bar sits right on it
    await window.evaluate(() => {
      document.documentElement.style.removeProperty('--keyboard-height');
      document.body.style.removeProperty('--safe-area-inset-bottom');
      (document.activeElement as HTMLElement | null)?.blur();
    });
    const navbar = window.locator('.mobile-navbar');
    await expect(navbar).toBeVisible();
    await expect
      .poll(async () =>
        Math.round(
          (await navbar.evaluate((el) => el.getBoundingClientRect().top)) -
            (await bar.evaluate((el) => el.getBoundingClientRect().bottom))
        )
      )
      .toBe(0);
  });

  for (const device of [
    { name: 'phone', viewport: { width: 420, height: 900 }, isPhone: true },
    { name: 'tablet', viewport: { width: 1280, height: 800 }, isPhone: false },
  ]) {
    test(`action bars sit right on the navbar, or on the bottom safe area where there is none, on a ${device.name}, floating or not`, async () => {
      const NOTE =
        'sources/Memorizing a programming language using spaced repetition';
      await importArticle(window, NOTE);
      // Emulating reloads the app, and a reload mid-write empties the database
      await expect.poll(() => pendingSaves(window)).toBe(0);
      await emulateMobile(window, true);
      await window.setViewportSize(device.viewport);
      const body = window.locator('body');
      if (device.isPhone) await expect(body).toHaveClass(/\bis-phone\b/);
      else await expect(body).not.toHaveClass(/\bis-phone\b/);

      /**
       * The two appearance settings that decide whether the navbar floats
       * over the view or sits below it. Obsidian answers each by toggling a
       * class on <body> (`is-floating-nav`, `auto-full-screen`; obsidian.asar).
       *
       * Undocumented: the `floatingNavigation` and `autoFullScreen` vault
       * configs, set through `Vault.setConfig`.
       */
      const setNavigation = async (floating: boolean, autoFull: boolean) => {
        await window.evaluate(
          ([f, a]) => {
            const { vault } = (
              window as unknown as {
                app: {
                  vault: { setConfig(key: string, value: unknown): void };
                };
              }
            ).app;
            vault.setConfig('floatingNavigation', f);
            vault.setConfig('autoFullScreen', a);
          },
          [floating, autoFull]
        );
        await expect(body).toHaveClass(
          floating ? /\bis-floating-nav\b/ : /^(?!.*\bis-floating-nav\b)/
        );
        await expect(body).toHaveClass(
          autoFull ? /\bauto-full-screen\b/ : /^(?!.*\bauto-full-screen\b)/
        );
      };
      const modes = [
        { floating: false, autoFull: false },
        { floating: true, autoFull: false },
        { floating: false, autoFull: true },
        { floating: true, autoFull: true },
      ];

      const bottomOf = (locator: Locator) =>
        locator.evaluate((el) => el.getBoundingClientRect().bottom);
      const leaf = window.locator('.workspace-leaf.mod-active');

      /**
       * On a phone: the bar's bottom edge meets the navbar's top edge in every
       * mode — no strip of empty view between them when the navbar sits below
       * the view, and no overlap when it floats over it.
       *
       * On a tablet there's no navbar to clear (Obsidian hides it there), only
       * the bottom safe area, which the bar clears in every mode just as a
       * note's editing-mode bar does (Obsidian lifts its bottom panels by
       * `--safe-area-inset-bottom`; 34px under emulation).
       */
      const expectOnNavbar = async (bar: Locator) => {
        await expect(bar).toBeVisible();
        const viewContent = window.locator(
          '.workspace-leaf.mod-active .workspace-leaf-content > .view-content'
        );
        for (const { floating, autoFull } of modes) {
          await setNavigation(floating, autoFull);
          const mode = JSON.stringify({ floating, autoFull });
          if (device.isPhone) {
            const navbar = window.locator('.mobile-navbar');
            await expect(navbar).toBeVisible();
            await expect
              .poll(
                async () =>
                  Math.round(
                    (await navbar.evaluate(
                      (el) => el.getBoundingClientRect().top
                    )) - (await bottomOf(bar))
                  ),
                { message: `navbar top − bar bottom, ${mode}` }
              )
              .toBe(0);
          } else {
            await expect(window.locator('.mobile-navbar')).toBeHidden();
            const inset = await body.evaluate((el) =>
              Number.parseFloat(
                getComputedStyle(el).getPropertyValue(
                  '--safe-area-inset-bottom'
                )
              )
            );
            expect(inset).toBeGreaterThan(0);
            await expect
              .poll(
                async () =>
                  Math.round(
                    (await bottomOf(viewContent)) - (await bottomOf(bar))
                  ),
                { message: `view bottom − bar bottom, ${mode}` }
              )
              .toBe(inset);
          }
        }
      };

      await openNote(window, NOTE);
      await expectOnNavbar(
        leaf.locator('.markdown-source-view .ir-action-bar-panel')
      );

      await executeCommandById(window, 'markdown:toggle-preview');
      await expectOnNavbar(leaf.locator('.ir-reading-mode-bar'));

      await executeCommandById(window, 'incremental-reading:learn');
      await window.locator('css=#begin-review-button').click();
      await expect(reviewTitle(window, ARTICLE_TITLE)).toBeVisible();
      await expectOnNavbar(
        window.locator(
          '.workspace-leaf.mod-active .ir-review-interface .ir-action-bar'
        )
      );
    });
  }
});

test.describe('Extracting snippets', () => {
  test('Can extract from Markdown notes', async () => {
    await openNote(window, 'sources/Security Principles');

    // select a paragraph
    await selectParagraph(
      window,
      'Before we start discussing the different security principles'
    );
    await executeCommandById(window, 'incremental-reading:extract-selection');

    await openNote(
      window,
      `incremental-reading/snippets/Before we start discussing`
    );
    await expect(window.getByRole('button', { name: 'Review' })).toBeVisible();
  });

  test('Can extract from articles in review interface', async () => {
    await openNote(window, 'sources/Security Principles');

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();

    // look for the action bar to confirm we're in review
    await expect(
      window.getByRole('button', { name: 'Mark reviewed' })
    ).toBeVisible();

    await selectParagraph(
      window,
      'Before we start discussing the different security principles'
    );
    await executeCommandById(window, 'incremental-reading:extract-selection');

    // In a tab of its own: opened in the review tab, an item shows in review
    await executeCommandById(window, 'workspace:new-tab');
    await openNote(
      window,
      `incremental-reading/snippets/Before we start discussing`
    );
    await expect(window.getByRole('button', { name: 'Review' })).toBeVisible();
  });

  test('Can extract from snippets in review interface', async () => {
    await openNote(window, 'sources/Security Principles');

    // go to the first paragraph
    await window
      .getByText(
        'Security has become a buzzword; every company wants to claim its product or service is secure.'
      )
      .click();
    // go to the end of the second paragraph
    await window.getByRole('textbox').press('ControlOrMeta+ArrowDown');
    await window.getByRole('textbox').press('ControlOrMeta+ArrowDown');
    await window.getByRole('textbox').press('ControlOrMeta+ArrowDown');
    await window.waitForTimeout(300);
    await window.getByRole('textbox').press('ControlOrMeta+Shift+Home');
    await window.waitForTimeout(300);
    await executeCommandById(window, 'incremental-reading:extract-selection');

    await openNote(
      window,
      `incremental-reading/snippets/Security has become a buzzword`
    );
    // open the first snippet in review
    await window.getByRole('button', { name: 'Review' }).click();

    // look for the action bar to confirm we're in review
    await expect(
      window.getByRole('button', { name: 'Mark reviewed' })
    ).toBeInViewport();

    // Extract the second paragraph
    await selectParagraph(window, 'Before we start discussing');
    await executeCommandById(window, 'incremental-reading:extract-selection');

    // In a tab of its own: opened in the review tab, an item shows in review
    await executeCommandById(window, 'workspace:new-tab');
    await openNote(
      window,
      `incremental-reading/snippets/Before we start discussing`
    );
    await window.getByRole('button', { name: 'Review' }).click();

    // wait to reduce test flakiness
    await window.waitForTimeout(300);
    // look for the action bar to confirm we're in review
    await expect(
      window.getByRole('button', { name: 'Mark reviewed' })
    ).toBeInViewport();

    // Make sure the first line is absent so we know we're looking at the new snippet
    expect(
      await window
        .getByText(
          `Security has become a buzzword; every company wants to claim its ` +
            `product or service is secure.`
        )
        .filter({ visible: true })
        .count()
    ).toBe(0);
    await expect(
      window
        .getByText(
          `Before we start discussing the different security principles, it is ` +
            `vital to know the adversary against whom we are protecting our assets.`
        )
        .filter({ visible: true })
    ).toBeInViewport();
  });
});

test.describe('File explorer', () => {
  test('opens the note under review in a new tab', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );
    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    await expect(reviewTitle(window, ARTICLE_TITLE)).toBeVisible();

    // The review view is a FileView holding the item under review, so the item
    // is the workspace's active file and the explorer marks its row
    // `is-active`. That is precisely the row whose plain left click Obsidian
    // swallows, on the assumption the file is already on screen as a note.
    await executeCommandById(window, 'file-explorer:reveal-active-file');
    const activeRow = window.locator('.nav-file-title.is-active');
    await expect(activeRow).toHaveAttribute(
      'data-path',
      new RegExp(`${ARTICLE_TITLE}\\.md$`)
    );

    await activeRow.click();

    // The note opened as a note, in a tab of its own, and the review tab is
    // still there rather than having been navigated away.
    await expect(
      window.locator(
        '.workspace-leaf.mod-active .workspace-leaf-content[data-type="markdown"]'
      )
    ).toBeVisible();
    await expect(
      window.locator(
        `.workspace-leaf-content[data-type="incremental-reading-review"]`
      )
    ).toHaveCount(1);
  });
});

test.describe('Review session', () => {
  test('reopens on the item the tab was closed on', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );
    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    await expect(reviewTitle(window, ARTICLE_TITLE)).toBeVisible();

    await executeCommandById(window, 'workspace:close');
    await expect(reviewTitle(window, ARTICLE_TITLE)).not.toBeVisible();

    // Obsidian's own reopen, which mounts the view without going through the
    // plugin's Learn command — so the view is what has to resume the session.
    await executeCommandById(window, 'workspace:undo-close-pane');
    await expect(reviewTitle(window, ARTICLE_TITLE)).toBeVisible();

    // And again through Learn, which resumes before the view mounts and picks
    // the page itself. The home screen is for opening review with nothing in
    // progress, so a carried-over item skips it.
    await executeCommandById(window, 'workspace:close');
    await executeCommandById(window, 'incremental-reading:learn');
    await expect(reviewTitle(window, ARTICLE_TITLE)).toBeVisible();
  });

  test('resumes the item review was on after a reload, without writing the synced data.json', async () => {
    // `data.json` travels to every device with Sync, so the pointer lives in
    // this device's localStorage. Unofficial: `window.app`, `app.plugins`, and
    // `vault.writePluginData`, which `Plugin.saveData` writes through; the
    // vault outlives the plugin, so the watch sees the reloaded instance too.
    type WatchedWindow = {
      app: {
        vault: {
          writePluginData: (dir: string, ...rest: unknown[]) => unknown;
        };
        plugins: {
          plugins: Record<string, unknown>;
          disablePlugin(id: string): Promise<void>;
          enablePlugin(id: string): Promise<boolean>;
        };
      };
      __irDataWrites: string[];
    };
    await window.evaluate(() => {
      const page = window as unknown as WatchedWindow;
      const { vault } = page.app;
      const { writePluginData } = vault;
      page.__irDataWrites = [];
      vault.writePluginData = (dir, ...rest) => {
        if (dir.endsWith('incremental-reading')) page.__irDataWrites.push(dir);
        return writePluginData.call(vault, dir, ...rest);
      };
    });

    for (const note of [
      'sources/Memorizing a programming language using spaced repetition',
      'sources/Security Principles',
    ]) {
      await openNote(window, note);
      await executeCommandById(window, 'incremental-reading:import-article');
      await finalizeArticleImport(window);
    }
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    await expect(window.locator('.ir-title')).toBeVisible();
    // Whichever of the two comes first, review moves on to the other
    const second = (await reviewTitle(window, ARTICLE_TITLE).isVisible())
      ? 'Security Principles'
      : ARTICLE_TITLE;
    await window
      .getByRole('button', { name: 'Skip for current review session' })
      .click();
    await expect(reviewTitle(window, second)).toBeVisible();

    // Loaded again, as at the next start
    await window.evaluate(async () => {
      const { plugins } = (window as unknown as WatchedWindow).app;
      await plugins.disablePlugin('incremental-reading');
      await plugins.enablePlugin('incremental-reading');
    });
    await expect
      .poll(() =>
        window.evaluate(
          () =>
            'incremental-reading' in
            (window as unknown as WatchedWindow).app.plugins.plugins
        )
      )
      .toBe(true);

    // The review tab outlives the plugin and mounts again, resuming by itself
    // (Learn would toggle the focused tab home instead)
    await expect(reviewTitle(window, second)).toBeVisible();
    expect(
      await window.evaluate(
        () => (window as unknown as WatchedWindow).__irDataWrites
      )
    ).toEqual([]);
  });

  test('lands on the home screen when the remembered item is dismissed elsewhere', async () => {
    // Dismissing from the note's own pane happens with no review tab open, so
    // the plugin has no current item to match the dismissal against — the
    // remembered pointer is the only thing still naming it.
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );
    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);

    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    await expect(reviewTitle(window, ARTICLE_TITLE)).toBeVisible();

    await executeCommandById(window, 'workspace:close');
    const dismissButton = window.getByRole('button', { name: 'Dismiss' });
    await expect(dismissButton).toBeInViewport();
    await dismissButton.click();

    // Nothing is scheduling that item any more, so review opens with nothing in
    // progress: the home screen, this vault's setting being the default.
    await executeCommandById(window, 'incremental-reading:learn');

    await expect(window.locator('css=#begin-review-button')).toBeVisible();
  });

  test('honours the skipped home screen on a tab Obsidian reopens', async () => {
    // Obsidian's own reopen never reaches the Learn command, which is the only
    // other place the setting is applied — so with nothing left to resume, the
    // view has to apply it itself or the tab lands on the queue table.
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );
    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await setPluginSetting(window, 'skipHomeScreen', true);

    await executeCommandById(window, 'incremental-reading:learn');
    await expect(reviewTitle(window, ARTICLE_TITLE)).toBeVisible();

    // Back to the home screen, which drops the remembered item: reopening is
    // then review opening with nothing in progress, which is what the setting
    // is about.
    await executeCommandById(window, 'incremental-reading:learn');
    await expect(window.locator('css=#begin-review-button')).toBeVisible();

    await executeCommandById(window, 'workspace:close');
    await executeCommandById(window, 'workspace:undo-close-pane');

    await expect(reviewTitle(window, ARTICLE_TITLE)).toBeVisible();
    await expect(window.locator('css=#begin-review-button')).toHaveCount(0);
  });

  /**
   * Unofficial: `window.app`, `app.plugins.plugins`, `reviewManager.repo`,
   * and the plugin's `store`.
   */
  type PluginWindow = {
    app: {
      plugins: {
        plugins: Record<
          string,
          {
            reviewManager: {
              repo: { mutate(sql: string, params: unknown[]): unknown };
            };
            store: { dispatch(action: unknown): void };
          }
        >;
      };
    };
  };

  /**
   * Add `count` due articles whose notes are gone, all due before anything
   * imported, and mark every one seen this session, as skipping each would.
   */
  async function seedSeenArticles(count: number) {
    await window.evaluate(async (count) => {
      const plugin = (window as unknown as PluginWindow).app.plugins.plugins[
        'incremental-reading'
      ];
      // One statement, so the seed costs one save rather than one per row
      await plugin.reviewManager.repo.mutate(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < $1)
         INSERT INTO article (id, reference, due, interval, priority)
         SELECT 'seen-' || i, 'gone/seen-' || i || '.md', i, 1, 30 FROM n`,
        [count - 1]
      );
      const resetTime = Date.now() + 24 * 60 * 60 * 1000;
      for (let i = 0; i < count; i++) {
        // The action `addSeenId` in lib/store.ts creates, as skipping dispatches
        plugin.store.dispatch({
          type: 'seenIds/addSeenId',
          payload: { id: `seen-${i}`, resetTime },
        });
      }
    }, count);
  }

  test('keeps finding due items after more were seen than one query can bind', async () => {
    // Every id seen this session is left out of the next due query. Each used
    // to be its own bound parameter, so a long enough session ran into
    // SQLite's limit and every due query from then on failed.
    await importArticle(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );
    await importArticle(window, 'sources/Security Principles');
    await executeCommandById(window, 'incremental-reading:learn');
    const beginReview = window.locator('css=#begin-review-button');
    await expect(beginReview).toBeEnabled();
    await seedSeenArticles(MAX_SQL_QUERY_PARAMS + 101);

    await beginReview.click();
    const first = await waitForReviewItem(window);
    expect(first.id).not.toMatch(/^seen-/);
    const other =
      first.title === ARTICLE_TITLE ? 'Security Principles' : ARTICLE_TITLE;

    // Skipping adds one more seen id. Bounded well inside
    // `CURRENT_ITEM_REFETCH_TIME`: a skip that failed to move review on must
    // not pass by the five-second poll moving it instead.
    const skipButton = window.getByRole('button', {
      name: 'Skip for current review session',
    });
    await expect(skipButton).toBeInViewport();
    await skipButton.click();
    await expect(reviewTitle(window, other)).toBeVisible({ timeout: 1_500 });
    await expect(window.locator('.ir-review-error')).toHaveCount(0);
    await expect(window.locator('.ir-review-summary')).toHaveCount(0);
  });
});

test.describe('Review tab title', () => {
  /** Set every article's due date, through the plugin's own database. */
  async function setArticlesDue(page: Page, due: number) {
    await page.evaluate(async (at) => {
      // Unofficial: `window.app`, `app.plugins.plugins`
      await (window as unknown as RepoWindow).app.plugins.plugins[
        'incremental-reading'
      ].reviewManager.repo.mutate('UPDATE article SET due = $1, due_fuzz = 0', [
        at,
      ]);
    }, due);
  }

  /** The active review tab's header, and the name its tooltip reads. */
  const tabHeader = (page: Page) =>
    page.locator(
      `.workspace-tabs.mod-active .workspace-tab-header.is-active[data-type="${REVIEW_VIEW_TYPE}"]`
    );

  /** No card text in the tab header, the view header or the window title. */
  async function expectCardHidden(page: Page) {
    await expect(
      tabHeader(page).locator('.workspace-tab-header-inner-title')
    ).toHaveText(REVIEW_VIEW_DEFAULT_TITLE);
    await expect(tabHeader(page)).toHaveAttribute(
      'aria-label',
      REVIEW_VIEW_DEFAULT_TITLE
    );
    // The whole view header title, breadcrumb included: no cards folder in
    // front, exactly as on the home screen
    await expect(
      reviewHeader(page).locator('.view-header-title-container')
    ).toHaveText(REVIEW_VIEW_DEFAULT_TITLE);
    // The window title, which the OS taskbar shows
    await expect(page).toHaveTitle(new RegExp(`^${REVIEW_VIEW_DEFAULT_TITLE}`));
    await expect(page).not.toHaveTitle(/Explain the security/);
  }

  test("shows the plugin's name over a card, and an article's name over the article after it", async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );
    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    // Held back until the card is up, so the card comes first
    await setArticlesDue(window, Date.now() + 86_400_000);

    await reviewNewCard(window);
    await expectCardHidden(window);
    await window.getByRole('button', { name: 'Show answer' }).click();
    await expectCardHidden(window);

    await setArticlesDue(window, Date.now() - 1);
    await window.getByRole('button', { name: 'Good', exact: true }).click();

    expect((await waitForReviewItem(window)).title).toBe(ARTICLE_TITLE);
    await expect(tabHeader(window)).toHaveAttribute(
      'aria-label',
      ARTICLE_TITLE
    );
    // The article's folder is back in front of its name
    const folder = await window.evaluate(
      () =>
        // Unofficial: `window.app`
        (
          window as unknown as {
            app: {
              workspace: {
                getMostRecentLeaf(): {
                  view: { file?: { parent?: { path: string } | null } };
                } | null;
              };
            };
          }
        ).app.workspace.getMostRecentLeaf()?.view.file?.parent?.path ?? ''
    );
    expect(folder).not.toBe('');
    await expect(
      reviewHeader(window).locator('.view-header-title-container')
    ).toHaveText(`${folder}/${ARTICLE_TITLE}`);
    await expect(window).toHaveTitle(new RegExp(`^${ARTICLE_TITLE}`));
  });
});

test.describe('Card embeds', () => {
  /** The list item this test turns into a card, as it reads in the source. */
  const BULLET_TEXT =
    'Explain the security functions: Confidentiality, Integrity and Availability (CIA).';

  test('leave no blank line above their text', async () => {
    await openNote(window, 'sources/Security Principles');
    await selectParagraph(window, BULLET_TEXT);
    await executeCommandById(window, 'incremental-reading:create-card');
    await executeCommandById(window, 'markdown:toggle-preview');

    const embed = window.locator(
      '.markdown-reading-view .internal-embed[alt*="ir-hide-title"].is-loaded'
    );
    await expect(embed).toBeVisible();

    // Measured rather than asserted on a class or a height, because the bug
    // this covers is a cascade accident with no name in the DOM: a chrome
    // section inside the embed — the hidden inline title, the frontmatter
    // block — picking up `display: block`, which splits the inline chain and
    // pushes the transcluded text onto a line of its own. Nothing in the
    // markup says so; only where the text lands does.
    //
    // The reference is where the embed itself starts, not the top of its host
    // block: a card need not open its block — delete the newline above one and
    // it continues the preceding sentence — so "the block's first line" is a
    // fact about this fixture, while "the line the embed starts on" is the
    // invariant. `getClientRects()[0]` is that line: an inline box reports one
    // rect per line fragment, and the first is where the run begins.
    //
    // Polled because `.is-loaded` lands before the transcluded markdown is in
    // the tree: the embed renders an empty second content wrapper alongside
    // the real one, so a `p` read too early can be the empty one.
    await expect(async () => {
      const layout = await embed.evaluate((el) => {
        // The first paragraph that is actually laid out. The embed keeps a
        // second, display:none content wrapper whose `p` measures zero.
        const paragraph = Array.from(el.querySelectorAll('p')).find(
          (candidate) => candidate.getBoundingClientRect().height > 0
        );
        const start = el.getClientRects()[0];
        if (!paragraph || !start) return null;

        return {
          startTop: start.top,
          // Its top edge is its first line box even when the run wraps, which
          // is the line the text is supposed to begin on.
          textTop: paragraph.getBoundingClientRect().top,
          lineHeight: Number.parseFloat(
            getComputedStyle(el.parentElement as HTMLElement).lineHeight
          ),
          // The run's own tint, which has to survive the fix: painted on the
          // inline fragments so it can cover part of a line.
          tint: getComputedStyle(el).backgroundColor,
        };
      });

      expect(layout).not.toBeNull();
      expect(layout!.lineHeight).toBeGreaterThan(0);
      // Half a line of slack: enough for the run's own box and the text's line
      // box to differ, far less than the full line a break costs.
      expect(Math.abs(layout!.textTop - layout!.startTop)).toBeLessThan(
        layout!.lineHeight / 2
      );
      expect(layout!.tint).not.toBe('rgba(0, 0, 0, 0)');
    }).toPass({ timeout: 30_000 });
  });

  test('mark only the rows of a card made from part of a paragraph, with the open button on the first', async () => {
    /** The middle of a paragraph that wraps well past it on either side. */
    const SPAN =
      'Are you trying to stop a toddler from accessing your laptop? Or are ' +
      'you trying to protect a laptop that contains technical designs worth ' +
      'millions of dollars?';

    await importArticle(window, 'sources/Security Principles');
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    await expect(reviewTitle(window, 'Security Principles')).toBeVisible();
    const content = window.locator(
      '.workspace-leaf.mod-active .ir-editor .cm-content'
    );
    await expect(content).toContainText(SPAN);

    // Made the way selection mode makes it, minus the UI for picking the span
    // and the answer: the embed replaces the span and nothing else, so the
    // paragraph's own text stays on the rows around it.
    await window.evaluate(async (span) => {
      const { app } = window as unknown as {
        app: {
          workspace: { activeEditor: { editor: { getValue(): string } } };
          plugins: {
            plugins: Record<
              string,
              {
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
      const from = app.workspace.activeEditor.editor.getValue().indexOf(span);
      if (from < 0) throw new Error('span not in the review editor');
      await app.plugins.plugins['incremental-reading'].actions.createCard({
        selection: { from, to: from + span.length, text: span },
        answer: [4, 7],
      });
    }, SPAN);

    const embed = content.locator(
      '.cm-line > .internal-embed[alt*="ir-hide-title"].is-loaded'
    );
    await expect(embed).toBeVisible();

    /**
     * The embed's rows, the rule, and the button, in viewport pixels. The rule
     * is a pseudo-element, so it is placed from its computed box, which
     * resolves against the host line.
     */
    const measure = () =>
      embed.evaluate((el) => {
        const host = el.parentElement as HTMLElement;
        const hostRect = host.getBoundingClientRect();
        const rows = Array.from(el.getClientRects()).filter(
          (rect) => rect.height > 0
        );
        const before = getComputedStyle(el, '::before');
        const link = el.querySelector(':scope > .markdown-embed-link');
        const linkRect = link?.getBoundingClientRect();
        const ruleTop = hostRect.top + Number.parseFloat(before.top);
        return {
          host: {
            top: hostRect.top,
            bottom: hostRect.bottom,
            right: hostRect.right,
          },
          lineHeight: Number.parseFloat(getComputedStyle(host).lineHeight),
          rows: rows.map((rect) => ({ top: rect.top, bottom: rect.bottom })),
          rule: {
            top: ruleTop,
            bottom: ruleTop + Number.parseFloat(before.height),
            left: hostRect.left + Number.parseFloat(before.left),
            color: before.backgroundColor,
          },
          hostLeft: hostRect.left,
          link: linkRect && {
            top: linkRect.top,
            bottom: linkRect.bottom,
            right: linkRect.right,
          },
        };
      });

    // Two widths, so the rows the card wraps across change under a resize and
    // the rule has to follow them. Pinned: CI's window is much narrower than a
    // local headless run's.
    for (const width of [1000, 760]) {
      await window.setViewportSize({ width, height: 800 });

      // Polled: the embed fills in after it is created, and the geometry is
      // measured on the frame after the layout it follows.
      await expect(async () => {
        const m = await measure();
        const first = m.rows[0];
        const last = m.rows[m.rows.length - 1];
        const slack = m.lineHeight / 2;

        // Not vacuous: the paragraph has rows of its own text above and below
        // the card's, and the card itself wraps.
        expect(m.rows.length).toBeGreaterThan(1);
        expect(first.top - m.host.top).toBeGreaterThan(slack);
        expect(m.host.bottom - last.bottom).toBeGreaterThan(slack);

        // The rule spans the card's rows, and none of the paragraph's.
        expect(m.rule.color).not.toBe('rgba(0, 0, 0, 0)');
        expect(Math.abs(m.rule.top - first.top)).toBeLessThan(slack);
        expect(Math.abs(m.rule.bottom - last.bottom)).toBeLessThan(slack);
        expect(Math.abs(m.rule.left - m.hostLeft)).toBeLessThan(slack);

        // The button sits at the end of the card's first row.
        expect(m.link).toBeTruthy();
        const linkCenter = (m.link!.top + m.link!.bottom) / 2;
        expect(linkCenter).toBeGreaterThan(first.top);
        expect(linkCenter).toBeLessThan(first.bottom);
        expect(Math.abs(m.link!.right - m.host.right)).toBeLessThan(
          m.lineHeight
        );
      }).toPass({ timeout: 15_000 });
    }
  });
});

test.describe('Highlights past the note’s end', () => {
  const SOURCE = 'sources/Security Principles';
  /** Three snippets' texts, in the order the note has them. */
  const TEXTS = [
    'The objective of this room is to:',
    'Explain the security functions: Confidentiality, Integrity and Availability (CIA).',
    'Introduce ISO/IEC 19249.',
  ];

  /**
   * The active editor, as the page-side calls below reach it.
   *
   * Unofficial: `window.app`, `app.plugins.plugins`, `reviewManager.repo`.
   */
  type PageApp = {
    workspace: {
      activeEditor: {
        editor: {
          getValue(): string;
          offsetToPos(offset: number): unknown;
          setSelection(anchor: unknown, head?: unknown): void;
          focus(): void;
        };
      };
    };
    plugins: {
      plugins: Record<
        string,
        {
          reviewManager: {
            repo: {
              query(sql: string): unknown[];
              mutate(sql: string, params: unknown[]): unknown;
            };
            refreshAllHighlights(): Promise<void>;
          };
        }
      >;
    };
  };

  /** Extract each of {@link TEXTS} from the note at `path`, open in the active tab. */
  async function extractAll(path: string) {
    for (const [i, text] of TEXTS.entries()) {
      await scrollToText(window, text);
      await window.evaluate((text) => {
        const { editor } = (window as unknown as { app: PageApp }).app.workspace
          .activeEditor;
        const at = editor.getValue().indexOf(text);
        editor.setSelection(
          editor.offsetToPos(at),
          editor.offsetToPos(at + text.length)
        );
      }, text);
      await executeCommandById(window, 'incremental-reading:extract-selection');
      await expectExtractSettled(window, path, i + 1);
    }
  }

  /**
   * Store the second snippet's offsets as running past the note's end, and
   * the third's as wholly past it, as a note shortened behind the plugin's
   * back leaves them; then have open views read them, as a synced database
   * does. Returns the offsets stored.
   */
  async function makeStale(path: string) {
    const { rows, diskText } = await readSnippetState(window, path);
    const bodyLength = noteBody(diskText).length;
    const stale = [
      [rows[1].start_offset, bodyLength + 40],
      [bodyLength + 100, bodyLength + 120],
    ];
    await window.evaluate(
      async ([ids, stale]) => {
        const { reviewManager } = (window as unknown as { app: PageApp }).app
          .plugins.plugins['incremental-reading'];
        ids.forEach((id, i) =>
          reviewManager.repo.mutate(
            'UPDATE snippet SET start_offset = $1, end_offset = $2 WHERE id = $3',
            [...stale[i], id]
          )
        );
        await reviewManager.refreshAllHighlights();
      },
      [[rows[1].id, rows[2].id], stale] as const
    );
    return { ids: rows.map(({ id }) => id), stale };
  }

  /** Errors the page throws or logs from now on that a crash would raise. */
  function watchCrashes() {
    const crashes: string[] = [];
    window.on('pageerror', (error) => crashes.push(error.message));
    window.on('console', (message) => {
      if (
        message.type() === 'error' &&
        /RangeError|plugin crashed/i.test(message.text())
      ) {
        crashes.push(message.text());
      }
    });
    return crashes;
  }

  /** Type `text` at the start of the active editor's body, as a reader does. */
  async function typeAtBodyStart(text: string) {
    await window.evaluate(() => {
      const { editor } = (window as unknown as { app: PageApp }).app.workspace
        .activeEditor;
      const value = editor.getValue();
      const body = /^---\n[\s\S]*?\n---\n/.exec(value)?.[0].length ?? 0;
      editor.setSelection(editor.offsetToPos(body));
      editor.focus();
    });
    await window.keyboard.type(text);
  }

  /**
   * Make two of three snippets of the note at `path` stale, reopen it with
   * `open` so it loads them so, type in it, and check the first is painted and
   * moved, the other two shown as far as they are in the note and kept as far
   * past its end, and nothing threw. Returns the snippets' ids, in
   * the note's order.
   */
  async function expectNoCrash(path: string, open: () => Promise<void>) {
    const crashes = watchCrashes();
    await extractAll(path);
    const { ids, stale } = await makeStale(path);
    await executeCommandById(window, 'workspace:close');
    await open();
    await scrollToText(window, TEXTS[0]);

    await typeAtBodyStart('Z');

    // Polled: the edit, then its offsets, reach the disk on their debounces.
    // The first is still painted on its text, so the plugin still runs; the
    // second up to the note's end; the third nowhere. Both stored as far past
    // the end as before, the note one character longer.
    await expect
      .poll(async () => {
        const { rows, diskText, painted } = await readSnippetState(
          window,
          path
        );
        const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
        const body = noteBody(diskText);
        const [first, second, third] = ids.map((id) => byId[id]);
        return {
          saved: body.startsWith('Z'),
          firstShown: painted[first.id],
          firstStored: body.slice(first.start_offset, first.end_offset),
          secondShownFromItsStart: painted[second.id].startsWith(TEXTS[1]),
          secondStored: [second.start_offset, second.end_offset],
          thirdShown: painted[third.id],
          thirdStored: [third.start_offset, third.end_offset],
        };
      })
      .toEqual({
        saved: true,
        firstShown: TEXTS[0],
        firstStored: TEXTS[0],
        secondShownFromItsStart: true,
        secondStored: stale[0].map((offset) => offset + 1),
        thirdShown: '',
        thirdStored: stale[1].map((offset) => offset + 1),
      });
    expect(crashes).toEqual([]);
    return ids;
  }

  test('neither crash the editor nor keep the others from being painted and moved', async () => {
    const open = () => openNote(window, SOURCE);
    await open();
    const ids = await expectNoCrash(`${SOURCE}.md`, open);

    // Reading mode paints them as live preview does
    const crashes = watchCrashes();
    await executeCommandById(window, 'markdown:toggle-preview');
    const painted = (id: string) =>
      window
        .locator(
          `.workspace-leaf.mod-active .markdown-reading-view .ir-snippet-highlight[data-snippet-id="${id}"]`
        )
        .allTextContents()
        .then((texts) => texts.join(''));
    await expect
      .poll(async () => ({
        first: await painted(ids[0]),
        secondFromItsStart: (await painted(ids[1])).startsWith(TEXTS[1]),
        third: await painted(ids[2]),
      }))
      .toEqual({ first: TEXTS[0], secondFromItsStart: true, third: '' });
    expect(crashes).toEqual([]);
  });

  test('neither crash review nor keep the others from being painted and moved', async () => {
    await importArticle(window, SOURCE);
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    const markReviewed = window.getByRole('button', { name: 'Mark reviewed' });
    await expect(markReviewed).toBeVisible();
    const reference = await window.evaluate(
      () =>
        (
          (window as unknown as { app: PageApp }).app.plugins.plugins[
            'incremental-reading'
          ].reviewManager.repo.query('SELECT reference FROM article') as {
            reference: string;
          }[]
        )[0].reference
    );
    // Review opens again on the article it was on
    await expectNoCrash(reference, async () => {
      await executeCommandById(window, 'incremental-reading:learn');
      await expect(markReviewed).toBeVisible();
    });
  });
});

test.describe('Frontmatter', () => {
  /** The note the import writes `ir-id` and `tags` into, as a quick-switcher prefix. */
  const SOURCE_NOTE =
    'sources/Memorizing a programming language using spaced repetition';

  /**
   * Assert the note's properties are off screen while its body is on it.
   *
   * `ir-id` is written by the import and lives only in the note's YAML, so it
   * appears in the editor exactly when the frontmatter is being rendered. The
   * line count is what keeps that from passing vacuously on an editor that has
   * not drawn anything yet.
   */
  async function expectFrontmatterHidden(window: Page) {
    const editor = window.locator('.ir-review-scroller');
    await expect(editor).toBeVisible();
    await expect(editor.locator('.cm-line').first()).toBeVisible();
    await expect(editor).not.toContainText('ir-id');
  }

  test('stays hidden when the vault opens editors in source mode', async () => {
    // Obsidian builds the extension that hides frontmatter only on an editor
    // that is in live preview, so with this setting the plugin used to have
    // none to install and review rendered the raw YAML.
    await setDefaultEditingMode(window, 'source');

    await importArticle(window, SOURCE_NOTE);
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    await waitForReviewItem(window);

    await expectFrontmatterHidden(window);
  });

  test('stays hidden across a switch into source mode and back', async () => {
    await setDefaultEditingMode(window, 'live-preview');

    await importArticle(window, SOURCE_NOTE);
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    await waitForReviewItem(window);
    await expectFrontmatterHidden(window);

    await toggleReviewSourceMode(window);
    await expectFrontmatterHidden(window);

    await toggleReviewSourceMode(window);
    await expectFrontmatterHidden(window);
  });
});

test.describe('PDF articles', () => {
  const PDF_PATH = 'papers/Paper.pdf';
  const RENAMED_PATH = 'papers/Renamed.pdf';
  const PDF_ID = 'pdf-article';

  /** A one-page PDF: header, catalog, page tree, one blank page. */
  const PDF_BYTES = Buffer.from(
    '%PDF-1.4\n' +
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
      'trailer<</Root 1 0 R>>\n%%EOF\n',
    'latin1'
  );

  /** What the page-side calls below reach on Obsidian and the plugin. */
  type PageApp = {
    vault: {
      getFileByPath(path: string): unknown;
    };
    fileManager: { renameFile(file: unknown, newPath: string): Promise<void> };
    workspace: {
      getLeaf(newLeaf: 'tab' | false): {
        openFile(file: unknown, openState?: unknown): Promise<void>;
      };
    };
    plugins: {
      plugins: Record<
        string,
        {
          reviewManager: {
            repo: {
              mutate(sql: string, params?: unknown[]): Promise<unknown>;
            };
          };
        }
      >;
    };
  };

  const pdfBytes = (at: string) => fs.readFile(path.join(vaultPath, at));

  /** Whether Obsidian has indexed a file at `at`. */
  const hasFile = (page: Page, at: string) =>
    page.evaluate(
      (p) =>
        (window as unknown as { app: PageApp }).app.vault.getFileByPath(p) !==
        null,
      at
    );

  /**
   * Take Obsidian's PDF viewer away from review, as an Obsidian whose PDF
   * internals changed would, so review shows the "Open in PDF tab" placeholder.
   */
  const withoutPdfViewer = (page: Page) =>
    page.evaluate(() => {
      const { app } = window as unknown as {
        app: { embedRegistry: { embedByExtension: Record<string, unknown> } };
      };
      app.embedRegistry.embedByExtension.pdf = () => ({});
    });

  /** Put the PDF in the vault, with an article row due for it. */
  async function seedPdfArticle() {
    await fs.mkdir(path.join(vaultPath, 'papers'), { recursive: true });
    await fs.writeFile(path.join(vaultPath, PDF_PATH), PDF_BYTES);
    await expect.poll(() => hasFile(window, PDF_PATH)).toBe(true);

    // Seeded directly, the way the old unguarded import left such rows behind
    await window.evaluate(
      async ([id, reference]) => {
        const { app } = window as unknown as { app: PageApp };
        const { repo } =
          app.plugins.plugins['incremental-reading'].reviewManager;
        await repo.mutate(
          'INSERT INTO article (id, reference, due, interval, priority) VALUES ($1, $2, $3, $4, $5)',
          [id, reference, Date.now() - 1000, 86_400_000, 30]
        );
      },
      [PDF_ID, PDF_PATH]
    );
  }

  test('puts the action bar on PDF article tabs only, and keeps it in step as the tab changes file', async () => {
    const OTHER_PATH = 'papers/Other.pdf';
    await seedPdfArticle();
    await fs.writeFile(path.join(vaultPath, OTHER_PATH), PDF_BYTES);
    await expect.poll(() => hasFile(window, OTHER_PATH)).toBe(true);
    // Pinned, so the layout checks below don't depend on the window CI gets
    await window.setViewportSize({ width: 1280, height: 800 });

    /** Opens `at` in a new tab, or in place of whatever the active tab shows. */
    const open = (at: string, inNewTab: boolean) =>
      window.evaluate(
        async ([p, newTab]) => {
          const { app } = window as unknown as { app: PageApp };
          await app.workspace
            .getLeaf(newTab ? 'tab' : false)
            .openFile(app.vault.getFileByPath(p));
        },
        [at, inNewTab] as const
      );
    const pdfTabs = window.locator('.workspace-tab-header[data-type="pdf"]');
    const activePdf = window.locator(
      '.workspace-leaf.mod-active .workspace-leaf-content[data-type="pdf"]'
    );
    const bar = activePdf.locator('.ir-pdf-leaf-bar');

    await open(PDF_PATH, true);
    await expect(bar).toHaveCount(1);
    await expect(bar.getByRole('button', { name: 'Dismiss' })).toBeVisible();

    // Above Obsidian's own toolbar and viewer, taking room rather than
    // covering them
    const toolbar = activePdf.locator('.view-content > .pdf-toolbar');
    await expect(toolbar).toBeVisible();
    const barBox = (await bar.boundingBox())!;
    const toolbarBox = (await toolbar.boundingBox())!;
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(toolbarBox.y + 1);

    // The same tab, swapped to a PDF that isn't an article and back
    await open(OTHER_PATH, false);
    await expect(bar).toHaveCount(0);
    await open(PDF_PATH, false);
    await expect(bar).toHaveCount(1);
    await expect(pdfTabs).toHaveCount(1);

    // Works the row it stands for, and never the PDF
    await bar.getByRole('button', { name: 'Dismiss' }).click();
    await expect(bar.getByRole('button', { name: 'Un-dismiss' })).toBeVisible();
    expect((await pdfBytes(PDF_PATH)).equals(PDF_BYTES)).toBe(true);

    // Renamed while open: the row follows it, and so does the bar
    await window.evaluate(
      async ([from, to]) => {
        const { app } = window as unknown as { app: PageApp };
        await app.fileManager.renameFile(app.vault.getFileByPath(from), to);
      },
      [PDF_PATH, RENAMED_PATH]
    );
    await expect(pdfTabs).toHaveText('Renamed');
    await expect(bar).toHaveCount(1);
    await expect(bar.getByRole('button', { name: 'Un-dismiss' })).toBeVisible();

    // A PDF that isn't an article, in a tab of its own, gets a bar only once a
    // row makes it one
    await open(OTHER_PATH, true);
    await expect(toolbar).toBeVisible();
    await expect(bar).toHaveCount(0);
    await window.evaluate(async (reference) => {
      const { app } = window as unknown as { app: PageApp };
      await app.plugins.plugins[
        'incremental-reading'
      ].reviewManager.repo.mutate(
        'INSERT INTO article (id, reference, due, interval, priority) VALUES ($1, $2, $3, $4, $5)',
        ['other-pdf', reference, Date.now() + 1e9, 86_400_000, 30]
      );
    }, OTHER_PATH);
    await expect(bar).toHaveCount(1);
    await expect(pdfTabs).toHaveCount(2);
  });

  for (const device of [
    { name: 'phone', viewport: { width: 400, height: 850 }, isPhone: true },
    { name: 'tablet', viewport: { width: 1280, height: 800 }, isPhone: false },
  ]) {
    test(`puts a PDF article tab's action bar at the bottom on a ${device.name}, where a note's goes`, async () => {
      const NOTE = 'sources/Security Principles';
      await seedPdfArticle();
      await importArticle(window, NOTE);
      // Reloading under a database write leaves a file the plugin can't load
      await expect.poll(() => pendingSaves(window)).toBe(0);

      // The reload into mobile starts from an empty workspace. The window is
      // sized before the PDF opens: resizing an open PDF moves pdf.js around.
      await emulateMobile(window, true);
      await window.setViewportSize(device.viewport);
      const body = window.locator('body');
      if (device.isPhone) await expect(body).toHaveClass(/\bis-phone\b/);
      else await expect(body).not.toHaveClass(/\bis-phone\b/);

      /** Shows `at` in the active tab, a note in reading mode. */
      const open = (at: string) =>
        window.evaluate(async (p) => {
          const { app } = window as unknown as { app: PageApp };
          await app.workspace
            .getLeaf(false)
            .openFile(app.vault.getFileByPath(p), {
              active: true,
              state: { mode: 'preview' },
            });
        }, at);
      const leaf = window.locator('.workspace-leaf.mod-active');
      const bottomOf = async (locator: Locator) => {
        const box = (await locator.boundingBox())!;
        return box.y + box.height;
      };

      const viewContent = leaf.locator(
        '.workspace-leaf-content > .view-content'
      );
      /**
       * Where `bar` settles while the navbar is hidden. Auto full screen hides
       * a phone's navbar by putting `is-hidden-nav` on <body> (read from
       * obsidian.asar), and the bar drops to its tab's bottom edge with it, on
       * a 0.3s transition. The navbar comes back before this returns.
       */
      const bottomWithNavHidden = async (bar: Locator) => {
        const shown = await bottomOf(bar);
        await window.evaluate(() =>
          document.body.classList.add('is-hidden-nav')
        );
        const viewBottom = await bottomOf(viewContent);
        await expect
          .poll(async () => Math.abs((await bottomOf(bar)) - viewBottom))
          .toBeLessThan(1);
        const hidden = await bottomOf(bar);
        await window.evaluate(() =>
          document.body.classList.remove('is-hidden-nav')
        );
        await expect
          .poll(async () => Math.abs((await bottomOf(bar)) - shown))
          .toBeLessThan(1);
        return hidden;
      };

      // Where a note puts its bar on this device: the bottom, clear of the
      // navbar wherever there is one
      await open(`${NOTE}.md`);
      const noteBar = leaf.locator('.ir-reading-mode-bar');
      await expect(noteBar).toBeVisible();
      const noteBarBottom = await bottomOf(noteBar);
      const noteHiddenNavBottom = device.isPhone
        ? await bottomWithNavHidden(noteBar)
        : null;

      await open(PDF_PATH);
      const pdfBar = leaf.locator('.ir-pdf-leaf-bar');
      const container = leaf.locator('.view-content > .pdf-container');
      await expect(pdfBar).toBeVisible();
      await expect(container).toBeVisible();

      // Below the viewer, taking room rather than covering it, and level with
      // the note's bar
      expect((await pdfBar.boundingBox())!.y).toBeGreaterThanOrEqual(
        (await bottomOf(container)) - 1
      );
      expect(Math.abs((await bottomOf(pdfBar)) - noteBarBottom)).toBeLessThan(
        1
      );
      if (noteHiddenNavBottom === null) return;

      // Clear of the phone's navbar, rather than level with a note's bar that
      // might itself have slipped under it
      const navbar = window.locator('.mobile-navbar');
      await expect(navbar).toBeVisible();
      expect(await bottomOf(pdfBar)).toBeLessThanOrEqual(
        (await navbar.boundingBox())!.y + 1
      );

      // And down with the navbar when it hides, as far as the note's bar goes
      expect(
        Math.abs((await bottomWithNavHidden(pdfBar)) - noteHiddenNavBottom)
      ).toBeLessThan(1);
    });
  }

  test("a PDF article tab's bar is the same compact icon row", async () => {
    await seedPdfArticle();
    // Pinned, so the layout checks below don't depend on the window CI gets
    await window.setViewportSize({ width: 1280, height: 800 });
    await window.evaluate(async (at) => {
      const { app } = window as unknown as { app: PageApp };
      await app.workspace.getLeaf('tab').openFile(app.vault.getFileByPath(at));
    }, PDF_PATH);

    await expectCompactIconBar(
      window.locator(
        '.workspace-leaf.mod-active .workspace-leaf-content[data-type="pdf"] .ir-pdf-leaf-bar'
      )
    );
  });
});

test.describe("Removing an item note's type tag", () => {
  const SOURCE = 'sources/Security Principles';

  /**
   * What the page-side calls below reach on Obsidian and the plugin.
   * Unofficial: `window.app`, `app.plugins.plugins`,
   * `workspace.activeEditor.editor`.
   */
  type PageApp = {
    vault: { getFileByPath(path: string): unknown };
    fileManager: {
      processFrontMatter(
        file: unknown,
        fn: (frontmatter: Record<string, unknown>) => void
      ): Promise<void>;
    };
    workspace: {
      activeEditor: {
        editor?: {
          getValue(): string;
          offsetToPos(offset: number): { line: number; ch: number };
          setSelection(
            from: { line: number; ch: number },
            to: { line: number; ch: number }
          ): void;
          focus(): void;
        };
      } | null;
    };
    plugins: {
      plugins: Record<
        string,
        {
          reviewManager: {
            repo: { query(sql: string): { reference: string }[] };
          };
        }
      >;
    };
  };

  /** The live rows in `table`, as the plugin's database holds them. */
  const itemRows = (table: string) =>
    window.evaluate((table) => {
      const { app } = window as unknown as { app: PageApp };
      const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
      return repo.query(`SELECT reference FROM ${table} WHERE deleted = 0`);
    }, table);

  /** Set the note's tags to `tags`, as the user's own edit would. */
  const setTags = (path: string, tags: string[]) =>
    window.evaluate(
      async ({ path, tags }) => {
        const { app } = window as unknown as { app: PageApp };
        await app.fileManager.processFrontMatter(
          app.vault.getFileByPath(path),
          (frontmatter) => {
            frontmatter.tags = tags;
          }
        );
      },
      { path, tags }
    );

  const kinds = [
    {
      kind: 'article',
      table: 'article',
      tag: ARTICLE_TAG,
      make: () => importArticle(window, SOURCE),
    },
  ];

  type View = '.markdown-source-view' | '.markdown-reading-view';

  /** The active tab's properties, in `view`. */
  const properties = (view: View) =>
    window
      .locator(`.workspace-leaf.mod-active ${view} .metadata-property`)
      .filter({ visible: true });

  /** The pills of the tags property, in `view`. */
  const tagPills = (view: View) =>
    properties(view)
      .and(window.locator('[data-property-key="tags"]'))
      .locator('.multi-select-pill');

  /** The type tag's pill, in `view`. */
  const tagPill = (view: View, tag: string) =>
    tagPills(view).filter({ hasText: new RegExp(`^${tag}$`) });

  /** The names of the properties shown in `view`, in order. */
  const propertyKeys = (view: View) =>
    properties(view).evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-property-key'))
    );

  /**
   * Make an item, give its note tags and a property of the user's own on either
   * side of the type tag, and show it in the active tab. Returns its path and
   * the properties it then shows.
   */
  async function showTaggedItemNote(
    make: () => Promise<void>,
    table: string,
    tag: string
  ) {
    await make();
    await expect.poll(async () => (await itemRows(table)).length).toBe(1);
    const [{ reference }] = await itemRows(table);

    await window.evaluate(
      async ({ path, tag }) => {
        const { app } = window as unknown as { app: PageApp };
        await app.fileManager.processFrontMatter(
          app.vault.getFileByPath(path),
          (frontmatter) => {
            frontmatter.tags = ['mine', tag, 'also-mine'];
            frontmatter.extra = 'kept';
          }
        );
      },
      { path: reference, tag }
    );

    await openFileInActiveLeaf(window, reference);
    const view = '.markdown-source-view';
    await expect(tagPills(view)).toHaveText(['mine', tag, 'also-mine']);
    await expect(
      properties(view).and(window.locator('[data-property-key="extra"]'))
    ).toContainText('kept');
    return { reference, keys: await propertyKeys(view) };
  }

  /**
   * Waits for the `round`th notice naming the note, then dismisses it, so the
   * next round's notice is a fresh one rather than names added to this one.
   */
  async function expectDamageNotice(
    reference: string,
    notices: () => Promise<string[]>,
    round: number
  ) {
    // Named in quotes ahead of what it lost; the import's own notice names it too
    const name = `"${path.basename(reference, '.md')}" lost`;
    await expect
      .poll(
        async () =>
          (await notices()).filter((text) => text.includes(name)).length
      )
      .toBe(round);
    const notice = window.locator('.notice').filter({ hasText: name });
    await notice.click();
    await expect(notice).toHaveCount(0);
  }

  /**
   * The tag stays off: the notice comes from the pass that used to put it
   * back, so by now nothing will. The user's own tags and property are kept.
   */
  async function expectTagLeftOff(view: View, keys: (string | null)[]) {
    await expect(tagPills(view)).toHaveText(['mine', 'also-mine']);
    await expect.poll(() => propertyKeys(view)).toEqual(keys);
    await expect(
      properties(view).and(window.locator('[data-property-key="extra"]'))
    ).toContainText('kept');
  }

  for (const { kind, table, tag, make } of kinds) {
    test(`reports a ${kind} note whose type tag was removed in live preview, source mode or reading mode, leaving it off`, async () => {
      await setDefaultEditingMode(window, 'live-preview');
      const { reference, keys } = await showTaggedItemNote(make, table, tag);
      const notices = await watchNotices(window);
      const livePreview = '.markdown-source-view';

      // Live preview's properties editor
      await tagPill(livePreview, tag)
        .locator('.multi-select-pill-remove-button')
        .click();
      await expectDamageNotice(reference, notices, 1);
      await expectTagLeftOff(livePreview, keys);

      // Back where it was for the next round
      const reset = async (view: View) => {
        await setTags(reference, ['mine', tag, 'also-mine']);
        await expect(tagPills(view)).toHaveText(['mine', tag, 'also-mine']);
      };
      await reset(livePreview);

      // Source mode: the tag's YAML line selected and deleted from the
      // keyboard. Source mode shows the YAML rather than properties, so the
      // tags are looked at once back in live preview.
      await executeCommandById(window, 'editor:toggle-source');
      await window.evaluate((tag) => {
        const { app } = window as unknown as { app: PageApp };
        const editor = app.workspace.activeEditor?.editor;
        if (!editor) throw new Error('No editor in the active tab');
        const line = `  - ${tag}\n`;
        const from = editor.getValue().indexOf(line);
        if (from < 0) throw new Error(`No ${tag} line in the note`);
        editor.focus();
        editor.setSelection(
          editor.offsetToPos(from),
          editor.offsetToPos(from + line.length)
        );
      }, tag);
      await window.keyboard.press('Backspace');
      await expectDamageNotice(reference, notices, 2);
      await executeCommandById(window, 'editor:toggle-source');
      await expectTagLeftOff(livePreview, keys);
      await reset(livePreview);

      // Reading mode's properties, which write past the editor
      const reading = '.markdown-reading-view';
      await executeCommandById(window, 'markdown:toggle-preview');
      await tagPill(reading, tag)
        .locator('.multi-select-pill-remove-button')
        .click();
      await expectDamageNotice(reference, notices, 3);
      await expectTagLeftOff(reading, keys);
    });
  }
});

test.describe('Settings tab', () => {
  /** The separate window Obsidian shows settings in. */
  let settings: Page;

  /** A row of the plugin's settings tab, found by its exact name. */
  const settingRow = (name: string) =>
    settings.locator('.vertical-tab-content .setting-item').filter({
      has: settings
        .locator('.setting-item-name')
        .getByText(name, { exact: true }),
    });

  /** `data.json` as last written, or null before the plugin first saves. */
  const readPluginData = async () => {
    const dataPath = path.join(
      vaultPath,
      '.obsidian/plugins/incremental-reading/data.json'
    );
    try {
      return JSON.parse(await fs.readFile(dataPath, 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      return null;
    }
  };

  /**
   * A theme colour token as the settings window resolves it, in the
   * `rgb(...)` form computed styles report. The tokens live on `body`.
   */
  const resolveColor = (token: string) =>
    settings.evaluate((token) => {
      const probe = document.body.createDiv();
      probe.style.color = `var(${token})`;
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }, token);

  /** An element's border colour. Polled: Obsidian transitions input borders. */
  const borderColor = (locator: Locator) =>
    locator.evaluate((el) => getComputedStyle(el).borderColor);

  test.beforeEach(async () => {
    settings = await openPluginSettings(app, window);
  });

  test('outlines a malformed steps field in red until it is fixed', async () => {
    const steps = settingRow('Learning steps');
    const input = steps.locator('input');
    const error = await resolveColor('--text-error');

    await input.fill('2m, soon');

    await expect(steps).toHaveClass(/is-invalid/);
    await expect(input).toBeFocused();
    await expect.poll(() => borderColor(input)).toBe(error);
    // the focus ring around it, accent-coloured on a valid field
    await expect
      .poll(() => input.evaluate((el) => getComputedStyle(el).boxShadow))
      .toContain(error);
    await expect(steps.locator('.setting-item-error')).toHaveCSS(
      'color',
      error
    );

    await input.blur();
    await expect.poll(() => borderColor(input)).toBe(error);

    await input.fill('2m, 20m');
    await expect(steps).not.toHaveClass(/is-invalid/);
    await expect
      .poll(() => borderColor(input))
      .toBe(await resolveColor('--background-modifier-border-focus'));

    await input.blur();
    await expect
      .poll(() => borderColor(input))
      .toBe(await resolveColor('--background-modifier-border'));
  });

  test('puts a changed field back to its default with its reset button', async () => {
    const steps = settingRow('Learning steps');
    const stepsReset = steps.locator('.extra-setting-button');
    await expect(stepsReset).toHaveAttribute('aria-disabled', 'true');

    await steps.locator('input').fill('2m, soon');
    await expect(steps).toHaveClass(/is-invalid/);
    await stepsReset.click();
    await expect(steps.locator('input')).toHaveValue('1m, 10m');
    await expect(steps).not.toHaveClass(/is-invalid/);
    await expect(stepsReset).toHaveAttribute('aria-disabled', 'true');

    const interval = settingRow('Maximum review interval');
    const intervalField = interval.locator('input');
    await intervalField.fill('100');
    await intervalField.press('Enter');
    await expect.poll(readPluginData).toMatchObject({
      settings: { fsrsParams: { maximum_interval: 100 } },
    });
    await interval.locator('.extra-setting-button').click();
    await expect(intervalField).toHaveValue('36500');
    await expect.poll(readPluginData).toMatchObject({
      settings: {
        fsrsParams: { maximum_interval: 36500, learning_steps: ['1m', '10m'] },
      },
    });
  });

  test('shows or hides the open review tab’s title bar as its dropdown says', async () => {
    await executeCommandById(window, 'incremental-reading:learn');
    const header = reviewHeader(window);
    await expect(header).toBeVisible();
    // By role: Obsidian sizes the dropdown off a hidden copy of the select.
    const select = settingRow('Show review tab title bar').getByRole(
      'combobox'
    );
    await expect(select).toHaveValue('obsidian');

    await select.selectOption({ label: 'Hide' });
    await expect(header).toBeHidden();
    await expect.poll(readPluginData).toMatchObject({
      settings: { reviewTitleBar: 'hide' },
    });

    await setShowViewHeader(window, false);
    await select.selectOption({ label: 'Show' });
    await expect(header).toBeVisible();

    await select.selectOption({ label: 'Follow Obsidian setting' });
    await expect(header).toBeHidden();
    await expect.poll(readPluginData).toMatchObject({
      settings: { reviewTitleBar: 'obsidian' },
    });
  });

  test("leaves an invalid field on Obsidian's own tabs as Obsidian styles it", async () => {
    await window.evaluate(() =>
      (window as Page & { app: App }).app.setting.openTabById('file')
    );
    const row = settings
      .locator('.vertical-tab-content .setting-item')
      .filter({ has: settings.locator("input[type='text']") })
      .first();
    const input = row.locator("input[type='text']");

    // Obsidian's file tab has no validated text field to break, so the row is
    // flagged directly, as `Setting.setErrorMessage` would flag it.
    await row.evaluate((el) => {
      el.addClass('is-invalid');
      el.querySelector('.setting-item-control')?.createDiv({
        cls: 'setting-item-error',
        text: 'Invalid',
      });
    });

    await expect
      .poll(() => borderColor(input))
      .toBe(await resolveColor('--background-modifier-border'));
    await expect(row.locator('.setting-item-error')).toHaveCSS(
      'color',
      await resolveColor('--text-warning')
    );
  });

  test('shows the end-of-day shift as a clock time while it is moved', async () => {
    const shift = settingRow('End-of-day shift');
    const value = shift.locator('.slider-value');

    await expect(value).toHaveText('4 AM');

    await shift.locator("input[type='range']").focus();
    await settings.keyboard.press('ArrowRight');

    await expect(value).toHaveText('5 AM');

    // One line box per wrapped line: "5" over "AM" gives two distinct tops.
    const lineTops = await value.evaluate((el) => {
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      return new Set(
        Array.from(range.getClientRects(), (rect) => Math.round(rect.top))
      ).size;
    });
    expect(lineTops).toBe(1);
  });
});

test.describe('Settings tab on mobile', () => {
  /**
   * Whether settings tab `tabId` shows a row named `name`, once it has rendered
   * the row named `first`.
   */
  async function showsSettingRow(tabId: string, first: string, name: string) {
    let found = false;
    await expect(async () => {
      await window.evaluate((id) => {
        const { setting } = (window as Page & { app: App }).app;
        setting.open();
        setting.openTabById(id);
      }, tabId);
      // A modal over the vault on mobile, a window of its own on desktop.
      for (const page of app.windows()) {
        const names = page.locator('.vertical-tab-content .setting-item-name');
        if (!(await names.getByText(first, { exact: true }).isVisible())) {
          continue;
        }
        // Obsidian keeps a row it hides (`visible`) in the DOM, undisplayed.
        found = await names.getByText(name, { exact: true }).isVisible();
        return;
      }
      throw new Error(`No window is showing the ${tabId} settings yet`);
    }).toPass({ timeout: 20_000 });
    await window.evaluate(() =>
      (window as Page & { app: App }).app.setting.close()
    );
    return found;
  }

  /** Whether Obsidian's own "Show tab title bar", and this plugin's, show. */
  const titleBarRows = async () => ({
    // on the Interface tab, beside "Floating navigation", which every mobile
    // device has
    obsidian: await showsSettingRow(
      'interface',
      'Floating navigation',
      'Show tab title bar'
    ),
    review: await showsSettingRow(
      'incremental-reading',
      'Default article priority',
      'Show review tab title bar'
    ),
  });

  /** Start the app as a mobile device of this size, as it would boot on one. */
  async function bootMobileAt(width: number) {
    await window.setViewportSize({ width, height: 900 });
    // Obsidian builds its own Interface tab's rows once, for the device it
    // started on, so it has to start at this size for them to be comparable.
    await emulateMobile(window, true);
  }

  // Where Obsidian offers "Show tab title bar", so does the plugin: everywhere
  // but a phone, which always shows the header.
  test('offers the review title bar choice on a tablet but not on a phone, as Obsidian does its own', async () => {
    await bootMobileAt(1600);
    await expect(window.locator('body')).toHaveClass(/\bis-tablet\b/);
    expect(await titleBarRows()).toEqual({ obsidian: true, review: true });

    await emulateMobile(window, false);
    await bootMobileAt(420);
    await expect(window.locator('body')).toHaveClass(/\bis-phone\b/);
    expect(await titleBarRows()).toEqual({ obsidian: false, review: false });
  });
});
