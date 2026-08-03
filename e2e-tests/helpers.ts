import { expect, type Page } from '@playwright/test';
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
  // `evaluate` rejects outright if Obsidian replaces the renderer's execution
  // context mid-round-trip (plugin load, workspace restore, a command that
  // navigates). That is a transient condition, not a test failure, so wait for
  // a ready workspace and try once more rather than surfacing "Execution
  // context was destroyed" from whichever line happened to be running.
  const run = async () =>
    await window.evaluate(async (id) => {
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

  let result: boolean;
  try {
    result = await run();
  } catch (error) {
    if (!isContextDestroyedError(error)) throw error;
    await waitForLayoutReady(window);
    result = await run();
  }

  // Obsidian returns false when the command id does not exist, or when the
  // command's `checkCallback` declines to run it — which is what happens if
  // another modal already holds focus. Silently continuing turns that into a
  // 30s timeout on whatever UI the command was supposed to open, reported
  // against a line that is merely the first victim. Fail where the cause is.
  if (!result) {
    throw new Error(
      `executeCommandById('${commandId}') returned false: the command either ` +
        `does not exist or refused to run (commonly because another modal ` +
        `still has focus).`
    );
  }

  return result;
}

/** Whether a Playwright rejection is the renderer's context being replaced. */
function isContextDestroyedError(error: unknown) {
  return (
    error instanceof Error &&
    /Execution context was destroyed|Cannot find context/i.test(error.message)
  );
}

/**
 * How long to wait for a modal that the preceding action should have opened.
 *
 * Shorter than Playwright's 30s default on purpose. These modals appear within
 * a frame or two of the command that opens them, so a long wait buys nothing
 * except a slower report when the command silently did not run.
 */
const MODAL_TIMEOUT_MS = 15_000;

/** Same reasoning, for the quick switcher specifically. */
const SWITCHER_TIMEOUT_MS = 15_000;

/**
 * Clicks the Import button in the priority modal and waits for the async
 * import to complete. The modal closes itself after the import finishes,
 * so we wait for it to disappear.
 */
export async function finalizeArticleImport(window: Page) {
  // Wait for the modal itself before reaching for the button inside it.
  //
  // `click()` auto-waits for the button, but a modal that has not opened yet is
  // indistinguishable to it from a modal that will never open — both spend the
  // full 30s default and then report against the click. That is the Ubuntu CI
  // failure: "waiting for getByRole('button', { name: 'Confirm' })" when the
  // real problem was the import modal not being up yet.
  await window
    .locator('.modal-bg')
    .waitFor({ state: 'visible', timeout: MODAL_TIMEOUT_MS });

  const confirmButton = window.getByRole('button', { name: 'Confirm' });
  await confirmButton.waitFor({ state: 'visible', timeout: MODAL_TIMEOUT_MS });

  // Obsidian mounts modal content before it finishes wiring click handlers on a
  // loaded runner, so a click landing in that gap is accepted and discarded —
  // leaving the modal open and the next wait timing out. Retry until the modal
  // actually goes away, which is the observable proof the click registered.
  await expect(async () => {
    if (await confirmButton.isVisible()) await confirmButton.click();
    await expect(window.locator('.modal-bg')).toBeHidden({ timeout: 2_000 });
  }).toPass({ timeout: MODAL_TIMEOUT_MS });
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
  //
  // `.catch()` is attached immediately, not awaited later. If the context dies
  // while this evaluate is in flight it rejects, and an unawaited rejection
  // that only gets a handler further down is an unhandled rejection in the
  // meantime — which Playwright surfaces as a worker-level error detached from
  // any test. Swallowing it is correct: the waits below already report a note
  // that failed to open, and they do it with a usable stack.
  const fileOpenPromise = window
    .evaluate(() => {
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
    })
    .catch(() => {});

  await executeCommandById(window, 'switcher:open');

  const quickSwitcher = window.getByPlaceholder('Find or create a note...');

  // Wait for the switcher to actually be on screen before typing into it.
  //
  // `fill()` auto-waits too, but it waits the full 30s default and then reports
  // the failure against the fill — which is how a switcher that never opened
  // shows up in CI as "locator.fill: Timeout 30000ms exceeded". A shorter,
  // explicit wait fails faster and names the real problem.
  await quickSwitcher.waitFor({
    state: 'visible',
    timeout: SWITCHER_TIMEOUT_MS,
  });

  await quickSwitcher.fill(path);

  // Obsidian filters the suggestion list asynchronously. Pressing Enter before
  // the list has caught up either opens the wrong note or creates a new one
  // named after the query, so wait for a suggestion to exist first.
  await window
    .locator('.suggestion-item, .suggestion-empty')
    .first()
    .waitFor({ state: 'visible', timeout: SWITCHER_TIMEOUT_MS });

  await quickSwitcher.press('Enter');

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
