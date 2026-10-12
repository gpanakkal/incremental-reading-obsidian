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
  REVIEW_VIEW_TYPE,
  reviewNewCard,
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

/** The active review tab's action bar. */
const BAR = `.workspace-leaf.mod-active [data-type="${REVIEW_VIEW_TYPE}"] .ir-action-bar`;

/** Viewports pinned for every check: CI's headed window is ~1024px wide. */
const WIDE = { width: 1600, height: 900 };
const NARROW = { width: 640, height: 900 };
const PHONE = { width: 420, height: 900 };

type Box = { left: number; right: number; width: number };

/**
 * The bar as laid out now: whether the leading zone reads as packed, how the
 * separator closing it is drawn, and where it sits between undo and the
 * middle zone's first button.
 */
function barLayout(page: Page) {
  return page.evaluate((selector) => {
    const bar = document.querySelector(selector);
    const lead = bar?.querySelector(':scope > .ir-bar-lead');
    const joint = lead?.querySelector(':scope > .ir-bar-joint');
    const undo = lead?.querySelector('#undo-button');
    const first = bar?.querySelector(':scope > .ir-bar-center > :first-child');
    if (!lead || !joint || !undo || !first) return null;
    const box = (el: Element): Box => {
      const { left, right, width } = el.getBoundingClientRect();
      return { left, right, width };
    };
    return {
      packed: lead.classList.contains('is-packed'),
      visibility: getComputedStyle(joint).visibility,
      undo: box(undo),
      joint: box(joint),
      first: box(first),
      firstLabel: first.getAttribute('aria-label'),
    };
  }, BAR);
}

/**
 * Wait for the bar to settle in the given state, then return its layout.
 * `timeout` bounds how late it may get there.
 */
async function expectBar(
  page: Page,
  expected: { packed: boolean; shown: boolean; firstLabel: string },
  { timeout }: { timeout?: number } = {}
) {
  await expect
    .poll(
      async () => {
        const layout = await barLayout(page);
        return (
          layout && {
            packed: layout.packed,
            shown: layout.visibility === 'visible',
            firstLabel: layout.firstLabel,
          }
        );
      },
      { timeout }
    )
    .toEqual(expected);
  return (await barLayout(page))!;
}

/** The separator sits in the bar's gap on each side, undo before it. */
function expectBetween(
  layout: NonNullable<Awaited<ReturnType<typeof barLayout>>>
) {
  const { undo, joint, first } = layout;
  expect(joint.width).toBeGreaterThan(0);
  expect(joint.left - undo.right).toBeCloseTo(8, 0);
  expect(first.left - joint.right).toBeCloseTo(8, 0);
}

async function reviewArticle(page: Page) {
  await importArticle(
    page,
    'sources/Memorizing a programming language using spaced repetition'
  );
  await executeCommandById(page, 'incremental-reading:learn');
  await page.locator('css=#begin-review-button').click();
  await waitForReviewItem(page);
}

