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
    // Best-effort, as in core.spec.ts: a surviving Electron child on Windows
    // can still hold a handle inside the disposable vault.
    await fs
      .rm(vaultPath, { recursive: true, force: true, maxRetries: 3 })
      .catch(() => {});
  }
});

/** The active review tab, its bar, and the grades' own row. */
const VIEW = `.workspace-leaf.mod-active [data-type="${REVIEW_VIEW_TYPE}"]`;

/** Viewports pinned for every check: CI's headed window is ~1024px wide. */
const WIDE = { width: 1600, height: 900 };
const NARROW = { width: 640, height: 900 };
const PHONE = { width: 420, height: 900 };

const WORDS = ['Forgot', 'Hard', 'Good', 'Easy'] as const;
/** Each word's ts-fsrs rating, as srs_card_review stores it. */
const RATINGS = { Forgot: 1, Hard: 2, Good: 3, Easy: 4 } as const;
/** Each word's tint, a theme color Obsidian declares on <body>. */
const TINTS = {
  Forgot: '--color-red',
  Hard: '--color-orange',
  Good: '--color-green',
  Easy: '--color-blue',
} as const;

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  mo: (365 * 86_400_000) / 12,
  y: 365 * 86_400_000,
};

/** What a compact interval label reads as, in ms (`<1m` as none). */
function labelMs(label: string): number {
  if (label === '<1m') return 0;
  const match = /^(\d+(?:\.\d)?)(m|h|d|mo|y)$/.exec(label);
  if (!match) throw new Error(`not a compact interval: "${label}"`);
  return Number(match[1]) * UNIT_MS[match[2]];
}

type Box = { left: number; right: number; top: number; bottom: number };

/**
 * Where the grades are, and every box a placement check reads: the bar, the
 * row (if any), each segment, the middle zone's first child, and what each
 * segment says.
 */
function gradeLayout(page: Page) {
  return page.evaluate((view) => {
    const root = document.querySelector(view);
    const bar = root?.querySelector('.ir-action-bar');
    if (!root || !bar) return null;
    const row = root.querySelector('.ir-grade-row');
    const group = root.querySelector('.ir-grade-group:not([aria-hidden])');
    const box = (el: Element): Box => {
      const { left, right, top, bottom } = el.getBoundingClientRect();
      return { left, right, top, bottom };
    };
    return {
      placement: row
        ? 'row'
        : group?.parentElement?.classList.contains('ir-bar-center')
          ? 'inline'
          : 'none',
      groupFirstInCenter:
        bar.querySelector(':scope > .ir-bar-center > :first-child') === group,
      bar: box(bar),
      row: row && box(row),
      // What the segments are clipped to: the bar scrolls its overflow away
      clip: box(row ?? bar),
      viewport: { width: innerWidth, height: innerHeight },
      segments: Array.from(group?.children ?? [], (el) => ({
        box: box(el),
        word: el.querySelector('.ir-grade-word')?.textContent ?? '',
        interval: el.querySelector('.ir-grade-interval')?.textContent ?? '',
        label: el.getAttribute('aria-label'),
      })),
    };
  }, VIEW);
}

type GradeLayout = NonNullable<Awaited<ReturnType<typeof gradeLayout>>>;

/** Wait for the grades to settle in `placement`, then return the layout. */
async function expectPlacement(
  page: Page,
  placement: 'inline' | 'row'
): Promise<GradeLayout> {
  await expect
    .poll(async () => (await gradeLayout(page))?.placement)
    .toBe(placement);
  return (await gradeLayout(page))!;
}

/**
 * All four segments, in order, each word over its interval, fully on screen
 * and inside what clips them, so none is scrolled out of reach.
 */
function expectAllReachable(layout: GradeLayout) {
  expect(layout.segments.map((s) => s.word)).toEqual([...WORDS]);
  for (const { box, interval, label, word } of layout.segments) {
    expect(box.left).toBeGreaterThanOrEqual(
      Math.max(0, layout.clip.left) - 0.5
    );
    expect(box.right).toBeLessThanOrEqual(
      Math.min(layout.viewport.width, layout.clip.right) + 0.5
    );
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(layout.viewport.height);
    expect(() => labelMs(interval)).not.toThrow();
    expect(label).toBe(`${word}, next review in ${interval}`);
  }
}

