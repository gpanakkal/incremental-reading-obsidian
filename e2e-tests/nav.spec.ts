import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import {
  emulateMobile,
  executeCommandById,
  expectReviewHome,
  expectReviewOn,
  importArticle,
  leafSnapshot,
  openFileInActiveLeaf,
  REVIEW_VIEW_DEFAULT_TITLE,
  REVIEW_VIEW_TYPE,
  setPluginSetting,
  waitForReviewItem,
  watchNotices,
  type HistoryEntrySnapshot,
  type ShownItem,
} from './helpers';
import {
  closeElectron,
  createVaultCopy,
  launchElectron,
  openVault,
  shouldCleanup,
} from './setup/helpers';

let app: ElectronApplication;
export let window: Page;
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

test.describe('Review history navigation', () => {
  /** A plain note that is not an item, for navigating the review tab away. */
  const PLAIN_NOTE = 'sources/Security Principles.md';
  const PLAIN_NOTE_TITLE = 'Security Principles';

  /**
   * Text near the top of each article this block imports, for telling from the
   * pane itself — not just the title above it — which item is rendered.
   */
  const OPENING_TEXT: Record<string, string> = {
    [ARTICLE_TITLE]: 'the most helpful learning technique',
    'Curse of dimensionality - Wikipedia': 'refers to various phenomena',
  };

  let noticesSeen: () => Promise<string[]>;
  let pageErrors: string[];

  test.beforeEach(async () => {
    pageErrors = [];
    window.on('pageerror', (error) => pageErrors.push(error.message));
    noticesSeen = await watchNotices(window);
  });

  test.afterEach(async () => {
    // A failed test has already said what went wrong.
    const testInfo = test.info();
    if (testInfo.status !== testInfo.expectedStatus) return;
    const notices = await noticesSeen().catch(() => [] as string[]);
    expect(notices.filter((text) => /busy/i.test(text))).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  /** Two due articles, so review has somewhere to advance to. */
  async function importTwoArticles() {
    await importArticle(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );
    await importArticle(window, 'sources/Curse of dimensionality - Wikipedia');
  }

  /** Open review in a tab of its own, and start reviewing from home. */
  async function beginReview() {
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    return await waitForReviewItem(window);
  }

  /** Advance past the current item, and wait for review to land on another. */
  async function skipTo(from: ShownItem) {
    await executeCommandById(window, 'incremental-reading:skip-item');
    await expect
      .poll(async () => (await leafSnapshot(window)).currentItemId)
      .not.toBe(from.id);
    const next = await waitForReviewItem(window);
    expect(next.id).not.toBe(from.id);
    return next;
  }

  const titles = (entries: HistoryEntrySnapshot[]) =>
    entries.map(({ title }) => title);

  async function expectOpeningText(item: ShownItem) {
    const opening = OPENING_TEXT[item.title];
    if (!opening) throw new Error(`No opening text known for ${item.title}`);
    await expect(
      window.locator(
        `.workspace-leaf.mod-active [data-type="${REVIEW_VIEW_TYPE}"] .cm-content`,
        { hasText: opening }
      )
    ).toBeVisible();
  }

  test('back from a note opened in the review tab returns to the item', async () => {
    await importTwoArticles();
    const x = await beginReview();
    const backBefore = titles((await leafSnapshot(window)).back);

    await openFileInActiveLeaf(window, PLAIN_NOTE);
    await expect
      .poll(async () => {
        const s = await leafSnapshot(window);
        return { viewType: s.viewType, file: s.file };
      })
      .toEqual({ viewType: 'markdown', file: PLAIN_NOTE });
    expect(titles((await leafSnapshot(window)).back)).toEqual([
      ...backBefore,
      x.title,
    ]);

    await executeCommandById(window, 'app:go-back');
    await expectReviewOn(window, x);
    await expectOpeningText(x);
    const afterBack = await leafSnapshot(window);
    expect(titles(afterBack.back)).toEqual(backBefore);
    expect(titles(afterBack.forward)).toEqual([PLAIN_NOTE_TITLE]);

    await executeCommandById(window, 'app:go-forward');
    await expect
      .poll(async () => {
        const s = await leafSnapshot(window);
        return { viewType: s.viewType, file: s.file };
      })
      .toEqual({ viewType: 'markdown', file: PLAIN_NOTE });
    const afterForward = await leafSnapshot(window);
    expect(titles(afterForward.back)).toEqual([...backBefore, x.title]);
    expect(afterForward.forward).toEqual([]);
  });

  for (const skipHomeScreen of [false, true]) {
    test(`back from a note returns to the home screen (skipHomeScreen: ${skipHomeScreen})`, async () => {
      await importTwoArticles();
      await setPluginSetting(window, 'skipHomeScreen', skipHomeScreen);

      await executeCommandById(window, 'incremental-reading:learn');
      // Opening the tab itself goes into no history: the page and item it
      // lands on are settled for it, not chosen by the user.
      let backBefore: string[] = [];
      if (skipHomeScreen) {
        // Straight into review; `learn` on the focused tab toggles home.
        const x = await waitForReviewItem(window);
        expect((await leafSnapshot(window)).back).toEqual([]);
        await executeCommandById(window, 'incremental-reading:learn');
        backBefore = [x.title];
      }
      await expectReviewHome(window);
      expect(titles((await leafSnapshot(window)).back)).toEqual(backBefore);

      await openFileInActiveLeaf(window, PLAIN_NOTE);
      await expect
        .poll(async () => (await leafSnapshot(window)).viewType)
        .toBe('markdown');

      await executeCommandById(window, 'app:go-back');
      await expectReviewHome(window);
      // Nothing the plugin did while settling the reopened tab made it into
      // the history, and it stays home rather than resuming into review.
      await window.waitForTimeout(1000);
      await expectReviewHome(window);
      const afterBack = await leafSnapshot(window);
      expect(titles(afterBack.back)).toEqual(backBefore);
      expect(titles(afterBack.forward)).toEqual([PLAIN_NOTE_TITLE]);
    });
  }

  test('back and forward move between items reviewed in the tab', async () => {
    await importTwoArticles();
    const x = await beginReview();
    await expectOpeningText(x);
    const backAtX = titles((await leafSnapshot(window)).back);

    const y = await skipTo(x);
    await expectOpeningText(y);
    expect(titles((await leafSnapshot(window)).back)).toEqual([
      ...backAtX,
      x.title,
    ]);

    await executeCommandById(window, 'app:go-back');
    await expectReviewOn(window, x);
    await expectOpeningText(x);
    const afterBack = await leafSnapshot(window);
    expect(titles(afterBack.back)).toEqual(backAtX);
    expect(titles(afterBack.forward)).toEqual([y.title]);

    await executeCommandById(window, 'app:go-forward');
    await expectReviewOn(window, y);
    await expectOpeningText(y);
    const afterForward = await leafSnapshot(window);
    expect(titles(afterForward.back)).toEqual([...backAtX, x.title]);
    expect(afterForward.forward).toEqual([]);
  });

  test('back from the first item returns to the home screen', async () => {
    await importTwoArticles();
    await executeCommandById(window, 'incremental-reading:learn');
    await expectReviewHome(window);
    const backAtHome = titles((await leafSnapshot(window)).back);

    await window.locator('css=#begin-review-button').click();
    const x = await waitForReviewItem(window);
    expect(titles((await leafSnapshot(window)).back)).toEqual([
      ...backAtHome,
      REVIEW_VIEW_DEFAULT_TITLE,
    ]);

    await executeCommandById(window, 'app:go-back');
    await expectReviewHome(window);
    const afterBack = await leafSnapshot(window);
    expect(titles(afterBack.back)).toEqual(backAtHome);
    expect(titles(afterBack.forward)).toEqual([x.title]);

    await executeCommandById(window, 'app:go-forward');
    await expectReviewOn(window, x);
  });

  /** The first line at the top edge of the review editor's viewport. */
  async function topVisibleLine() {
    return await window.evaluate((viewType) => {
      const scroller = document.querySelector<HTMLElement>(
        `.workspace-leaf.mod-active [data-type="${viewType}"] .cm-scroller`
      );
      if (!scroller) return null;
      const top = scroller.getBoundingClientRect().top;
      // Blank lines all read the same, so they cannot tell positions apart.
      const line = [...scroller.querySelectorAll('.cm-line')].find(
        (el) =>
          el.getBoundingClientRect().bottom > top + 2 &&
          (el.textContent ?? '').trim() !== ''
      );
      return {
        text: (line?.textContent ?? '').slice(0, 80),
        scrollTop: scroller.scrollTop,
        /** Where that line sits against the top edge, in px. */
        lineTop: line ? line.getBoundingClientRect().top - top : 0,
      };
    }, REVIEW_VIEW_TYPE);
  }

  /**
   * Scroll the review editor well down the item, the way a reader does, and
   * wait for the position to be saved.
   */
  async function scrollDown() {
    // The save listener goes on only after the mount-time restore has run:
    // two frames plus a 300ms wait for a properties widget.
    await window.waitForTimeout(1000);
    const scroller = window.locator(
      `.workspace-leaf.mod-active [data-type="${REVIEW_VIEW_TYPE}"] .cm-scroller`
    );
    await scroller.hover();
    for (let i = 0; i < 6; i++) {
      await window.mouse.wheel(0, 600);
      await window.waitForTimeout(100);
    }
    await expect
      .poll(async () => (await topVisibleLine())?.scrollTop ?? 0)
      .toBeGreaterThan(1000);
    // `scrollend`, then the database write it triggers.
    await window.waitForTimeout(1000);
    const position = await topVisibleLine();
    if (!position) throw new Error('No review editor on screen');
    return position;
  }

  async function expectScrolledTo(position: { text: string; lineTop: number }) {
    await expect
      .poll(async () => (await topVisibleLine())?.text, { timeout: 10000 })
      .toBe(position.text);
    // And it stays there, rather than being restored and then thrown back.
    await window.waitForTimeout(1000);
    const restored = await topVisibleLine();
    expect(restored?.text).toBe(position.text);
    // Restore puts the saved position's visual line at the top edge: within a
    // wrapped line of where the reader left it. Not compared by `scrollTop`,
    // which CodeMirror's estimated heights for unrendered text above shift by
    // hundreds of px between mounts while the text on screen is the same.
    expect(Math.abs((restored?.lineTop ?? 0) - position.lineTop)).toBeLessThan(
      40
    );
  }

  test('back to an item restores where it was scrolled to', async () => {
    await importTwoArticles();
    const x = await beginReview();
    const position = await scrollDown();

    await skipTo(x);
    await executeCommandById(window, 'app:go-back');
    await expectReviewOn(window, x);
    await expectScrolledTo(position);
  });

  test('back to an item from a note restores where it was scrolled to', async () => {
    await importTwoArticles();
    const x = await beginReview();
    const position = await scrollDown();

    await openFileInActiveLeaf(window, PLAIN_NOTE);
    await expect
      .poll(async () => (await leafSnapshot(window)).viewType)
      .toBe('markdown');
    await executeCommandById(window, 'app:go-back');
    await expectReviewOn(window, x);
    await expectScrolledTo(position);
  });

  test('action bar back and forward buttons follow the tab history', async () => {
    await importTwoArticles();
    await executeCommandById(window, 'incremental-reading:learn');
    await expectReviewHome(window);

    const backButton = window.locator('css=#navigate-back-button');
    const forwardButton = window.locator('css=#navigate-forward-button');
    // A fresh tab has nowhere to go either way.
    expect((await leafSnapshot(window)).back).toEqual([]);
    await expect(backButton).toBeDisabled();
    await expect(forwardButton).toBeDisabled();

    await window.locator('css=#begin-review-button').click();
    const x = await waitForReviewItem(window);
    await expect(backButton).toBeEnabled();
    await expect(forwardButton).toBeDisabled();

    const y = await skipTo(x);
    await expect(backButton).toBeEnabled();
    await expect(forwardButton).toBeDisabled();

    await backButton.click();
    await expectReviewOn(window, x);
    await expect(backButton).toBeEnabled();
    await expect(forwardButton).toBeEnabled();

    await forwardButton.click();
    await expectReviewOn(window, y);
    await expect(forwardButton).toBeDisabled();

    await backButton.click();
    await expectReviewOn(window, x);
    await backButton.click();
    await expectReviewHome(window);
    await expect(backButton).toBeDisabled();
    await expect(forwardButton).toBeEnabled();
  });

  /**
   * Read the bar's geometry in one pass inside the page, so no reflow lands
   * between the boxes. The bar is found through its back button: item notes
   * open in other leaves carry action bars of their own, without one.
   *
   * `startOffset` and `endOffset` are how far the outer zones' contents sit
   * from the bar's own content edges, and `centerOffset` how far the middle
   * zone's midpoint sits from the bar's — signed, so a middle zone pushed right
   * by the wider leading group reads positive.
   *
   * `before` and `after` are the space on either side of the middle zone, over
   * and above the `gap` the bar puts between any two of its children. They are
   * not equal to each other on a wide bar and are not meant to be: the leading
   * zone carries five controls against the trailing zone's one, and it is the
   * zone boxes that match, not what they hold.
   */
  async function barLayout() {
    return await window.evaluate(() => {
      const bar = document
        .querySelector('#navigate-back-button')
        ?.closest('.ir-action-bar');
      if (!bar) throw new Error('review action bar not rendered');
      const zone = (name: string) => {
        const el = bar.querySelector(`:scope > .ir-bar-${name}`);
        if (!el) throw new Error(`${name} zone not rendered`);
        return el;
      };
      const edgeOf = (el: Element | null, what: string) => {
        if (!el) throw new Error(`${what} not rendered`);
        return el.getBoundingClientRect();
      };

      const style = getComputedStyle(bar);
      const barBox = bar.getBoundingClientRect();
      const contentLeft = barBox.left + parseFloat(style.paddingLeft);
      const contentRight = barBox.right - parseFloat(style.paddingRight);
      const gap = parseFloat(style.columnGap);

      const lead = zone('lead');
      const trail = zone('trail');
      const center = zone('center').getBoundingClientRect();
      const leadFirst = edgeOf(lead.firstElementChild, 'leading zone content');
      const leadLast = edgeOf(lead.lastElementChild, 'leading zone content');
      const trailFirst = edgeOf(trail.firstElementChild, 'the ⋮');

      return {
        startOffset: leadFirst.left - contentLeft,
        endOffset: contentRight - trailFirst.right,
        centerOffset:
          (center.left + center.right) / 2 - (contentLeft + contentRight) / 2,
        before: center.left - leadLast.right - gap,
        after: trailFirst.left - center.right - gap,
      };
    });
  }

  test('action bar centers the item actions on the bar, between the edges the other two zones hold', async () => {
    await importTwoArticles();
    await beginReview();

    const wide = await barLayout();
    // The session actions hold the start edge and the ⋮ holds the end edge.
    expect(wide.startOffset).toBeCloseTo(0, 0);
    expect(wide.endOffset).toBeCloseTo(0, 0);
    // What the three zones are for: the item actions land on the bar's own
    // midpoint, rather than on the midpoint of what the leading group leaves.
    // Half the leading zone's width is what this would be off by without it.
    expect(wide.centerOffset).toBeCloseTo(0, 0);
    expect(wide.before).toBeGreaterThan(0);
    expect(wide.after).toBeGreaterThan(0);

    // Narrow enough and there is no space left to hand out: the outer zones
    // stop at their contents, the three meet, and the bar scrolls from there.
    // This is the mobile layout, reached here by width alone.
    const { width, height } = window.viewportSize() ?? {
      width: 1920,
      height: 1080,
    };
    await window.setViewportSize({ width: 420, height });
    await expect
      .poll(async () => (await barLayout()).before)
      .toBeLessThanOrEqual(1);
    const narrow = await barLayout();
    expect(narrow.after).toBeLessThanOrEqual(1);
    expect(narrow.startOffset).toBeCloseTo(0, 0);

    await window.setViewportSize({ width, height });
  });

  test('mobile navbar back and forward buttons follow the tab history', async () => {
    await emulateMobile(window, true);
    noticesSeen = await watchNotices(window);
    await importTwoArticles();
    const x = await beginReview();

    // Mobile keeps Obsidian's own header and navbar arrows.
    await expect(window.locator('css=#navigate-back-button')).toHaveCount(0);
    await expect(window.locator('css=#navigate-forward-button')).toHaveCount(0);

    const navButton = (direction: 'back' | 'forward') =>
      window.locator(`.mobile-navbar-action-${direction} button`);
    await expect(navButton('back')).toHaveAttribute('aria-disabled', 'false');
    await expect(navButton('forward')).toHaveAttribute('aria-disabled', 'true');

    // The navbar is a phone's; a tablet-sized window hides it and keeps the
    // arrows in the view header instead, which Obsidian updates by itself.
    const headerButtons = window.locator(
      `.workspace-leaf.mod-active [data-type="${REVIEW_VIEW_TYPE}"] .view-header-nav-buttons button`
    );
    await expect(headerButtons.nth(0)).toHaveAttribute(
      'aria-disabled',
      'false'
    );
    await expect(headerButtons.nth(1)).toHaveAttribute('aria-disabled', 'true');
    await window.setViewportSize({ width: 420, height: 900 });
    await expect(window.locator('body')).toHaveClass(/\bis-phone\b/);
    await expect(navButton('back')).toBeVisible();

    const y = await skipTo(x);
    await expect(navButton('back')).toHaveAttribute('aria-disabled', 'false');
    await expect(navButton('forward')).toHaveAttribute('aria-disabled', 'true');

    await navButton('back').click();
    await expectReviewOn(window, x);
    await expect(navButton('forward')).toHaveAttribute(
      'aria-disabled',
      'false'
    );

    await navButton('forward').click();
    await expectReviewOn(window, y);
    await expect(navButton('forward')).toHaveAttribute('aria-disabled', 'true');
  });

  test('begin review after going back home opens the item left last', async () => {
    await importTwoArticles();
    const x = await beginReview();

    // Home again, with X still the item review last had.
    await executeCommandById(window, 'incremental-reading:learn');
    await expectReviewHome(window);

    const otherTitle = Object.keys(OPENING_TEXT).find(
      (title) => title !== x.title
    );
    if (!otherTitle) throw new Error('No second article');
    await window.locator('.ir-queue-row', { hasText: otherTitle }).click();
    const y = await waitForReviewItem(window);
    expect(y.title).toBe(otherTitle);

    await executeCommandById(window, 'app:go-back');
    await expectReviewHome(window);

    await window.locator('css=#begin-review-button').click();
    await expectReviewOn(window, y);
    await expectOpeningText(y);
  });

  test('going back while review advances lands on the item left', async () => {
    await importTwoArticles();
    const x = await beginReview();

    // Go back the moment review lets go of X, from inside the page: a
    // round trip from the test would arrive after the next item already had.
    await window.evaluate(() => {
      const { app } = window as unknown as TestWindowLike;
      const { store } = app.plugins.plugins['incremental-reading'];
      const diag: [number, string][] = [];
      (window as unknown as { __diag: typeof diag }).__diag = diag;
      const t0 = Date.now();
      let armed = true;
      const unsubscribe = store.subscribe(() => {
        const { page, currentItemId } = store.getState();
        diag.push([Date.now() - t0, `${page}:${currentItemId}`]);
        if (armed && page === 'review' && currentItemId === null) {
          armed = false;
          void Promise.resolve().then(() => {
            diag.push([Date.now() - t0, 'go-back']);
            app.commands.executeCommandById('app:go-back');
          });
        }
      });
      setTimeout(unsubscribe, 5000);
    });
    await executeCommandById(window, 'incremental-reading:skip-item');

    await expectReviewOn(window, x);
    // And nothing resolving late moves it on.
    await window.waitForTimeout(2000);
    const diag = await window.evaluate(
      () => (window as unknown as { __diag: [number, string][] }).__diag
    );
    await test.info().attach('store timeline', {
      body: JSON.stringify(diag, null, 2),
      contentType: 'application/json',
    });
    await expectReviewOn(window, x);

    const labels = diag.map(([, label]) => label);
    // The race was actually run: back went in while review was between items.
    expect(labels).toContain('go-back');
    // And review never showed the item the advance was fetching, not even for
    // a moment before back took over.
    const expected = new Set(['go-back', 'review:null', `review:${x.id}`]);
    expect(labels.filter((label) => !expected.has(label))).toEqual([]);
  });
});
/** The slice of Obsidian's `window.app` the race test reaches into. */
type TestWindowLike = {
  app: {
    commands: { executeCommandById(id: string): boolean };
    plugins: {
      plugins: Record<
        string,
        {
          store: {
            getState(): { page: string; currentItemId: string | null };
            subscribe(listener: () => void): () => void;
          };
        }
      >;
    };
  };
};