test.describe('Separator between undo and the item actions', () => {
  test('shows only once a narrow bar packs undo against mark reviewed', async () => {
    await window.setViewportSize(WIDE);
    await reviewArticle(window);

    const wide = await expectBar(window, {
      packed: false,
      shown: false,
      firstLabel: 'Mark reviewed',
    });
    // Hidden, but still holding its place
    expect(wide.joint.width).toBeGreaterThan(0);
    expect(wide.first.left - wide.undo.right).toBeGreaterThan(40);

    await window.setViewportSize(NARROW);
    expectBetween(
      await expectBar(window, {
        packed: true,
        shown: true,
        firstLabel: 'Mark reviewed',
      })
    );

    await window.setViewportSize(WIDE);
    await expectBar(window, {
      packed: false,
      shown: false,
      firstLabel: 'Mark reviewed',
    });
  });

  test('parts undo from show answer on a card the same way', async () => {
    await window.setViewportSize(WIDE);
    await reviewNewCard(window);
    await expectBar(window, {
      packed: false,
      shown: false,
      firstLabel: 'Show answer',
    });

    await window.setViewportSize(NARROW);
    expectBetween(
      await expectBar(window, {
        packed: true,
        shown: true,
        firstLabel: 'Show answer',
      })
    );
  });

  test('follows the tab into a window of its own', async () => {
    await window.setViewportSize(WIDE);
    await reviewArticle(window);
    await expectBar(window, {
      packed: false,
      shown: false,
      firstLabel: 'Mark reviewed',
    });

    // Packed and back first: a re-render on each must leave the zone able to
    // hear of the move
    await window.setViewportSize(NARROW);
    await expectBar(window, {
      packed: true,
      shown: true,
      firstLabel: 'Mark reviewed',
    });
    await window.setViewportSize(WIDE);
    await expectBar(window, {
      packed: false,
      shown: false,
      firstLabel: 'Mark reviewed',
    });

    // The tab keeps its DOM, so the same bar measures on from the popout.
    // Unofficial: Obsidian's "Move current tab to new window" command id.
    const opened = app.waitForEvent('window');
    await executeCommandById(window, 'workspace:move-to-new-window');
    const popout = await opened;
    await popout.waitForLoadState('domcontentloaded');
    await popout.setViewportSize(WIDE);
    await expectBar(popout, {
      packed: false,
      shown: false,
      firstLabel: 'Mark reviewed',
    });

    // With the main window minimized and throttled, an observer made there
    // reports nothing: the popout's own has to be the one watching. Unofficial:
    // the main window loads Obsidian's index.html, a popout about:blank.
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.webContents.getURL().endsWith('/index.html')) {
          win.webContents.setBackgroundThrottling(true);
          win.minimize();
        }
      }
    });
    // Bounded: within a few frames, not whenever something else in the page
    // next happens to catch the bar up
    const promptly = { timeout: 3_000 };
    await popout.setViewportSize(NARROW);
    expectBetween(
      await expectBar(
        popout,
        { packed: true, shown: true, firstLabel: 'Mark reviewed' },
        promptly
      )
    );

    await popout.setViewportSize(WIDE);
    await expectBar(
      popout,
      { packed: false, shown: false, firstLabel: 'Mark reviewed' },
      promptly
    );
  });

  test('always shows on mobile, packed or not', async () => {
    // A tablet wide enough to leave the bar room to spare
    await emulateMobile(window, true);
    await window.setViewportSize(WIDE);
    await expect(window.locator('body')).toHaveClass(/\bis-tablet\b/);
    await reviewArticle(window);
    await expectBar(window, {
      packed: false,
      shown: true,
      firstLabel: 'Mark reviewed',
    });

    await window.setViewportSize(PHONE);
    await expect(window.locator('body')).toHaveClass(/\bis-phone\b/);
    expectBetween(
      await expectBar(window, {
        packed: true,
        shown: true,
        firstLabel: 'Mark reviewed',
      })
    );
  });

  test('toggling it moves nothing, so it never flickers across the threshold', async () => {
    await window.setViewportSize(WIDE);
    await reviewArticle(window);
    await expectBar(window, {
      packed: false,
      shown: false,
      firstLabel: 'Mark reviewed',
    });

    // Every class change on the leading zone, counted in the page: a
    // round-trip per sample would be far too slow to see a flicker.
    await window.evaluate((selector) => {
      const lead = document.querySelector(`${selector} > .ir-bar-lead`)!;
      const w = window as unknown as { __packedFlips: number };
      w.__packedFlips = 0;
      new MutationObserver(() => w.__packedFlips++).observe(lead, {
        attributes: true,
        attributeFilter: ['class'],
      });
    }, BAR);
    const flips = () =>
      window.evaluate(
        () => (window as unknown as { __packedFlips: number }).__packedFlips
      );

    // Narrowing step by step crosses the threshold exactly once, and every
    // width settles where it lands: no class change after the first frames.
    const states: boolean[] = [];
    for (let width = 1200; width >= 600; width -= 8) {
      await window.setViewportSize({ width, height: WIDE.height });
      await window.evaluate(
        () =>
          new Promise<void>((r) =>
            requestAnimationFrame(() => requestAnimationFrame(() => r()))
          )
      );
      const before = await flips();
      await window.waitForTimeout(50);
      expect(await flips()).toBe(before);
      states.push((await barLayout(window))!.packed);
    }
    const crossing = states.indexOf(true);
    expect(crossing).toBeGreaterThan(0);
    expect(states.slice(crossing).every(Boolean)).toBe(true);
    expect(await flips()).toBe(1);

    // And right at the threshold, the separator shown or not, every box in
    // the bar is where it was.
    const threshold = 1200 - crossing * 8;
    await window.setViewportSize({ width: threshold, height: WIDE.height });
    await expectBar(window, {
      packed: true,
      shown: true,
      firstLabel: 'Mark reviewed',
    });
    // Both states measured in one evaluate, so no render can land between
    const { shown, hidden } = await window.evaluate((selector) => {
      const bar = document.querySelector(selector)!;
      const lead = bar.querySelector(':scope > .ir-bar-lead')!;
      const joint = lead.querySelector(':scope > .ir-bar-joint')!;
      const measure = (packed: boolean) => {
        lead.classList.toggle('is-packed', packed);
        return {
          visibility: getComputedStyle(joint).visibility,
          boxes: Array.from(bar.querySelectorAll('*'), (el) => {
            const { left, top, width, height } = el.getBoundingClientRect();
            return [left, top, width, height];
          }),
        };
      };
      const result = { shown: measure(true), hidden: measure(false) };
      lead.classList.add('is-packed');
      return result;
    }, BAR);
    expect([shown.visibility, hidden.visibility]).toEqual([
      'visible',
      'hidden',
    ]);
    expect(hidden.boxes).toEqual(shown.boxes);
  });
});
