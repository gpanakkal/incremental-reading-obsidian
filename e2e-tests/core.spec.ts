import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import {
  executeCommand,
  finalizeArticleImport,
  openNote,
  selectParagraph,
} from './helpers';
import {
  closeElectron,
  createVaultCopy,
  launchElectron,
  openVault,
  shouldCleanup,
} from './setup/helpers';

/**
 * Tests of core plugin functionality:
 * - Opening review interface
 * - Importing articles
 * -
 */

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
    await fs.rm(vaultPath, { recursive: true, force: true });
  }
});

test('Can open the review interface by executing the command', async () => {
  await executeCommand(window, 'incremental-reading:learn');

  // Verify the tab header for the review interface is visible
  await expect(
    window.locator('div.workspace-tab-header[aria-label="Incremental Reading"]')
  ).toBeVisible();
});

test('Can open the review interface from the ribbon button', async () => {
  await window.getByLabel('Incremental Reading').click();
  // Verify the tab header for the review interface is visible
  await expect(
    window.locator('div.workspace-tab-header[aria-label="Incremental Reading"]')
  ).toBeVisible();
});

test.describe('Article Importing', () => {
  test('can import Markdown from the file explorer context menu', async () => {
    // macOS uses native context menus which are invisible to Playwright
    test.skip(process.platform === 'darwin', 'Native context menus on macOS');

    await window
      .locator('div')
      .filter({ hasText: /^sources$/ })
      .nth(1)
      .click();

    await window.getByText('Curse of dimensionality - Wikipedia').click({
      button: 'right',
    });
    await window.getByText('Import article').click();
    await finalizeArticleImport(window);
    await window.getByLabel('Incremental Reading').click();

    // look for the action bar to confirm we're in review
    await expect(
      window.getByRole('button', { name: 'Continue' })
    ).toBeVisible();
    await expect(
      window.getByText('Curse of dimensionality - Wikipedia').nth(1)
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
    await executeCommand(window, 'incremental-reading:learn');

    // look for the action bar to confirm we're in review
    await expect(
      window.getByRole('button', { name: 'Continue' })
    ).toBeVisible();
    await expect(
      window
        .getByText(
          'Memorizing a programming language using spaced repetition software'
        )
        .nth(3)
    ).toBeInViewport();
  });

  test('can import Markdown from the command palette', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );

    await executeCommand(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await executeCommand(window, 'incremental-reading:learn');

    // look for the action bar to confirm we're in review
    await expect(
      window.getByRole('button', { name: 'Continue' })
    ).toBeVisible();
    await expect(
      window
        .getByText(
          'Memorizing a programming language using spaced repetition software'
        )
        .nth(3)
    ).toBeVisible();
  });
});

test.describe('Action Bar', () => {
  test('Can review articles', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );

    await executeCommand(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await executeCommand(window, 'incremental-reading:learn');
    await window.getByRole('button', { name: 'Continue' }).click();

    await executeCommand(window, 'workspace:close');

    await executeCommand(window, 'incremental-reading:learn');
    await expect(
      window
        .getByText(
          'Memorizing a programming language using spaced repetition software'
        )
        .nth(3)
    ).not.toBeVisible();
  });

  test('Can skip items', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );

    await executeCommand(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await executeCommand(window, 'incremental-reading:learn');

    const skipButton = window.getByRole('button', { name: 'Skip' });
    await expect(skipButton).toBeInViewport();
    await skipButton.click();

    await expect(window.getByText('Nothing due for review.')).toBeVisible();
    await executeCommand(window, 'workspace:close');

    await executeCommand(window, 'incremental-reading:learn');
    await expect(
      window
        .getByText(
          'Memorizing a programming language using spaced repetition software'
        )
        .nth(3)
    ).toBeVisible();
  });

  test('Can dismiss items from review UI', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );

    await executeCommand(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await executeCommand(window, 'incremental-reading:learn');

    const dismissButton = window.getByRole('button', { name: 'Dismiss' });
    await expect(dismissButton).toBeInViewport();
    await dismissButton.click();

    await executeCommand(window, 'workspace:close');

    await executeCommand(window, 'incremental-reading:learn');
    await expect(
      window
        .getByText(
          'Memorizing a programming language using spaced repetition software'
        )
        .nth(3)
    ).not.toBeVisible();
  });

  test('Can dismiss items from note pane', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );

    await executeCommand(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);

    await openNote(
      window,
      'incremental-reading/articles/Memorizing a programming language using spaced repetition'
    );

    const dismissButton = window.getByRole('button', { name: 'Dismiss' });
    await expect(dismissButton).toBeInViewport();
    await dismissButton.click();

    await executeCommand(window, 'incremental-reading:learn');
    await expect(
      window
        .getByText(
          'Memorizing a programming language using spaced repetition software'
        )
        .nth(3)
    ).not.toBeVisible();
  });

  test('Can un-dismiss items from note pane', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );

    await executeCommand(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);

    await openNote(
      window,
      'incremental-reading/articles/Memorizing a programming language using spaced repetition'
    );

    const dismissButton = window.getByRole('button', { name: 'Dismiss' });
    await expect(dismissButton).toBeInViewport();
    await dismissButton.click();

    await executeCommand(window, 'incremental-reading:learn');
    await expect(
      window
        .getByText(
          'Memorizing a programming language using spaced repetition software'
        )
        .nth(3)
    ).not.toBeVisible();

    await executeCommand(window, 'workspace:close');

    const unDismissButton = window.getByRole('button', { name: 'Un-dismiss' });
    await expect(unDismissButton).toBeInViewport();
    await unDismissButton.click();

    await executeCommand(window, 'incremental-reading:learn');
    await expect(window.locator('.ir-title')).toBeInViewport();
  });

  test.skip('Can change priority from the review pane', async () => {});
});

