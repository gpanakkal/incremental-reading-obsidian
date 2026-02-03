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
import { openNote, useCommandPalette } from './helpers';

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
  await useCommandPalette(window, 'Incremental Reading: Learn');

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
    await window
      .locator('div')
      .filter({ hasText: /^sources$/ })
      .nth(1)
      .click();

    await window.getByText('Curse of dimensionality - Wikipedia').click({
      button: 'right',
    });
    await window.getByText('Import article').click();
    await window.getByRole('button', { name: 'Import' }).click();
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
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );

    await window.getByRole('button', { name: 'More options' }).click();
    await window.getByText('Import article').click();
    await window.getByRole('button', { name: 'Import' }).click();
    await useCommandPalette(window, 'Incremental Reading: Learn');

    // look for the action bar to confirm we're in review
    await expect(
      window.getByRole('button', { name: 'Continue' })
    ).toBeVisible();
    await expect(
      window
        .getByText(
          'Memorizing a programming language using spaced repetition software'
        )
        .nth(1)
    ).toBeVisible();
  });

  test('can import Markdown from the command palette', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );

    await useCommandPalette(window, 'Incremental Reading: Import Article');
    await window.getByRole('button', { name: 'Import' }).click();
    await useCommandPalette(window, 'Incremental Reading: Learn');

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

    await useCommandPalette(window, 'Incremental Reading: Import Article');
    await window.getByRole('button', { name: 'Import' }).click();
    await useCommandPalette(window, 'Incremental Reading: Learn');
    await window.getByRole('button', { name: 'Continue' }).click();

    await useCommandPalette(window, 'Close current tab');

    await useCommandPalette(window, 'Incremental Reading: Learn');
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

    await useCommandPalette(window, 'Incremental Reading: Import Article');
    await window.getByRole('button', { name: 'Import' }).click();
    await useCommandPalette(window, 'Incremental Reading: Learn');

    const skipButton = window.getByRole('button', { name: 'Skip' });
    await expect(skipButton).toBeInViewport();
    await skipButton.click();

    await expect(window.getByText('Nothing due for review.')).toBeVisible();
    await useCommandPalette(window, 'Close current tab');

    await useCommandPalette(window, 'Incremental Reading: Learn');
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

    await useCommandPalette(window, 'Incremental Reading: Import Article');
    await window.getByRole('button', { name: 'Import' }).click();
    await useCommandPalette(window, 'Incremental Reading: Learn');

    const dismissButton = window.getByRole('button', { name: 'Dismiss' });
    await expect(dismissButton).toBeInViewport();
    await dismissButton.click();

    await useCommandPalette(window, 'Close current tab');

    await useCommandPalette(window, 'Incremental Reading: Learn');
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

    await useCommandPalette(window, 'Incremental Reading: Import Article');
    await window.getByRole('button', { name: 'Import' }).click();

    await openNote(
      window,
      'incremental-reading/articles/Memorizing a programming language using spaced repetition'
    );

    const dismissButton = window.getByRole('button', { name: 'Dismiss' });
    await expect(dismissButton).toBeInViewport();
    await dismissButton.click();

    await useCommandPalette(window, 'Incremental Reading: Learn');
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

    await useCommandPalette(window, 'Incremental Reading: Import Article');
    await window.getByRole('button', { name: 'Import' }).click();

    await openNote(
      window,
      'incremental-reading/articles/Memorizing a programming language using spaced repetition'
    );

    const dismissButton = window.getByRole('button', { name: 'Dismiss' });
    await expect(dismissButton).toBeInViewport();
    await dismissButton.click();

    await useCommandPalette(window, 'Incremental Reading: Learn');
    await expect(
      window
        .getByText(
          'Memorizing a programming language using spaced repetition software'
        )
        .nth(3)
    ).not.toBeVisible();

    await useCommandPalette(window, 'Close current tab');

    const unDismissButton = window.getByRole('button', { name: 'Un-dismiss' });
    await expect(unDismissButton).toBeInViewport();
    await unDismissButton.click();

    await useCommandPalette(window, 'Incremental Reading: Learn');
    await expect(window.locator('.ir-title')).toBeInViewport();
  });

  test.skip('Can change priority from the review pane', async () => {});
});

test.describe.skip('Extracting snippets', () => {
  test('Can extract from Markdown notes', async () => {
    await openNote(
      window,
      'sources/Memorizing a programming language using spaced repetition'
    );
  });

  test('Can extract from articles in review interface', async () => {});

  test('Can extract from snippets in review interface', async () => {});
});
