import { CURRENT_ITEM_REFETCH_TIME } from '#/lib/constants';
import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import { emulateMobile, REVIEW_VIEW_TYPE, reviewNewCard } from './helpers';
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
 * All four segments, in order, each word over its interval (or the word
 * alone, with the intervals off), fully on screen and inside what clips them,
 * so none is scrolled out of reach.
 */
function expectAllReachable(layout: GradeLayout, { intervals = true } = {}) {
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
    if (intervals) {
      expect(() => labelMs(interval)).not.toThrow();
      expect(label).toBe(`${word}, next review in ${interval}`);
    } else {
      expect(interval).toBe('');
      expect(label).toBe(word);
    }
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

/**
 * Check grading took, as review shows it: it moves on to the summary, which
 * counts the one card reviewed.
 */
async function expectGraded(page: Page) {
  await expect(
    page.getByRole('heading', { name: 'Review complete' })
  ).toBeVisible();
  await expect(page.locator('.ir-review-summary-total')).toHaveText(
    '1 item reviewed'
  );
  await expect(
    page.locator('.ir-review-summary-count', { hasText: /^1\s*Card$/ })
  ).toBeVisible();
}

/** Grade the card on screen as `word`, and check grading took. */
async function gradeAs(page: Page, word: (typeof WORDS)[number]) {
  await page.getByRole('button', { name: `${word}, next review in` }).click();
  await expectGraded(page);
}

/** Unofficial: `window.app`, `app.plugins.plugins`. */
type PluginWindow = {
  app: {
    setting: {
      pluginTabs: {
        plugin: unknown;
        setControlValue: (key: string, value: unknown) => Promise<void>;
      }[];
    };
    plugins: {
      plugins: Record<
        string,
        {
          settings: { fsrsParams: Record<string, unknown> };
        }
      >;
    };
  };
};

/** Turn FSRS fuzz on or off, as the settings tab's toggle does. */
function setFuzz(page: Page, on: boolean) {
  return page.evaluate((on) => {
    const plugin = (window as unknown as PluginWindow).app.plugins.plugins[
      'incremental-reading'
    ];
    plugin.settings.fsrsParams = {
      ...plugin.settings.fsrsParams,
      enable_fuzz: on,
    };
  }, on);
}

/**
 * Turn "Show intervals on grade buttons" on or off through the plugin's
 * settings tab, as its toggle does, without opening the settings window.
 * Unofficial: `app.setting.pluginTabs`.
 */
function setShowIntervals(page: Page, on: boolean) {
  return page.evaluate(async (on) => {
    const { app } = window as unknown as PluginWindow;
    const plugin = app.plugins.plugins['incremental-reading'];
    const tab = app.setting.pluginTabs.find((t) => t.plugin === plugin);
    if (!tab) throw new Error('no settings tab for the plugin');
    await tab.setControlValue('showGradeIntervals', on);
  }, on);
}

/**
 * Grade the card on screen as `word` from a button named by its word alone,
 * and check grading took.
 */
async function gradeAsWordOnly(page: Page, word: (typeof WORDS)[number]) {
  await page.getByRole('button', { name: word, exact: true }).click();
  await expectGraded(page);
}

/** What each grade button shows, and is named, in grade order. */
function gradeLabels(page: Page) {
  return page.evaluate(
    (view) =>
      Array.from(
        document.querySelectorAll(
          `${view} .ir-grade-group:not([aria-hidden]) > button`
        ),
        (b) => [
          b.querySelector('.ir-grade-interval')?.textContent ?? '',
          b.getAttribute('aria-label') ?? '',
        ]
      ),
    VIEW
  );
}

test.describe('Grade buttons', () => {
  // Every case here reads the intervals, which are off until turned on
  test.beforeEach(async () => {
    await setShowIntervals(window, true);
  });

  test('hold their intervals while the card is shown, marked approximate where fuzz can move them', async () => {
    await window.setViewportSize(WIDE);
    await reviewNewCard(window);
    await setFuzz(window, true);
    await window.getByRole('button', { name: 'Show answer' }).click();
    await expectPlacement(window, 'inline');

    // A new card: three learning steps fuzz never touches, then Easy's first
    // interval, which it does
    const first = await gradeLabels(window);
    expect(first.map(([interval]) => interval.startsWith('~'))).toEqual([
      false,
      false,
      false,
      true,
    ]);
    first.forEach(([interval, label], i) => {
      expect(() => labelMs(interval.replace(/^~/, ''))).not.toThrow();
      expect(label).toBe(`${WORDS[i]}, next review in ${interval}`);
    });

    // Sampled through two polls of the current item: fuzz reseeded at each one
    // used to move them a few days either way
    const deadline = Date.now() + 2 * CURRENT_ITEM_REFETCH_TIME + 1_000;
    while (Date.now() < deadline) {
      expect(await gradeLabels(window)).toEqual(first);
      await window.waitForTimeout(250);
    }

    // Fuzz off: exact, with no `~`, from the next poll
    await setFuzz(window, false);
    await expect
      .poll(async () => (await gradeLabels(window)).map(([i]) => i[0]), {
        timeout: CURRENT_ITEM_REFETCH_TIME + 2_000,
      })
      .not.toContain('~');
    const exact = await gradeLabels(window);
    exact.forEach(([interval, label], i) => {
      expect(() => labelMs(interval)).not.toThrow();
      expect(label).toBe(`${WORDS[i]}, next review in ${interval}`);
    });

    await gradeAs(window, 'Easy');
  });

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

  test('use the row on a phone even with room to spare', async () => {
    await emulateMobile(window, true);
    // A phone held sideways: wide, but under 600px tall
    await window.setViewportSize({ width: 1400, height: 500 });
    await expect(window.locator('body')).toHaveClass(/\bis-phone\b/);
    await reviewNewCard(window);
    await window.getByRole('button', { name: 'Show answer' }).click();

    expectAllReachable(await expectPlacement(window, 'row'));
  });
});

test.describe('Grade buttons, intervals off', () => {
  test('take a row above the bar on a phone, and grade from there', async () => {
    await emulateMobile(window, true);
    await window.setViewportSize(PHONE);
    await expect(window.locator('body')).toHaveClass(/\bis-phone\b/);
    await reviewNewCard(window);
    await window.getByRole('button', { name: 'Show answer' }).click();

    const layout = await expectPlacement(window, 'row');
    expectAllReachable(layout, { intervals: false });
    expectFullWidthRow(layout);
    expect(layout.row!.bottom).toBeLessThanOrEqual(layout.bar.top + 0.5);

    await gradeAsWordOnly(window, 'Forgot');
  });

  /** The heights toggling could change: each segment, the bar, the row. */
  async function heights(page: Page, intervals: boolean) {
    await setShowIntervals(page, intervals);
    await expect
      .poll(async () => (await gradeLabels(page)).map(([i]) => i !== ''), {
        timeout: CURRENT_ITEM_REFETCH_TIME / 2,
      })
      .toEqual([intervals, intervals, intervals, intervals]);
    const layout = (await gradeLayout(page))!;
    // The copy the bar measures the grades' width by
    const ghost = await page.evaluate((view) => {
      const group = document.querySelector(
        `${view} .ir-grade-ghost > .ir-grade-group`
      )!;
      return {
        width: group.getBoundingClientRect().width,
        segments: Array.from(
          group.children,
          (b) => b.getBoundingClientRect().height
        ),
      };
    }, VIEW);
    const real = layout.segments.map(({ box }) => box);
    return {
      layout,
      segments: real.map((box) => box.bottom - box.top),
      width: real[3].right - real[0].left,
      ghost,
      bar: layout.bar.bottom - layout.bar.top,
      row: layout.row && layout.row.bottom - layout.row.top,
    };
  }

  for (const [name, placement, mobile, viewport] of [
    ['inline in a wide bar', 'inline', false, WIDE],
    ['in the row below a narrow bar', 'row', false, NARROW],
    ['in the row above the bar on a phone', 'row', true, PHONE],
  ] as const) {
    test(`keep their height ${name}, intervals or not`, async () => {
      if (mobile) await emulateMobile(window, true);
      await window.setViewportSize(viewport);
      if (mobile) {
        await expect(window.locator('body')).toHaveClass(/\bis-phone\b/);
      }
      await reviewNewCard(window);
      await window.getByRole('button', { name: 'Show answer' }).click();
      await expectPlacement(window, placement);

      const on = await heights(window, true);
      const off = await heights(window, false);

      expect(on.layout.placement).toBe(placement);
      expect(off.layout.placement).toBe(placement);
      expect(off.segments).toHaveLength(4);
      // Inline, the zone stretches the real group to the bar's buttons either
      // way, so there the ghost, laid out unstretched, is what can tell
      for (const [i, height] of off.segments.entries()) {
        expect(height).toBeCloseTo(on.segments[i], 0);
        expect(off.ghost.segments[i]).toBeCloseTo(on.ghost.segments[i], 0);
      }
      // Inline, the ghost is as wide as what it stands for, either way
      if (placement === 'inline') {
        expect(on.ghost.width).toBeCloseTo(on.width, 0);
        expect(off.ghost.width).toBeCloseTo(off.width, 0);
      }
      expect(off.bar).toBeCloseTo(on.bar, 0);
      if (placement === 'row') expect(off.row!).toBeCloseTo(on.row!, 0);
      // The word sits in the middle of its segment
      const centred = await window.evaluate(
        (view) =>
          Array.from(
            document.querySelectorAll(
              `${view} .ir-grade-group:not([aria-hidden]) > button`
            ),
            (b) => {
              const box = b.getBoundingClientRect();
              const word = b
                .querySelector('.ir-grade-word')!
                .getBoundingClientRect();
              return word.top - box.top - (box.bottom - word.bottom);
            }
          ),
        VIEW
      );
      for (const offset of centred) expect(Math.abs(offset)).toBeLessThan(1);
    });
  }
});
