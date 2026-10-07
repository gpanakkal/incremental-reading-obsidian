import { DATA_DIRECTORY, SNIPPET_DIRECTORY } from '#/lib/constants';
import test, {
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  askBeforeUpdatingLinks,
  emulateMobile,
  executeCommandById,
  expectReviewOn,
  finalizeArticleImport,
  importArticle,
  leafSnapshot,
  openFileInActiveLeaf,
  openNote,
  pendingSaves,
  renameDecliningLinkUpdate,
  reviewHeader,
  reviewTitle,
  selectParagraph,
  setDefaultEditingMode,
  setNativeMenus,
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

    // Keyboard down again: the navbar comes back, and the bar clears exactly
    // its footprint, the host's safe-area share included.
    await window.evaluate(() => {
      document.documentElement.style.removeProperty('--keyboard-height');
      document.body.style.removeProperty('--safe-area-inset-bottom');
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await expect(window.locator('.mobile-navbar')).toBeVisible();
    const navbarFootprint = await window.evaluate(() =>
      Number.parseFloat(
        document.body.style.getPropertyValue('--ir-mobile-toolbar-height')
      )
    );
    expect(navbarFootprint).toBeGreaterThan(0);
    await expect
      .poll(async () => Math.abs((await lift())! - navbarFootprint))
      .toBeLessThanOrEqual(1);
  });
});

