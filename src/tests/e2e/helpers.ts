import type { Page } from '@playwright/test';

// Reusable functions to execute Obsidian operations in tests

/**
 * Execute an Obsidian command by its ID, bypassing the command palette UI.
 * Uses the unofficial but stable `window.app.commands` API.
 */
export async function executeCommand(window: Page, commandId: string) {
  await window.evaluate(async (id) => {
    (window as any).app.commands.executeCommandById(id);
    // Yield to the event loop so Obsidian can process the command's
    // side effects (opening modals, async DB writes, rendering) before
    // the test continues. Without this, sequential commands can race
    // because executeCommandById returns synchronously.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }, commandId);
}

/**
 * Clicks the Import button in the priority modal and waits for the async
 * import to complete. The modal closes itself after the import finishes,
 * so we wait for it to disappear.
 */
export async function finalizeArticleImport(window: Page) {
  await window.getByRole('button', { name: 'Import' }).click();
  await window.locator('.modal-bg').waitFor({ state: 'hidden' });
}

/**
 * Opens a note in the current tab.
 * TODO: Make more resilient (e.g., handle if the note is already open)
 * @param path relative path using forward slashes. Do not enquote segments.
 */
export async function openNote(window: Page, path: string) {
  await executeCommand(window, 'switcher:open');
  const quickSwitcher = window.getByPlaceholder('Find or create a note...');
  await quickSwitcher.fill(path);

  // Register file-open listener beforehand so we don't miss the event.
  const fileOpenPromise = window.evaluate(() => {
    return new Promise<void>((resolve) => {
      const NOTE_OPEN_TIMEOUT_MS = 10_000;
      const workspace = (window as any).app.workspace;
      const ref = workspace.on('file-open', () => {
        workspace.offref(ref);
        resolve();
      });
      // Safety: clean up listener if event never fires
      setTimeout(() => workspace.offref(ref), NOTE_OPEN_TIMEOUT_MS);
    });
  });

  await window.locator('div').filter({ hasText: path }).nth(1).click();

  // Wait for Obsidian to confirm the file is open
  await fileOpenPromise;

  // Wait for the quick switcher modal to fully close
  await window.locator('.modal-bg').waitFor({ state: 'hidden' });
}
