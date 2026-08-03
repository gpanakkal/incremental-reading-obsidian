import type { Page } from '@playwright/test';
import type { App } from 'obsidian';
import { waitForLayoutReady } from './setup/helpers';

// Reusable functions to execute Obsidian operations in tests

/**
 * Execute an Obsidian command by its ID, bypassing the command palette UI.
 * Uses the unofficial but stable `window.app.commands` API.
 *
 * Tip: find command IDs with `app.commands.listCommands()` in the Obsidian dev console
 * @returns `true` if the command was successfully executed, or `false` otherwise
 */
export async function executeCommandById(window: Page, commandId: string) {
  return await window.evaluate(async (id) => {
    const result = (
      window as Page & { app: App }
    ).app.commands.executeCommandById(id);
    // Yield to the event loop so Obsidian can process the command's
    // side effects (opening modals, async DB writes, rendering) before
    // the test continues. Without this, sequential commands can race
    // because executeCommandById returns synchronously.
    await new Promise((resolve) => setTimeout(resolve, 200));
    return result;
  }, commandId);
}

/**
 * Clicks the Import button in the priority modal and waits for the async
 * import to complete. The modal closes itself after the import finishes,
 * so we wait for it to disappear.
 */
export async function finalizeArticleImport(window: Page) {
  await window.getByRole('button', { name: 'Confirm' }).click();
  await window.locator('.modal-bg').waitFor({ state: 'hidden' });
}

/**
 * Opens a note in the current tab.
 * TODO: Make more resilient (e.g., handle if the note is already open)
 * @param path relative path using forward slashes. Do not enquote segments.
 */
export async function openNote(window: Page, path: string) {
  // Obsidian can still be booting (indexing the vault, loading plugins), and
  // each of those can replace the renderer's execution context. Waiting for a
  // ready workspace first keeps the evaluate() below from being destroyed
  // mid-round-trip.
  //
  // Best-effort: if the page is already gone the app has died, and the quick
  // switcher interaction below reports that far more legibly than a stack
  // pointing at this guard.
  await waitForLayoutReady(window).catch(() => {});

  // Register file-open listener before opening the quick switcher, because
  // the switcher can trigger navigation (destroying the execution context)
  // before evaluate() completes its round-trip — especially on macOS.
  const fileOpenPromise = window.evaluate(() => {
    return new Promise<void>((resolve) => {
      const NOTE_OPEN_TIMEOUT_MS = 10_000;
      const workspace = (window as Page & { app: App }).app.workspace;
      const ref = workspace.on('file-open', () => {
        workspace.offref(ref);
        resolve();
      });
      // Safety: if the event never fires, resolve anyway so the caller falls
      // through to the modal-hidden wait below, which fails in seconds with a
      // readable error. Leaving this pending instead would hang the test until
      // Playwright's 300s timeout.
      setTimeout(() => {
        workspace.offref(ref);
        resolve();
      }, NOTE_OPEN_TIMEOUT_MS);
    });
  });

  await executeCommandById(window, 'switcher:open');
  const quickSwitcher = window.getByPlaceholder('Find or create a note...');

  await quickSwitcher.fill(path);
  await quickSwitcher.press('Enter');
  // click instead of pressing Enter:
  // await window.locator('div').filter({ hasText: path }).nth(1).click();

  // Wait for Obsidian to confirm the file is open
  await fileOpenPromise;

  // Wait for the quick switcher modal to fully close
  await window.locator('.modal-bg').waitFor({ state: 'hidden' });
}

/**
 * Select a paragraph by text match and wait for Obsidian to catch up
 * TODO: see if Obsidian emits an event we can listen for instead
 * @param window
 * @param text a sequence uniquely identifying the target paragraph
 */
export async function selectParagraph(
  window: Page,
  text: string,
  waitMs = 300
) {
  await window
    .getByText(text)
    .filter({ visible: true })
    .click({ clickCount: 3 });
  // wait for Obsidian
  await window.waitForTimeout(waitMs);
}