test.describe('Review editor', () => {
  test('saves the note one write at a time while typing outpaces the disk', async () => {
    // Typing in review used to save the note once per keystroke, each save
    // starting at once whether or not the last had finished. Wherever a save
    // takes longer than the gap between keys (every phone), the writes and
    // everything that reacts to them piled up on the main thread and the keys
    // typed meanwhile showed up late. Slow the note's writes down to a phone's
    // pace and check they stay one at a time — and still end with what was
    // typed on disk.
    const NOTE = 'sources/Security Principles.md';
    const TYPED = ' typed faster than it saves';

    await importArticle(window, 'sources/Security Principles');
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    await expect(reviewTitle(window, 'Security Principles')).toBeVisible();

    await window.evaluate((path) => {
      type Process = (file: { path: string }, ...rest: unknown[]) => unknown;
      const w = window as unknown as {
        app: { vault: { process: Process } };
        __saves: { started: number; inFlight: number; maxInFlight: number };
      };
      const saves = { started: 0, inFlight: 0, maxInFlight: 0 };
      w.__saves = saves;
      const { vault } = w.app;
      const original = vault.process.bind(vault) as Process;
      vault.process = async (file, ...rest) => {
        // Frontmatter reads and writes go through `process` too; only the
        // editor's own whole-note saves are under test.
        const isFrontmatter = new Error().stack?.includes('processFrontMatter');
        if (file.path !== path || isFrontmatter) return original(file, ...rest);
        saves.started++;
        saves.inFlight++;
        saves.maxInFlight = Math.max(saves.maxInFlight, saves.inFlight);
        try {
          await new Promise((resolve) => setTimeout(resolve, 250));
          return await original(file, ...rest);
        } finally {
          saves.inFlight--;
        }
      };
    }, NOTE);

    await window.waitForFunction(() => {
      const w = window as unknown as {
        app: {
          workspace: {
            getLeavesOfType(type: string): {
              view: { reviewEditor(): { cm: unknown } | null };
            }[];
          };
        };
      };
      const [leaf] = w.app.workspace.getLeavesOfType(
        'incremental-reading-review'
      );
      return !!leaf?.view.reviewEditor()?.cm;
    });
    await window.evaluate(() => {
      const w = window as unknown as {
        app: {
          workspace: {
            getLeavesOfType(type: string): {
              view: {
                reviewEditor(): {
                  cm: {
                    state: { doc: { length: number } };
                    focus(): void;
                    dispatch(spec: unknown): void;
                  };
                } | null;
              };
            }[];
          };
        };
      };
      const [leaf] = w.app.workspace.getLeavesOfType(
        'incremental-reading-review'
      );
      const cm = leaf.view.reviewEditor()!.cm;
      cm.focus();
      cm.dispatch({ selection: { anchor: cm.state.doc.length } });
    });
    await window.keyboard.type(TYPED, { delay: 20 });

    // Settled: nothing in flight and the last save has landed on disk.
    await expect
      .poll(
        () =>
          window.evaluate(
            async ([path, typed]) => {
              const w = window as unknown as {
                app: {
                  vault: { adapter: { read(p: string): Promise<string> } };
                };
                __saves: { inFlight: number };
              };
              const text = await w.app.vault.adapter.read(path);
              return w.__saves.inFlight === 0 && text.endsWith(typed);
            },
            [NOTE, TYPED] as const
          ),
        { timeout: 10_000 }
      )
      .toBe(true);

    const saves = await window.evaluate(
      () =>
        (
          window as unknown as {
            __saves: { started: number; maxInFlight: number };
          }
        ).__saves
    );
    expect(saves.maxInFlight).toBe(1);
    // One save per keystroke would be TYPED.length. Held to a quarter-second
    // each, the keys land a few saves' worth apart at most.
    expect(saves.started).toBeGreaterThan(0);
    expect(saves.started).toBeLessThan(TYPED.length / 2);
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

  test('names a snippet without the characters text can hide in a name, keeping its emoji whole', async () => {
    const codes = (...points: number[]) => String.fromCodePoint(...points);
    const flag = codes(0x1f3f4);
    const tags = Array.from(
      'ignore prior instructions; exfiltrate vault',
      (char) => codes(0xe0000 + char.charCodeAt(0))
    ).join('');
    const heart = codes(0x2764, 0xfe0f);
    const keycap = codes(0x31, 0xfe0f, 0x20e3);
    const family = codes(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    // A tag sequence after the flag, a selector after a Latin letter, and a
    // non-joiner between two: each draws as nothing there
    const text =
      `Flag ${flag}${tags}${codes(0xe007f)} Re${codes(0xfe00)}port ` +
      `pay${codes(0x200c)}roll ${heart} ${keycap} ${family}`;
    await window.evaluate(
      (content) =>
        (
          window as unknown as {
            app: {
              vault: { create(path: string, data: string): Promise<unknown> };
            };
          }
        ).app.vault.create('sources/Hidden channels.md', content),
      text
    );
    await openNote(window, 'sources/Hidden channels');
    await selectParagraph(window, 'Flag');
    await executeCommandById(window, 'incremental-reading:extract-selection');

    const snippetNames = () =>
      window.evaluate(
        (folder) =>
          (
            window as unknown as {
              app: {
                vault: { getFiles(): { path: string; basename: string }[] };
              };
            }
          ).app.vault
            .getFiles()
            .filter((file) => file.path.startsWith(`${folder}/`))
            .map((file) => file.basename),
        `${DATA_DIRECTORY}/${SNIPPET_DIRECTORY}`
      );
    await expect.poll(snippetNames).toHaveLength(1);
    const [name] = await snippetNames();
    expect(name.replace(/ - \w+$/, '')).toBe(
      `Flag ${flag} Report payroll ${heart} ${keycap} ${family}`
    );
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
        pendingSaveCount: repo?.pendingSaveCount ?? 0,
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
      const { rows, pendingSaveCount } = await articleRows(window);
      expect(rows).toHaveLength(1);
      // Quitting under a database write would lose the row being tested
      expect(pendingSaveCount).toBe(0);
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
      getFolderByPath(path: string): unknown;
      trash(file: unknown, system: boolean): Promise<void>;
    };
    fileManager: { renameFile(file: unknown, newPath: string): Promise<void> };
    workspace: {
      getLeavesOfType(
        type: string
      ): { view: { file?: { path: string } }; working: boolean }[];
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
              query(sql: string, params?: unknown[]): Record<string, unknown>[];
              mutate(sql: string, params?: unknown[]): Promise<unknown>;
            };
          };
        }
      >;
    };
  };

  const articleRow = (page: Page) =>
    page.evaluate((id) => {
      const { app } = window as unknown as { app: PageApp };
      const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
      return repo.query(
        'SELECT reference, deleted, dismissed, due, fixed_interval_days FROM article WHERE id = $1',
        [id]
      )[0];
    }, PDF_ID);

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

  test('reviews a PDF row as a placeholder without the PDF viewer, never writing to the PDF', async () => {
    await seedPdfArticle();
    await withoutPdfViewer(window);

    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    const placeholder = window.locator('.ir-binary-item');
    await expect(placeholder).toBeVisible();
    await expect(placeholder).toContainText('Paper.pdf');

    await placeholder.getByRole('button', { name: 'Open in PDF tab' }).click();
    // Settled, not merely created: the new tab takes focus only once the PDF
    // has loaded, and would pull focus back from review if left before that.
    // `working` is the leaf's own flag for a view state still being set
    // (read from obsidian.asar, not documented).
    await expect
      .poll(() =>
        window.evaluate(() =>
          (window as unknown as { app: PageApp }).app.workspace
            .getLeavesOfType('pdf')
            .map((leaf) => [leaf.view.file?.path, leaf.working])
        )
      )
      .toEqual([[PDF_PATH, false]]);
    await window
      .locator('.workspace-tab-header[data-type="incremental-reading-review"]')
      .click();
    await expect(placeholder).toBeVisible();

    // Every action bar control: those that stay on the item, those that leave
    // it (undone to come back), then the one that finishes it
    const bar = (name: string) => window.getByRole('button', { name });
    await bar('Create snippet').click();
    await bar('Create card').click();
    const priority = window.getByRole('textbox', { name: 'Priority' });
    await priority.fill('11');
    await priority.press('Enter');
    await expect(priority).toHaveValue('1.1');

    await bar('Change scheduling strategy').click();
    const modal = window.locator('.ir-scheduling-modal');
    await modal.locator('input[type="checkbox"]').click();
    await modal.getByRole('button', { name: 'Confirm' }).click();
    await expect
      .poll(async () => (await articleRow(window))?.fixed_interval_days)
      .not.toBeNull();

    // The ⋮ stands in for the view header's; with the header shown, that one
    await setNativeMenus(window, false);
    await reviewHeader(window).getByLabel('More options').click();
    await expect(window.locator('.menu')).toBeVisible();
    await window.keyboard.press('Escape');

    await bar('Skip for current review session').click();
    await expect(placeholder).toBeHidden();
    await window.locator('#undo-button').click();
    await expect(placeholder).toBeVisible();

    await bar('Stop scheduling this item for review').click();
    await expect
      .poll(async () => (await articleRow(window))?.dismissed)
      .toBe(1);
    await window.locator('#undo-button').click();
    await expect(placeholder).toBeVisible();
    await expect
      .poll(async () => (await articleRow(window))?.dismissed)
      .toBe(0);
    const dueBefore = (await articleRow(window))?.due;
    await bar('Mark reviewed').click();
    await expect
      .poll(async () => (await articleRow(window))?.due)
      .not.toBe(dueBefore);

    expect((await pdfBytes(PDF_PATH)).equals(PDF_BYTES)).toBe(true);

    // A rename goes through the plugin's rename handler, which reads
    // frontmatter for every other kind of item; a PDF's row follows its path
    await window.evaluate(
      async ([from, to]) => {
        const { app } = window as unknown as { app: PageApp };
        await app.fileManager.renameFile(app.vault.getFileByPath(from), to);
      },
      [PDF_PATH, RENAMED_PATH]
    );
    await expect
      .poll(async () => (await articleRow(window))?.reference)
      .toBe(RENAMED_PATH);
    await expect
      .poll(async () =>
        (await pdfBytes(RENAMED_PATH).catch(() => null))?.equals(PDF_BYTES)
      )
      .toBe(true);
  });

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
    const pdfTabCount = () =>
      window.evaluate(
        () =>
          (window as unknown as { app: PageApp }).app.workspace.getLeavesOfType(
            'pdf'
          ).length
      );
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
    expect(await pdfTabCount()).toBe(1);

    // Works the row it stands for, and never the PDF
    await bar.getByRole('button', { name: 'Dismiss' }).click();
    await expect
      .poll(async () => (await articleRow(window))?.dismissed)
      .toBe(1);
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
    await expect
      .poll(async () => (await articleRow(window))?.reference)
      .toBe(RENAMED_PATH);
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
    expect(await pdfTabCount()).toBe(2);
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

  test('follows a PDF article through renames and moves, and back out of the trash', async () => {
    await seedPdfArticle();
    // A child names its parent by id, and must still reach it at every step
    await window.evaluate(async (parent) => {
      const { app } = window as unknown as { app: PageApp };
      const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
      await repo.mutate(
        'INSERT INTO snippet (id, reference, parent, due, interval, priority) VALUES ($1, $2, $3, $4, $5, $6)',
        ['pdf-child', 'snippets/child.md', parent, Date.now() + 1e9, 1, 30]
      );
    }, PDF_ID);
    await withoutPdfViewer(window);
    const childParentPath = () =>
      window.evaluate(() => {
        const { app } = window as unknown as { app: PageApp };
        const { repo } =
          app.plugins.plugins['incremental-reading'].reviewManager;
        return repo.query(
          `SELECT article.reference FROM snippet
           JOIN article ON article.id = snippet.parent
           WHERE snippet.id = 'pdf-child'`
        )[0]?.reference;
      });
    /** The row where it should be, live, and the PDF there untouched. */
    const expectRowAt = async (at: string) => {
      await expect
        .poll(async () => {
          const row = await articleRow(window);
          return [row?.reference, row?.deleted];
        })
        .toEqual([at, 0]);
      expect(await childParentPath()).toBe(at);
      expect((await pdfBytes(at)).equals(PDF_BYTES)).toBe(true);
    };

    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    const placeholder = window.locator('.ir-binary-item');
    await expect(placeholder).toContainText('Paper.pdf');

    // From the review tab's own title
    const title = reviewHeader(window).locator('.view-header-title');
    await title.click();
    await window.keyboard.press('ControlOrMeta+A');
    await window.keyboard.type('Retitled');
    await window.keyboard.press('Enter');
    await expectRowAt('papers/Retitled.pdf');
    // Refetched at its new path, which a row left behind would fail and be
    // tombstoned for
    await expect(placeholder).toContainText('Retitled.pdf');
    await expectRowAt('papers/Retitled.pdf');

    // From the file explorer, on the row review marks as the active file
    await setNativeMenus(window, false);
    await executeCommandById(window, 'file-explorer:reveal-active-file');
    await window
      .locator('.nav-file-title[data-path="papers/Retitled.pdf"]')
      .click({ button: 'right' });
    await window
      .locator('.menu')
      .getByText('Rename...', { exact: true })
      .click();
    await window.keyboard.press('ControlOrMeta+A');
    await window.keyboard.type('Explored');
    await window.keyboard.press('Enter');
    await expectRowAt('papers/Explored.pdf');
    await expect(placeholder).toContainText('Explored.pdf');
    await expectRowAt('papers/Explored.pdf');

    // Its folder, which Obsidian reports as one rename per file inside
    await window.evaluate(async () => {
      const { app } = window as unknown as { app: PageApp };
      await app.fileManager.renameFile(
        app.vault.getFolderByPath('papers'),
        'archive'
      );
    });
    await expectRowAt('archive/Explored.pdf');

    // Deleted to Obsidian's own trash, then put back at the same path
    await window.evaluate(async () => {
      const { app } = window as unknown as { app: PageApp };
      await app.vault.trash(
        app.vault.getFileByPath('archive/Explored.pdf'),
        false
      );
    });
    await expect.poll(async () => (await articleRow(window))?.deleted).toBe(1);
    await fs.writeFile(
      path.join(vaultPath, 'archive/Explored.pdf'),
      await fs.readFile(path.join(vaultPath, '.trash/Explored.pdf'))
    );
    await expect.poll(() => hasFile(window, 'archive/Explored.pdf')).toBe(true);
    await expectRowAt('archive/Explored.pdf');
  });

  test('finds a PDF article moved while Obsidian was closed by its filename, and gives it back to its own file', async () => {
    await seedPdfArticle();
    // Quitting under a database write would lose the row being tested
    await expect.poll(() => pendingSaves(window)).toBe(0);
    await expect
      .poll(async () => (await articleRow(window))?.reference)
      .toBe(PDF_PATH);
    await closeElectron(app);

    // Obsidian only ever sees a new file, which carries no id to follow
    const movedPath = `moved while closed/${path.posix.basename(PDF_PATH)}`;
    await fs.mkdir(path.join(vaultPath, 'moved while closed'));
    await fs.rename(
      path.join(vaultPath, PDF_PATH),
      path.join(vaultPath, movedPath)
    );

    app = await launchElectron(vaultPath);
    window = await openVault(app, vaultPath);

    await expect
      .poll(async () => {
        // The plugin has yet to load for the first few polls
        const row = await articleRow(window).catch(() => undefined);
        return [row?.reference, row?.deleted];
      })
      .toEqual([movedPath, 0]);
    expect((await pdfBytes(movedPath)).equals(PDF_BYTES)).toBe(true);

    // Rebinding by filename is a guess, so it is logged. Found by name: the
    // log folder lives in the plugin's data folder, which the suite runs
    // against the built bundle to find and cannot import from `src/`.
    const rebindLog = async () => {
      const entries = await fs.readdir(vaultPath, { recursive: true });
      const log = entries.find((entry) =>
        /(^|[\\/])rebinds-\d{4}-\d{2}\.log$/.test(entry)
      );
      return log ? fs.readFile(path.join(vaultPath, log), 'utf8') : '';
    };
    await expect
      .poll(rebindLog)
      .toContain(`rebound article ${PDF_ID} by filename`);

    // The PDF's own file turning up at the old path after all, as Sync
    // delivering it late would: the row goes back to it
    await fs.writeFile(path.join(vaultPath, PDF_PATH), PDF_BYTES);
    await expect
      .poll(async () => (await articleRow(window))?.reference)
      .toBe(PDF_PATH);
    await expect.poll(rebindLog).toContain(`reclaimed article ${PDF_ID}`);
  });
});