test.describe('Extracting snippets', () => {
  test('Can extract from Markdown notes', async () => {
    await openNote(window, 'sources/Security Principles');

    // select a paragraph
    await selectParagraph(
      window,
      'Before we start discussing the different security principles'
    );
    await executeCommand(window, 'incremental-reading:extract-selection');

    await openNote(
      window,
      `incremental-reading/snippets/Before we start discussing`
    );
    await expect(
      window.getByRole('button', { name: 'Open in Review' })
    ).toBeVisible();
  });

  test('Can extract from articles in review interface', async () => {
    await openNote(window, 'sources/Security Principles');

    await executeCommand(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await executeCommand(window, 'incremental-reading:learn');

    // look for the action bar to confirm we're in review
    await expect(
      window.getByRole('button', { name: 'Continue' })
    ).toBeVisible();

    await selectParagraph(
      window,
      'Before we start discussing the different security principles'
    );
    await executeCommand(window, 'incremental-reading:extract-selection');

    await openNote(
      window,
      `incremental-reading/snippets/Before we start discussing`
    );
    await expect(
      window.getByRole('button', { name: 'Open in Review' })
    ).toBeVisible();
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
    await executeCommand(window, 'incremental-reading:extract-selection');

    await openNote(
      window,
      `incremental-reading/snippets/Security has become a buzzword`
    );
    // open the first snippet in review
    await window.getByRole('button', { name: 'Open in Review' }).click();

    // look for the action bar to confirm we're in review
    await expect(
      window.getByRole('button', { name: 'Continue' })
    ).toBeInViewport();

    // Extract the second paragraph
    await selectParagraph(window, 'Before we start discussing');
    await executeCommand(window, 'incremental-reading:extract-selection');

    await openNote(
      window,
      `incremental-reading/snippets/Before we start discussing`
    );
    await window.getByRole('button', { name: 'Open in Review' }).click();

    // look for the action bar to confirm we're in review
    await expect(
      window.getByRole('button', { name: 'Continue' })
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
    test.skip(process.platform === 'darwin', 'Native context menus on macOS');
    await openNote(window, 'sources/Curse of dimensionality - Wikipedia');
    // replace with command
    await window.getByRole('button', { name: 'More options' }).click();
    await window.getByText('Source mode').click();

    // select the first opening bracket '['
    await window.locator('.cm-formatting.cm-formatting-link').first().click();
    // highlight the rest of the paragraph
    await window.getByText('---title: "Curse of').press('Shift+End');
    await window.getByText('---title: "Curse of').press('Shift+End');

    await executeCommand(window, 'incremental-reading:extract-selection');
    await openNote(
      window,
      'incremental-reading/snippets/high-dimensional spaces'
    );

    await expect(
      window.getByRole('button', { name: 'Open in Review' })
    ).toBeInViewport();
  });
});