/** Four segments of one width, inline or in the row. */
function expectEqualSegments(layout: GradeLayout) {
  const widths = layout.segments.map((s) => s.box.right - s.box.left);
  for (const width of widths) expect(width).toBeCloseTo(widths[0], 0);
}

/** Four equal segments across the row, the row across the view. */
function expectFullWidthRow(layout: GradeLayout) {
  expectEqualSegments(layout);
  expect(layout.row!.left).toBeCloseTo(layout.bar.left, 0);
  expect(layout.row!.right).toBeCloseTo(layout.bar.right, 0);
}

function query(page: Page, sql: string) {
  return page.evaluate(
    async (sql) =>
      (await (window as unknown as RepoWindow).app.plugins.plugins[
        'incremental-reading'
      ].reviewManager.repo.query(sql)) ?? [],
    sql
  );
}

/**
 * Grade the card on screen as `word`, and check grading took: the review is
 * logged with that rating, the card is due about when the button said, and
 * review moves on.
 */
async function gradeAs(page: Page, word: (typeof WORDS)[number]) {
  const button = page.getByRole('button', { name: `${word}, next review in` });
  const interval = await button.locator('.ir-grade-interval').textContent();
  const clickedAt = Date.now();
  await button.click();

  await expect
    .poll(async () =>
      (await query(page, 'SELECT rating FROM srs_card_review')).map(
        (r) => r.rating
      )
    )
    .toEqual([RATINGS[word]]);
  const [{ due }] = await query(page, 'SELECT due FROM srs_card');
  const shown = labelMs(interval!);
  const unit = UNIT_MS[/[a-z]+$/.exec(interval!)?.[0] ?? 'm'];
  // Within half the label's unit, plus the time the click took to land
  expect(Math.abs((due as number) - clickedAt - shown)).toBeLessThanOrEqual(
    unit / 2 + 5_000
  );
  await expect(
    page.getByRole('heading', { name: 'Review complete' })
  ).toBeVisible();
}