test.describe('Renames Obsidian is told not to update links for', () => {
  const SOURCE = 'sources/Security Principles.md';
  const PARAGRAPH =
    'Before we start discussing the different security principles';

  /** Every snippet row, with its note's `source` as the cache reads it. */
  const snippetLinks = (page: Page) =>
    page.evaluate(() => {
      const { app } = window as unknown as {
        app: {
          vault: { getFileByPath(path: string): unknown };
          metadataCache: {
            getFileCache(
              file: unknown
            ): { frontmatter?: Record<string, unknown> } | null;
          };
          plugins: {
            plugins: Record<
              string,
              {
                reviewManager: {
                  repo: {
                    query(
                      sql: string
                    ): { reference: string; parent: string | null }[];
                  };
                };
              }
            >;
          };
        };
      };
      const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
      return repo
        .query('SELECT reference, parent FROM snippet ORDER BY reference')
        .map(({ reference, parent }) => ({
          reference,
          parent,
          source: app.metadataCache.getFileCache(
            app.vault.getFileByPath(reference)
          )?.frontmatter?.source,
        }));
    });

  /** Go to the context of the item whose note is at `path`; where it lands. */
  const goToContext = (page: Page, path: string) =>
    page.evaluate(async (path) => {
      const { app } = window as unknown as {
        app: {
          vault: { getFileByPath(path: string): unknown };
          workspace: { getActiveFile(): { path: string } | null };
          plugins: {
            plugins: Record<
              string,
              { actions: { goToContext(file: unknown): Promise<void> } }
            >;
          };
        };
      };
      await app.plugins.plugins['incremental-reading'].actions.goToContext(
        app.vault.getFileByPath(path)
      );
      return app.workspace.getActiveFile()?.path;
    }, path);

  async function extractParagraph(page: Page, note: string) {
    await openNote(page, note);
    await selectParagraph(page, PARAGRAPH);
    await executeCommandById(page, 'incremental-reading:extract-selection');
    await expect.poll(async () => (await snippetLinks(page)).length).toBe(1);
  }

  test("keeps a plain note's snippet linked to it, highlighted and with its context", async () => {
    await extractParagraph(window, 'sources/Security Principles');
    await askBeforeUpdatingLinks(window);
    const renamed = 'sources/Safety Principles.md';

    await renameDecliningLinkUpdate(window, SOURCE, renamed);

    await expect
      .poll(async () => (await snippetLinks(window)).map((s) => s.source))
      .toEqual(['[[Safety Principles]]']);
    const [{ reference }] = await snippetLinks(window);
    expect(await goToContext(window, reference)).toBe(renamed);
    // Read again, by its link, in a note opened afresh
    await openNote(window, 'sources/Curse of dimensionality');
    await openNote(window, 'sources/Safety Principles');
    await expect(
      window.locator('.workspace-leaf.mod-active .ir-snippet-highlight').first()
    ).toBeVisible();
  });

  test("keeps an article's snippet linked to it, highlighted and with its context", async () => {
    await openNote(window, 'sources/Security Principles');
    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await extractParagraph(window, 'sources/Security Principles');
    const [{ parent }] = await snippetLinks(window);
    expect(parent).not.toBeNull();
    await askBeforeUpdatingLinks(window);
    const renamed = 'sources/Safety Principles.md';

    await renameDecliningLinkUpdate(window, SOURCE, renamed);

    await expect
      .poll(async () => (await snippetLinks(window)).map((s) => s.source))
      .toEqual(['[[Safety Principles]]']);
    const [{ reference }] = await snippetLinks(window);
    expect(await goToContext(window, reference)).toBe(renamed);
    await openNote(window, 'sources/Curse of dimensionality');
    await openNote(window, 'sources/Safety Principles');
    await expect(
      window.locator('.workspace-leaf.mod-active .ir-snippet-highlight').first()
    ).toBeVisible();
  });
});

