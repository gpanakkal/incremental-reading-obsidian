import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import {
  closeElectron,
  createVaultCopy,
  launchElectron,
  openVault,
  shouldCleanup,
} from '../e2e-setup/helpers';
import { executeCommand, finalizeArticleImport, openNote } from './helpers';

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
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );

    // select a paragraph
    await window.getByText('I’m an intermediate').click({ clickCount: 3 });
    await executeCommand(window, 'incremental-reading:extract-selection');

    // TODO: replace with wait for file creation
    await window.waitForTimeout(200);
    await openNote(
      window,
      `incremental-reading/snippets/I’m an intermediate programmer\. I didn’t go to sch`
    );
    await window.getByRole('button', { name: 'Open in Review' }).click();
    await expect(
      window.getByRole('button', { name: 'Continue' })
    ).toBeVisible();
  });

  test('Can extract from articles in review interface', async () => {
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

    // select a paragraph
    await window
      .getByText('I’m an intermediate')
      .nth(1)
      .click({ clickCount: 3 });
    await executeCommand(window, 'incremental-reading:extract-selection');

    // TODO: replace with wait for file creation
    await window.waitForTimeout(200);
    await openNote(
      window,
      `incremental-reading/snippets/I’m an intermediate programmer\. I didn’t go to sch`
    );
    await window.getByRole('button', { name: 'Open in Review' }).click();

    // look for the action bar to confirm we're in review
    await expect(
      window.getByRole('button', { name: 'Continue' })
    ).toBeInViewport();
    await expect(
      window.getByRole('textbox').filter({ hasText: 'I’m an intermediate' })
    ).toBeVisible();
  });

  test('Can extract from snippets in review interface', async () => {
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
    ).toBeInViewport();

    // select a paragraph
    await window
      .getByText('I’m an intermediate')
      .nth(1)
      .click({ clickCount: 3 });
    await window.waitForTimeout(200);
    await executeCommand(window, 'incremental-reading:extract-selection');

    // TODO: replace with wait for file creation
    await window.waitForTimeout(200);

    await openNote(
      window,
      `incremental-reading/snippets/I’m an intermediate programmer\. I didn’t go to sch`
    );
    await window.getByRole('button', { name: 'Open in Review' }).click();

    // look for the action bar to confirm we're in review
    await expect(
      window.getByRole('button', { name: 'Continue' })
    ).toBeInViewport();

    // split this snippet into two paragraphs and extract the second
    const snippetText = window.getByRole('textbox').filter({
      hasText: /^I’m an intermediate programmer\. I didn’t go to school for it/,
      visible: true,
    });
    await expect(snippetText).toBeVisible();
    await snippetText.click();
    // wait for Obsidian interface to catch up
    await window.waitForTimeout(200);
    await snippetText.press('ControlOrMeta+Home');
    // insert a new line
    await snippetText.press('ArrowDown');
    await snippetText.press('ArrowDown');
    await snippetText.press('Enter');
    await snippetText.press('Enter');
    await window
      .getByText('so I picked up a few books on PHP, SQL, Linux')
      .filter({ visible: true })
      .click({ clickCount: 3 });
    await executeCommand(window, 'incremental-reading:extract-selection');

    await window
      .locator('span')
      .filter({ hasText: 'so I picked up a few books on' })
      .click();
    await window.getByRole('button', { name: 'Open in Review' }).click();

    // look for the action bar to confirm we're in review
    await expect(
      window.getByRole('button', { name: 'Continue' })
    ).toBeInViewport();
    await expect(
      window
        .getByText('so I picked up a few books on PHP, SQL, Linux, and Apache')
        .filter({ visible: true })
    ).toBeInViewport();
  });

  test('file name has no leading spaces when first char is "["', async () => {
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
