import type { Page } from '@playwright/test';

// Reusable functions to execute Obsidian operations in tests

export async function useCommandPalette(window: Page, command: string) {
  await window.getByLabel('Open command palette', { exact: true }).click();
  const commandPalette = window.getByPlaceholder('Select a command...');
  await commandPalette.fill(command);
  await commandPalette.press('Enter');
}
/**
 * Opens a note in the current tab.
 * TODO: Make more resilient (e.g., handle if the note is already open)
 * @param path relative path using forward slashes. Do not enquote segments.
 */
export async function openNote(window: Page, path: string) {
  await useCommandPalette(window, 'Quick switcher: Open quick switcher');
  const quickSwitcher = window.getByPlaceholder('Find or create a note...');
  await quickSwitcher.fill(path);
  await window
    .locator('div')
    .filter({
      hasText: path,
    })
    .nth(1)
    .click();
}