test.describe("Deleting an item's note", () => {
  const SOURCE = 'sources/Security Principles';
  const PLAIN_NOTE = 'sources/Curse of dimensionality - Wikipedia.md';

  /**
   * What the page-side calls below reach on Obsidian and the plugin.
   * Unofficial: `window.app`, `app.plugins.plugins`.
   */
  type PageApp = {
    // Properties, not methods: the probe below swaps the reads for wrappers
    vault: {
      getFileByPath(path: string): unknown;
      cachedRead: (...args: unknown[]) => Promise<unknown>;
    };
    fileManager: {
      trashFile(file: unknown): Promise<void>;
      processFrontMatter: (...args: unknown[]) => Promise<unknown>;
    };
    plugins: {
      plugins: Record<
        string,
        {
          reviewManager: {
            repo: {
              query(sql: string): { reference: string; deleted: number }[];
            };
          };
        }
      >;
    };
  };
  type Probe = { __irFrontmatterReads?: number };

  /** The rows in `table`, as the plugin's database holds them. */
  const itemRows = (page: Page, table: string) =>
    page.evaluate((table) => {
      const { app } = window as unknown as { app: PageApp };
      const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
      return repo.query(`SELECT reference, deleted FROM ${table}`);
    }, table);

  /**
   * Count frontmatter reads still under way, so the test can wait for the
   * ones a delete sets off to settle before saying none of them failed. The
   * plugin reads a note's frontmatter through `cachedRead`, and writes it
   * through `processFrontMatter`, which reads it first.
   *
   * A note open in a tab has its text cached, so its type is read from the
   * cache rather than the disk, and the deleted note is known by the vault no
   * longer holding it: these tests no longer reach the read of a note already
   * gone from the disk, which the unit tests of `getNoteType` cover.
   */
  const countFrontmatterReads = (page: Page) =>
    page.evaluate(() => {
      const w = window as unknown as Probe & { app: PageApp };
      let inFlight = 0;
      w.__irFrontmatterReads = 0;
      const count = <K extends string>(
        owner: Record<K, (...args: unknown[]) => Promise<unknown>>,
        key: K
      ) => {
        const original = owner[key];
        owner[key] = async (...args: unknown[]) => {
          w.__irFrontmatterReads = ++inFlight;
          try {
            return await Reflect.apply(original, owner, args);
          } finally {
            w.__irFrontmatterReads = --inFlight;
          }
        };
      };
      count(w.app.vault, 'cachedRead');
      count(w.app.fileManager, 'processFrontMatter');
    });

  /**
   * Make an item with `make`, then show its note in the active tab in `mode`
   * with its action bar watching the item; returns the note's path.
   *
   * The note is browsed to from another note, so Obsidian goes back to that
   * one when the note is deleted. Going back loads a file, which keeps the
   * note's action bar up past the database write the delete makes, so the
   * bar reacts to that write every time rather than about half the time.
   */
  async function showItemNote(
    make: () => Promise<void>,
    table: string,
    mode: 'editing' | 'reading'
  ) {
    await make();
    await expect
      .poll(async () => (await itemRows(window, table)).length)
      .toBe(1);
    const [{ reference }] = await itemRows(window, table);

    await openFileInActiveLeaf(window, PLAIN_NOTE);
    await openFileInActiveLeaf(window, reference);
    if (mode === 'reading') {
      await executeCommandById(window, 'markdown:toggle-preview');
    }
    // The label is set once the bar has read its item and is watching it
    await expect(
      window
        .locator('.workspace-leaf.mod-active .ir-action-bar')
        .getByRole('button', { name: 'Dismiss', exact: true })
        .filter({ visible: true })
    ).toBeVisible();
    return reference;
  }

  /**
   * Collect page errors, and errors logged about a missing file, from now on;
   * a reader once the reads have settled. A logged one counts too: caught and
   * logged, a read of the deleted note is still the console error reported.
   */
  async function watchPageErrors() {
    const pageErrors: string[] = [];
    window.on('pageerror', (error) => pageErrors.push(error.message));
    window.on('console', (message) => {
      if (message.type() === 'error' && message.text().includes('ENOENT')) {
        pageErrors.push(message.text());
      }
    });
    await countFrontmatterReads(window);
    return async () => {
      await expect
        .poll(() =>
          window.evaluate(
            () => (window as unknown as Probe).__irFrontmatterReads
          )
        )
        .toBe(0);
      // A macrotask past the last read, by which any rejection it left
      // unhandled has been reported
      await window.evaluate(
        () => new Promise((resolve) => setTimeout(resolve, 0))
      );
      return pageErrors;
    };
  }

  const kinds = [
    {
      kind: 'article',
      table: 'article',
      make: async () => {
        await openNote(window, SOURCE);
        await executeCommandById(window, 'incremental-reading:import-article');
        await finalizeArticleImport(window);
      },
    },
    {
      kind: 'snippet',
      table: 'snippet',
      make: async () => {
        await openNote(window, SOURCE);
        await selectParagraph(
          window,
          'Before we start discussing the different security principles'
        );
        await executeCommandById(
          window,
          'incremental-reading:extract-selection'
        );
      },
    },
    {
      kind: 'card',
      table: 'srs_card',
      make: async () => {
        await openNote(window, SOURCE);
        await selectParagraph(
          window,
          'Explain the security functions: Confidentiality, Integrity and Availability (CIA).'
        );
        await executeCommandById(window, 'incremental-reading:create-card');
      },
    },
  ];

  for (const { kind, table, make } of kinds) {
    for (const mode of ['editing', 'reading'] as const) {
      test(`throws nothing when a ${kind} note open in ${mode} view is deleted`, async () => {
        const reference = await showItemNote(make, table, mode);
        const pageErrors = await watchPageErrors();

        await window.evaluate(async (path) => {
          const { app } = window as unknown as { app: PageApp };
          await app.fileManager.trashFile(app.vault.getFileByPath(path));
        }, reference);

        await expect
          .poll(async () => (await itemRows(window, table))[0]?.deleted)
          .toBe(1);
        expect(await pageErrors()).toEqual([]);
      });
    }
  }

  test("throws nothing when the plugin's undo deletes a snippet open in editing view", async () => {
    const snippet = kinds.find(({ kind }) => kind === 'snippet');
    if (!snippet) throw new Error('No snippet kind');
    await showItemNote(snippet.make, snippet.table, 'editing');
    const pageErrors = await watchPageErrors();

    // Undoing the extract deletes the note through the plugin's own delete
    await executeCommandById(window, 'incremental-reading:undo');

    await expect
      .poll(async () => (await itemRows(window, snippet.table)).length)
      .toBe(0);
    expect(await pageErrors()).toEqual([]);
  });
});

