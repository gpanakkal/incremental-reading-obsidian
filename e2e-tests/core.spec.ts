import test, {
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  executeCommandById,
  expectReviewOn,
  finalizeArticleImport,
  importArticle,
  leafSnapshot,
  openNote,
  reviewTitle,
  selectParagraph,
  setDefaultEditingMode,
  setPluginSetting,
  toggleReviewSourceMode,
  waitForReviewItem,
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

    const articleToggle = window.locator('css=#ir-type-filter-article');

    // stop reviewing articles
    await articleToggle.click();
    await expect(articleToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(reviewTitle(window, ARTICLE_TITLE)).not.toBeVisible();

    // review articles again
    await articleToggle.click();
    await expect(articleToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(reviewTitle(window, ARTICLE_TITLE)).toBeVisible();

    // the cards-only command drives the same filter

    // show cards only
    await executeCommandById(window, 'incremental-reading:toggle-cards-only');
    await expect(reviewTitle(window, ARTICLE_TITLE)).not.toBeVisible();

    // show all items
    await executeCommandById(window, 'incremental-reading:toggle-cards-only');
    await expect(reviewTitle(window, ARTICLE_TITLE)).toBeVisible();
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
    await expect(
      summary.getByRole('heading', { name: 'Review complete' })
    ).toBeVisible();
    await expect(summary.getByText('1 item reviewed')).toBeVisible();
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
    await expect(
      summary.getByRole('heading', { name: 'Review complete' })
    ).toBeVisible();

    await window.locator('css=#undo-button').click();

    // Bounded, and bounded well inside `CURRENT_ITEM_REFETCH_TIME`: the
    // summary is the one place review holds no item at all, so asking the
    // queue for the next one changes nothing there and the item used to come
    // back only when the five-second poll next looked at the queue. Getting
    // back to it now takes naming it, which is immediate.
    await expect
      .poll(async () => (await leafSnapshot(window)).currentItemId, {
        timeout: 1_500,
        intervals: [50],
      })
      .toBe(item.id);
    await expectReviewOn(window, item);
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
    await expect(
      summary.getByRole('heading', { name: 'Review complete' })
    ).toBeVisible();
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
    await expect(
      summary.getByRole('heading', { name: 'Review complete' })
    ).toBeVisible();

    await window.locator('css=#undo-button').click();

    // Bounded, and bounded well inside `CURRENT_ITEM_REFETCH_TIME`: the
    // summary is the one place review holds no item at all, so asking the
    // queue for the next one changes nothing there and the unskipped item came
    // back only when the five-second poll next looked at the queue.
    await expect
      .poll(async () => (await leafSnapshot(window)).currentItemId, {
        timeout: 1_500,
        intervals: [50],
      })
      .toBe(item.id);
    await expectReviewOn(window, item);
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
    expect(
      window.locator('css=#begin-review-button').isDisabled()
    ).toBeTruthy();
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
    await expect
      .poll(async () => (await leafSnapshot(window)).currentItemId, {
        timeout: 1_500,
        intervals: [50],
      })
      .toBe(item.id);
    await expectReviewOn(window, item);
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
    expect(
      window.locator('css=#begin-review-button').isDisabled()
    ).toBeTruthy();
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
    expect(
      window.locator('css=#begin-review-button').isDisabled()
    ).toBeTruthy();

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

  test('file name has no leading spaces when first char is "["', async () => {
    await openNote(window, 'sources/Curse of dimensionality - Wikipedia');
    await executeCommandById(window, 'editor:toggle-source');

    // select the first opening bracket '['
    await window.locator('.cm-formatting.cm-formatting-link').first().click();
    // highlight the rest of the paragraph
    await window.getByRole('textbox').press('Shift+End');
    await window.getByRole('textbox').press('Shift+End');

    await executeCommandById(window, 'incremental-reading:extract-selection');
    await openNote(
      window,
      'incremental-reading/snippets/high-dimensional spaces'
    );

    await expect(
      window.getByRole('button', { name: 'Review' })
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

test.describe('Moved notes', () => {
  /** Article rows as the running plugin's database holds them. */
  const articleRows = (page: Page) =>
    page.evaluate(() => {
      const plugin = (
        window as unknown as {
          app: {
            plugins: {
              plugins: Record<
                string,
                | {
                    reviewManager?: {
                      repo: {
                        query(sql: string): { id: string; reference: string }[];
                        pendingSaveCount: number;
                      };
                    };
                  }
                | undefined
              >;
            };
          };
        }
      ).app.plugins.plugins['incremental-reading'];
      const repo = plugin?.reviewManager?.repo;
      return {
        rows: repo?.query('SELECT id, reference FROM article') ?? [],
        pendingSaves: repo?.pendingSaveCount ?? 0,
      };
    });

  test('follows a note that moved while Obsidian was closed', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );
    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);

    let imported = { id: '', reference: '' };
    await expect(async () => {
      const { rows, pendingSaves } = await articleRows(window);
      expect(rows).toHaveLength(1);
      // Quitting under a database write would lose the row being tested
      expect(pendingSaves).toBe(0);
      imported = rows[0];
      const note = await fs.readFile(
        path.join(vaultPath, imported.reference),
        'utf8'
      );
      expect(note).toContain(imported.id);
    }).toPass();
    await closeElectron(app);

    // A move made behind Obsidian's back, as a file manager, git, or another
    // sync tool would make it: Obsidian only ever sees a new file
    const movedPath = `moved while closed/${path.posix.basename(imported.reference)}`;
    await fs.mkdir(path.join(vaultPath, 'moved while closed'));
    await fs.rename(
      path.join(vaultPath, imported.reference),
      path.join(vaultPath, movedPath)
    );

    app = await launchElectron(vaultPath);
    window = await openVault(app, vaultPath);

    await expect
      .poll(async () => (await articleRows(window)).rows)
      .toEqual([{ id: imported.id, reference: movedPath }]);
  });
});
