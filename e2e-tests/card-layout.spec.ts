import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import {
  emulateMobile,
  REVIEW_VIEW_TYPE,
  reviewNewCard,
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
    await fs
      .rm(vaultPath, { recursive: true, force: true, maxRetries: 3 })
      .catch(() => {});
  }
});

const VIEW = `.workspace-leaf.mod-active [data-type="${REVIEW_VIEW_TYPE}"]`;

/** Viewports pinned for every check: CI's headed window is ~1024px wide. */
const NARROW = { width: 640, height: 900 };
const PHONE = { width: 420, height: 900 };

type Side = 'question' | 'answer';

/**
 * The scrolling box each side of the card is drawn in, and the box of its
 * text: the question's preview before Show answer, the editor after.
 */
const SIDES = {
  question: { box: '.ir-card-preview', text: '.ir-card-viewer' },
  answer: { box: '.ir-card-editor .cm-scroller', text: '.cm-content' },
} as const satisfies Record<Side, { box: string; text: string }>;

/**
 * Where the card's text is drawn, against the space it has: the bar, the
 * scrolling box's content area (inside its padding), and the text itself.
 */
function cardLayout(page: Page, side: Side) {
  return page.evaluate(
    ([view, { box: boxSelector, text: textSelector }]) => {
      const root = document.querySelector(view);
      const bar = root?.querySelector('.ir-review-interface > .ir-action-bar');
      const scroller = root?.querySelector<HTMLElement>(boxSelector);
      const content = scroller?.querySelector(textSelector);
      if (!bar || !scroller || !content?.textContent?.trim()) return null;
      const range = document.createRange();
      range.selectNodeContents(content);
      const text = range.getBoundingClientRect();
      const box = scroller.getBoundingClientRect();
      const style = getComputedStyle(scroller);
      return {
        bar: bar.getBoundingClientRect().toJSON() as DOMRect,
        area: {
          middle: (box.left + box.right) / 2,
          top: box.top + parseFloat(style.paddingTop),
          bottom: box.bottom - parseFloat(style.paddingBottom),
        },
        text: { top: text.top, bottom: text.bottom, height: text.height },
        scrolls: scroller.scrollHeight > scroller.clientHeight,
      };
    },
    [VIEW, SIDES[side]] as const
  );
}

/** The text's middle is within 15% of the area's height of the area's. */
async function expectCentered(page: Page, side: Side) {
  await expect
    .poll(async () => {
      const layout = await cardLayout(page, side);
      if (!layout) return null;
      const { area, text } = layout;
      const height = area.bottom - area.top;
      const offset =
        (text.top + text.bottom) / 2 - (area.top + area.bottom) / 2;
      // Short enough to center at all, or the check proves nothing
      if (text.height > height / 2) return 'card too tall to center';
      return Math.abs(offset) <= height * 0.15;
    })
    .toBe(true);
}

/**
 * Not centered: the text starts at the top of its space, as an article's
 * does, rather than anywhere near the middle, and clear of the bar above.
 */
async function expectAtTop(page: Page, side: Side) {
  await expect
    .poll(async () => {
      const layout = await cardLayout(page, side);
      if (!layout) return null;
      const { area, text } = layout;
      const height = area.bottom - area.top;
      if (text.height > height / 2) return 'card too tall to tell';
      // Coarse: within the top tenth, where centered would be near the middle
      return text.top >= area.top - 1 && text.top - area.top < height * 0.1;
    })
    .toBe(true);
  const { bar, text } = (await cardLayout(page, side))!;
  expect(text.top).toBeGreaterThan(bar.bottom);
}

/** A card too tall for the screen starts at the top and scrolls. */
async function expectStartsAtTopAndScrolls(page: Page, side: Side) {
  await expect
    .poll(async () => {
      const layout = await cardLayout(page, side);
      return (
        layout && layout.text.height > layout.area.bottom - layout.area.top
      );
    })
    .toBe(true);
  const layout = (await cardLayout(page, side))!;
  expect(layout.scrolls).toBe(true);
  // Its first line is where the space starts: not pushed above, out of reach
  expect(Math.abs(layout.text.top - layout.area.top)).toBeLessThan(24);
}

const showAnswer = (page: Page) =>
  page.getByRole('button', { name: 'Show answer' }).click();

async function onPhone(page: Page) {
  await emulateMobile(page, true);
  await page.setViewportSize(PHONE);
  await expect(page.locator('body')).toHaveClass(/\bis-phone\b/);
}

test.describe('Card text', () => {
  test('sits in the middle of a phone screen, clear of notices and the bar', async () => {
    await onPhone(window);
    await reviewNewCard(window);

    for (const side of ['question', 'answer'] as const) {
      if (side === 'answer') await showAnswer(window);
      await expectCentered(window, side);
      // The bar is at the bottom here, below the text
      const layout = (await cardLayout(window, side))!;
      expect(layout.bar.top).toBeGreaterThanOrEqual(layout.text.bottom);
    }

    // The blank space below the centered answer still takes a press there,
    // putting the caret at the end of the text
    const { area, text } = (await cardLayout(window, 'answer'))!;
    await window.mouse.click(area.middle, (text.bottom + area.bottom) / 2);
    await window.keyboard.type('Zebra');
    await expect(
      window.locator(`${VIEW} .ir-card-editor .cm-content`)
    ).toContainText(/Zebra$/);
  });

  test('starts at the top of a narrow desktop window, where the bar stays on top', async () => {
    // Narrow is not mobile: the bar stays on top, so nothing is centered
    await window.setViewportSize(NARROW);
    await reviewNewCard(window);

    await expectAtTop(window, 'question');
    await showAnswer(window);
    await expectAtTop(window, 'answer');
  });

  test('too tall for a phone screen, starts at the top and scrolls', async () => {
    await onPhone(window);
    await reviewNewCard(window);
    // Grown from outside review, which picks the change up
    await window.evaluate(async () => {
      // `window.app` and its vault are unofficial: Obsidian's global, untyped
      const { app } = window as unknown as RepoWindow & {
        app: {
          vault: {
            getFileByPath(path: string): unknown;
            process(file: unknown, fn: (text: string) => string): Promise<void>;
          };
        };
      };
      const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
      const [card] = (await repo.query('SELECT reference FROM srs_card')) ?? [];
      const file = app.vault.getFileByPath(card.reference as string);
      const filler = Array.from(
        { length: 60 },
        (_, i) => `Filler paragraph ${i + 1}.`
      ).join('\n\n');
      await app.vault.process(file, (text) => `${text}\n\n${filler}\n`);
    });

    await expectStartsAtTopAndScrolls(window, 'question');
    await showAnswer(window);
    await expectStartsAtTopAndScrolls(window, 'answer');
  });
});