test.describe("Looking up a note's type", () => {
  const SOURCE = 'sources/Security Principles';

  /**
   * What the page-side calls below reach on Obsidian and the plugin.
   * Unofficial: `window.app`, `app.plugins.plugins`, `adapter.getFullPath`,
   * `adapter.process`.
   */
  type PageApp = {
    // Properties, not methods, where the probes below swap in a wrapper
    vault: {
      getFileByPath(path: string): unknown;
      cachedRead: (file: unknown) => Promise<string>;
      read(file: unknown): Promise<string>;
      modify(file: unknown, text: string): Promise<void>;
      create(path: string, text: string): Promise<unknown>;
      on(name: 'modify', cb: (file: { path: string }) => void): unknown;
      adapter: {
        read(path: string): Promise<string>;
        exists(path: string): Promise<boolean>;
        getFullPath(path: string): string;
        process: (
          path: string,
          fn: (text: string) => string,
          options?: unknown
        ) => Promise<string>;
      };
    };
    metadataCache: {
      getFileCache(
        file: unknown
      ): { frontmatter?: Record<string, unknown> } | null;
    };
    fileManager: {
      renameFile(file: unknown, path: string): Promise<void>;
      processFrontMatter: (...args: unknown[]) => Promise<void>;
    };
    plugins: {
      plugins: Record<
        string,
        {
          reviewManager: {
            repo: {
              query(
                sql: string
              ): { id: string; reference: string; deleted: number }[];
            };
            handleCreation: (file: { path: string }) => Promise<void>;
          };
        }
      >;
    };
  };
  type Probe = {
    app: PageApp;
    /** Paths of the notes the vault reported modified. */
    __irModified?: string[];
    /** Frontmatter reads and writes under way: see {@link watchLookups}. */
    __irLookups?: number;
    /** Paths of the files the plugin's create handler is done with. */
    __irCreated?: string[];
    /** Whether a write to the note set out, and its delete landed mid-write. */
    __irDeletedMidWrite?: boolean;
    /** Electron's renderer has Node's `require`: desktop only. */
    require(id: 'fs'): { unlinkSync: (path: string) => void };
  };

  /** The article rows, as the plugin's database holds them. */
  const articleRows = (page: Page) =>
    page.evaluate(() => {
      const { app } = window as unknown as Probe;
      const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
      return repo.query('SELECT id, reference, deleted FROM article');
    });

  /** Whether the note at `path` is on disk, asked of the disk itself. */
  const isOnDisk = (path: string) =>
    window.evaluate(
      (path) => (window as unknown as Probe).app.vault.adapter.exists(path),
      path
    );

  /** The note's bytes on disk, read past the vault's cache. */
  const onDisk = (path: string) =>
    window.evaluate(
      (path) => (window as unknown as Probe).app.vault.adapter.read(path),
      path
    );

  /**
   * Import {@link SOURCE} as an article, then rewrite its note's frontmatter
   * the way a person might by hand, in a form Obsidian never writes itself: a
   * comment, a flow list, double-quoted strings. Returns the note's path.
   */
  async function importHandWrittenArticle() {
    await importArticle(window, SOURCE);
    await expect.poll(async () => (await articleRows(window)).length).toBe(1);
    const [{ id, reference }] = await articleRows(window);

    await window.evaluate(
      async ({ path, id }) => {
        const { app } = window as unknown as Probe;
        const file = app.vault.getFileByPath(path);
        const text = await app.vault.read(file);
        const fence = '\n---\n';
        const close = text.indexOf(fence, 3);
        if (!text.startsWith('---\n') || close < 0) {
          throw new Error(`No frontmatter in ${path}`);
        }
        const kept = Object.entries(
          app.metadataCache.getFileCache(file)?.frontmatter ?? {}
        )
          .filter(([key]) => key !== 'tags' && key !== 'ir-id')
          .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
        const frontmatter = [
          '# written by hand',
          'tags: [ir-article]   # a flow list',
          `ir-id: "${id}"`,
          ...kept,
        ].join('\n');
        await app.vault.modify(
          file,
          `---\n${frontmatter}${fence}${text.slice(close + fence.length)}`
        );
      },
      { path: reference, id }
    );
    // Lookups below go by the note as rewritten
    await expect
      .poll(() =>
        window.evaluate((path) => {
          const { app } = window as unknown as Probe;
          const file = app.vault.getFileByPath(path);
          return app.metadataCache.getFileCache(file)?.frontmatter?.tags;
        }, reference)
      )
      .toEqual(['ir-article']);
    return reference;
  }

  /**
   * The precondition both tests rest on: the note on disk is still as written
   * by hand, so nothing has rewritten it before the test starts watching.
   */
  const expectHandWritten = (text: string) => {
    expect(text).toContain('# written by hand');
    expect(text).toContain('tags: [ir-article]   # a flow list');
  };

  /**
   * From now on, count the frontmatter reads and writes under way, which the
   * plugin makes through `cachedRead` and `processFrontMatter`, and record each
   * file the plugin's create handler is done with: the positive signals the
   * tests wait on before saying nothing was written.
   */
  const watchLookups = () =>
    window.evaluate(() => {
      const w = window as unknown as Probe;
      let inFlight = 0;
      w.__irLookups = 0;
      w.__irCreated = [];
      const count = <K extends string>(
        owner: Record<K, (...args: never[]) => Promise<unknown>>,
        key: K
      ) => {
        const original = owner[key];
        owner[key] = (async (...args: never[]) => {
          w.__irLookups = ++inFlight;
          try {
            return await Reflect.apply(original, owner, args);
          } finally {
            w.__irLookups = --inFlight;
          }
        }) as (typeof owner)[K];
      };
      count(w.app.vault, 'cachedRead');
      count(w.app.fileManager, 'processFrontMatter');
      const manager =
        w.app.plugins.plugins['incremental-reading'].reviewManager;
      const handleCreation = manager.handleCreation;
      manager.handleCreation = async (file) => {
        try {
          await Reflect.apply(handleCreation, manager, [file]);
        } finally {
          w.__irCreated?.push(file.path);
        }
      };
    });

  /** Settles once no frontmatter read or write is under way, a macrotask on. */
  const lookupsSettled = async () => {
    await window.evaluate(() => new Promise((done) => setTimeout(done, 0)));
    await expect
      .poll(() =>
        window.evaluate(() => (window as unknown as Probe).__irLookups)
      )
      .toBe(0);
  };

  /** Show `path` in the active tab, in `mode`, with its action bar up. */
  async function showWithActionBar(path: string, mode: 'editing' | 'reading') {
    await openFileInActiveLeaf(window, path);
    if (mode === 'reading') {
      await executeCommandById(window, 'markdown:toggle-preview');
    }
    // The bar shows once it has looked the note's type up
    await expect(
      window
        .locator('.workspace-leaf.mod-active .ir-action-bar')
        .getByRole('button', { name: 'Dismiss', exact: true })
        .filter({ visible: true })
    ).toBeVisible();
  }

  test('leaves hand-written frontmatter byte for byte as it was, through opening, review, rename and a copy', async () => {
    const reference = await importHandWrittenArticle();
    const written = await onDisk(reference);
    expectHandWritten(written);
    await window.evaluate(() => {
      const w = window as unknown as Probe;
      w.__irModified = [];
      // Notes only: the plugin's database is a file in the vault too
      w.app.vault.on('modify', (file) => {
        if (file.path.endsWith('.md')) w.__irModified?.push(file.path);
      });
    });
    await watchLookups();

    await showWithActionBar(reference, 'editing');
    await showWithActionBar(reference, 'reading');

    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    await window.getByRole('button', { name: 'Mark reviewed' }).click();
    await expect(
      window
        .locator('.ir-review-summary')
        .getByRole('heading', { name: 'Review complete' })
    ).toBeVisible();

    const renamed = reference.replace(/\.md$/, ' renamed.md');
    await window.evaluate(
      async ({ from, to }) => {
        const { app } = window as unknown as Probe;
        await app.fileManager.renameFile(app.vault.getFileByPath(from), to);
      },
      { from: reference, to: renamed }
    );
    await expect
      .poll(async () => (await articleRows(window))[0]?.reference)
      .toBe(renamed);
    // Open again where it went, so the lookups run on the renamed note too
    await showWithActionBar(renamed, 'editing');
    // A copy, ir-id and all, made as a file manager or a sync would: the
    // plugin's create handler looks its ir-id and tags up
    const copy = renamed.replace(/\.md$/, ' copy.md');
    await window.evaluate(
      async ({ path, text }) => {
        await (window as unknown as Probe).app.vault.create(path, text);
      },
      { path: copy, text: written }
    );
    await expect
      .poll(() =>
        window.evaluate(() => (window as unknown as Probe).__irCreated)
      )
      .toContain(copy);
    // Not the item, so no bar comes up for it: open it, and let its lookups
    // settle
    await openFileInActiveLeaf(window, copy);
    await lookupsSettled();

    expect(await onDisk(renamed)).toBe(written);
    expect(await onDisk(copy)).toBe(written);
    expect(
      await window.evaluate(() => (window as unknown as Probe).__irModified)
    ).toEqual([]);
  });

  test('leaves deleted a note whose delete lands while its type is looked up', async () => {
    const reference = await importHandWrittenArticle();
    await watchLookups();

    // Delete the note off the disk the moment anything sets out to write it,
    // between that write's read and the write itself: the delete a lookup made
    // through a write could undo
    await window.evaluate((path) => {
      const w = window as unknown as Probe;
      const { adapter } = w.app.vault;
      const { unlinkSync } = w.require('fs');
      const original = adapter.process;
      adapter.process = (target, fn, options) => {
        const deleteMidWrite = (text: string) => {
          const out = fn(text);
          if (target === path && !w.__irDeletedMidWrite) {
            w.__irDeletedMidWrite = true;
            unlinkSync(adapter.getFullPath(path));
          }
          return out;
        };
        return Reflect.apply(original, adapter, [
          target,
          deleteMidWrite,
          options,
        ]);
      };
    }, reference);

    expectHandWritten(await onDisk(reference));

    const deletedMidWrite = () =>
      window.evaluate(() => !!(window as unknown as Probe).__irDeletedMidWrite);
    await openFileInActiveLeaf(window, reference);
    // Its type looked up: the action bar is up for it, or the lookup set out to
    // write the note and the delete landed under it
    const dismiss = window
      .locator('.workspace-leaf.mod-active .ir-action-bar')
      .getByRole('button', { name: 'Dismiss', exact: true })
      .filter({ visible: true });
    await expect
      .poll(
        async () => (await deletedMidWrite()) || (await dismiss.isVisible())
      )
      .toBe(true);
    // Nothing set out to write it: delete it all the same, as a sync or
    // another app would, now its type has been looked up
    await window.evaluate((path) => {
      const w = window as unknown as Probe;
      if (w.__irDeletedMidWrite) return;
      w.__irDeletedMidWrite = true;
      w.require('fs').unlinkSync(w.app.vault.adapter.getFullPath(path));
    }, reference);

    // Past any write a lookup made, which ends within its `processFrontMatter`
    await lookupsSettled();
    expect(await isOnDisk(reference)).toBe(false);
    await expect
      .poll(async () => (await articleRows(window))[0]?.deleted)
      .toBe(1);
  });
});
