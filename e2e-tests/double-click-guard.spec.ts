import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import {
  executeCommandById,
  expectReviewOn,
  importArticle,
  scrollToText,
  selectParagraph,
  setPluginSetting,
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
  vaultPath = await createVaultCopy('double-click-guard');
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

/** The review pane's title, while it names `title`. */
const paneTitle = (title: string) =>
  window.locator('.ir-title', { hasText: title });

const markReviewed = () =>
  window
    .locator('.workspace-leaf.mod-active .ir-action-bar')
    .getByRole('button', { name: 'Mark reviewed' });

test('a second click right after review moves on is ignored rather than reviewing the next item', async () => {
  await importArticle(window, 'sources/Security Principles');
  await importArticle(window, 'sources/Curse of dimensionality - Wikipedia');
  await importArticle(
    window,
    'sources/Memorizing a programming language using spaced repetition'
  );
  await executeCommandById(window, 'incremental-reading:learn');
  await window.locator('css=#begin-review-button').click();
  const first = await waitForReviewItem(window);

  // Off for this click (the suite's vaults start with it off), then a minute
  // long: the guard is armed when the next item shows, whatever it is set to,
  // and the setting is read when a click lands. A minute leaves no timing for
  // the test to race.
  await markReviewed().click();
  await setPluginSetting(window, 'actionCooldownSeconds', 60);
  await expect(paneTitle(first.title)).toHaveCount(0);
  const second = await waitForReviewItem(window);

  await markReviewed().click();

  // Reviewing writes to the database and fetches the next item, well inside
  // this; the item still on screen afterwards is the guard's doing.
  await window.waitForTimeout(1_000);
  await expectReviewOn(window, second);

  // With the guard off the same button reviews it: the click was held, not
  // lost to a broken button.
  await setPluginSetting(window, 'actionCooldownSeconds', 0);
  await markReviewed().click();
  await expect(paneTitle(second.title)).toHaveCount(0);
  const third = await waitForReviewItem(window);
  expect([first.title, second.title]).not.toContain(third.title);
});

/** A paragraph of each article the snippet test may land on, to select whole. */
const PARAGRAPHS: Record<string, string> = {
  'Security Principles':
    'Before we start discussing the different security principles, it is ' +
    'vital to know the adversary against whom we are protecting our assets.',
  'Curse of dimensionality - Wikipedia':
    'In some problems, each variable can take one of several discrete ' +
    'values, or the range of possible values is divided to give a finite ' +
    'number of possibilities.',
};

const createSnippet = () =>
  window
    .locator('.workspace-leaf.mod-active .ir-action-bar')
    .getByRole('button', { name: 'Create snippet' });

/** How many snippets the text on screen is highlighted as the source of. */
const snippetsHighlighted = () =>
  window
    .locator('.workspace-leaf.mod-active .ir-snippet-highlight')
    .evaluateAll(
      (marks) =>
        new Set(marks.map((mark) => mark.getAttribute('data-snippet-id'))).size
    );

test('creating a snippet right after review moves on is ignored rather than extracting from the next item', async () => {
  await importArticle(window, 'sources/Security Principles');
  await importArticle(window, 'sources/Curse of dimensionality - Wikipedia');
  await executeCommandById(window, 'incremental-reading:learn');
  await window.locator('css=#begin-review-button').click();
  const first = await waitForReviewItem(window);

  // Armed as the next item shows, held for a minute (see above)
  await markReviewed().click();
  await setPluginSetting(window, 'actionCooldownSeconds', 60);
  await expect(paneTitle(first.title)).toHaveCount(0);
  const second = await waitForReviewItem(window);
  const paragraph = PARAGRAPHS[second.title];
  expect(paragraph).toBeDefined();
  await scrollToText(window, paragraph);
  await selectParagraph(window, paragraph);

  await createSnippet().click();
  await createSnippet().click();
  // The hotkey's way in, held the same
  await executeCommandById(window, 'incremental-reading:extract-selection');

  // Extracting writes the snippet and highlights its source well inside this
  await window.waitForTimeout(1_000);
  expect(await snippetsHighlighted()).toBe(0);

  // With the guard off the same button extracts, once per click: the
  // selection was still there, and the held clicks left nothing queued
  await setPluginSetting(window, 'actionCooldownSeconds', 0);
  await createSnippet().click();
  await expect.poll(snippetsHighlighted).toBe(1);
  await expectReviewOn(window, second);
});

for (const via of ['button', 'command'] as const) {
  test(`a second snippet made by ${via} right after the first is ignored, with the item unchanged`, async () => {
    const title = 'Security Principles';
    await importArticle(window, `sources/${title}`);
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    await expectReviewOn(window, await waitForReviewItem(window));
    const paragraph = PARAGRAPHS[title];
    await selectParagraph(window, paragraph);
    const extract = () =>
      via === 'button'
        ? createSnippet().click()
        : executeCommandById(window, 'incremental-reading:extract-selection');

    // Showing the item armed the guard too; past its 2 s, only the first
    // snippet can have armed it for the second press
    await window.waitForTimeout(2_100);
    await setPluginSetting(window, 'actionCooldownSeconds', 2);
    await extract();
    await extract();

    await expect.poll(snippetsHighlighted).toBe(1);
    await window.waitForTimeout(500);
    expect(await snippetsHighlighted()).toBe(1);

    // With the guard off both presses make one each: the selection is still
    // there for the second
    await setPluginSetting(window, 'actionCooldownSeconds', 0);
    await extract();
    await extract();
    await expect.poll(snippetsHighlighted).toBe(3);
  });
}