test.describe('Grade buttons', () => {
  test('sit inline in a wide bar, tinted, and grade from there', async () => {
    await window.setViewportSize(WIDE);
    await reviewNewCard(window);
    const before = (await gradeLayout(window))!.bar;
    await window.getByRole('button', { name: 'Show answer' }).click();

    const layout = await expectPlacement(window, 'inline');
    expect(layout.groupFirstInCenter).toBe(true);
    expect(layout.row).toBeNull();
    // As tall as the bar's other buttons: showing them grows nothing
    expect(layout.bar.bottom - layout.bar.top).toBeCloseTo(
      before.bottom - before.top,
      1
    );
    expectAllReachable(layout);
    expectEqualSegments(layout);
    // A new card's first steps: Good is its second, ten minutes out
    expect(layout.segments.find((s) => s.word === 'Good')?.interval).toBe(
      '10m'
    );
    expect(await window.locator(VIEW).textContent()).not.toMatch(
      /\p{Extended_Pictographic}/u
    );

    // Each word in its theme color
    const tints = await window.evaluate(
      ({ view, tints }) => {
        const probe = document.body.appendChild(document.createElement('i'));
        const resolve = (token: string) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const result = Object.entries(tints).map(([word, token]) => {
          const el = Array.from(
            document.querySelectorAll(
              `${view} .ir-grade-group:not([aria-hidden]) .ir-grade-word`
            )
          ).find((w) => w.textContent === word)!;
          return [getComputedStyle(el).color, resolve(token)];
        });
        probe.remove();
        return result;
      },
      { view: VIEW, tints: TINTS }
    );
    for (const [shown, token] of tints) expect(shown).toBe(token);

    await gradeAs(window, 'Good');
  });

  test('take a full-width row below a narrow bar, all four on screen, and grade from there', async () => {
    await window.setViewportSize(NARROW);
    await reviewNewCard(window);
    await window.getByRole('button', { name: 'Show answer' }).click();

    const layout = await expectPlacement(window, 'row');
    expectAllReachable(layout);
    expectFullWidthRow(layout);
    // The bar keeps the top of the view; the row comes between it and the card
    expect(layout.row!.top).toBeGreaterThanOrEqual(layout.bar.bottom - 0.5);

    await gradeAs(window, 'Easy');
  });

  test('take a row above the bar on a phone, and grade from there', async () => {
    await emulateMobile(window, true);
    await window.setViewportSize(PHONE);
    await expect(window.locator('body')).toHaveClass(/\bis-phone\b/);
    await reviewNewCard(window);
    await window.getByRole('button', { name: 'Show answer' }).click();

    const layout = await expectPlacement(window, 'row');
    expectAllReachable(layout);
    expectFullWidthRow(layout);
    // The bar keeps the bottom; the row comes between the card and it
    expect(layout.row!.bottom).toBeLessThanOrEqual(layout.bar.top + 0.5);

    await gradeAs(window, 'Forgot');
  });

  test('use the row on a phone even with room to spare', async () => {
    await emulateMobile(window, true);
    // A phone held sideways: wide, but under 600px tall
    await window.setViewportSize({ width: 1400, height: 500 });
    await expect(window.locator('body')).toHaveClass(/\bis-phone\b/);
    await reviewNewCard(window);
    await window.getByRole('button', { name: 'Show answer' }).click();

    expectAllReachable(await expectPlacement(window, 'row'));
  });

  test('move between inline and row once as the window narrows, never flickering', async () => {
    await window.setViewportSize(WIDE);
    await reviewNewCard(window);
    await window.getByRole('button', { name: 'Show answer' }).click();
    await expectPlacement(window, 'inline');

    // Every move of the grades, counted in the page: a round-trip per sample
    // would be far too slow to see a flicker.
    await window.evaluate((view) => {
      const root = document.querySelector(view)!;
      const w = window as unknown as { __gradeMoves: number };
      w.__gradeMoves = 0;
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of [...record.addedNodes, ...record.removedNodes]) {
            if (
              node instanceof Element &&
              (node.matches('.ir-grade-row') ||
                (node.matches('.ir-grade-group') &&
                  !node.closest('.ir-grade-ghost') &&
                  record.target instanceof Element &&
                  record.target.matches('.ir-bar-center')))
            ) {
              w.__gradeMoves++;
            }
          }
        }
      }).observe(root, { childList: true, subtree: true });
    }, VIEW);
    const moves = () =>
      window.evaluate(
        () => (window as unknown as { __gradeMoves: number }).__gradeMoves
      );

    const placements: string[] = [];
    for (let width = 1400; width >= 600; width -= 8) {
      await window.setViewportSize({ width, height: WIDE.height });
      await window.evaluate(
        () =>
          new Promise<void>((r) =>
            requestAnimationFrame(() => requestAnimationFrame(() => r()))
          )
      );
      const before = await moves();
      await window.waitForTimeout(50);
      expect(await moves()).toBe(before);
      placements.push((await gradeLayout(window))!.placement);
    }
    const crossing = placements.indexOf('row');
    expect(crossing).toBeGreaterThan(0);
    expect(placements.slice(0, crossing).every((p) => p === 'inline')).toBe(
      true
    );
    expect(placements.slice(crossing).every((p) => p === 'row')).toBe(true);
    // Out of the middle zone, into the row: once each
    expect(await moves()).toBe(2);

    // And right at the threshold either way, it holds still
    const threshold = 1400 - crossing * 8;
    for (const width of [threshold, threshold + 8, threshold, threshold + 8]) {
      await window.setViewportSize({ width, height: WIDE.height });
      const expected = width === threshold ? 'row' : 'inline';
      await expectPlacement(window, expected);
      const before = await moves();
      await window.waitForTimeout(300);
      expect(await moves()).toBe(before);
    }
  });
});
