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
  // command's `checkCallback` declines to run it. Silently continuing turns
  // that into a timeout on whatever UI the command was supposed to open,
  // reported against a line that is merely the first victim.
  //
  // Note this is NOT sufficient to prove the command took effect. A `true` only
  // means the callback ran; during boot, `switcher:open` returns true while the
  // modal it opens never appears (see `openNote`). Callers that depend on a
  // visible result must still verify it.
  if (!result) {
    throw new Error(
      `executeCommandById('${commandId}') returned false: the command either ` +
        `does not exist or refused to run (e.g. its checkCallback declined).`
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

/**
 * Overall budget for getting the quick switcher on screen, across retries.
 *
 * A ceiling, not a cost: `toPass` returns as soon as the switcher is visible,
 * so a healthy run pays nothing for this and raising it never slows a passing
 * test. It only decides how long a doomed one burns before reporting.
 *
 * 20s buys ~10 attempts at SWITCHER_RETRY_MS, against a boot-time race that
 * resolves in one. The bound that matters is the 300s test timeout: the test
 * that calls `openNote` most does so 3 times, so the worst case here is 60s —
 * comfortably inside it, which keeps a genuine failure reporting as a switcher
 * timeout with a usable stack instead of an opaque "test exceeded 300s".
 *
 * Raising this further is the wrong lever. A run that exhausts even half these
 * attempts is not losing a race — the switcher is not going to open — and the
 * useful response is a faster, more legible failure, not a longer one.
 */
const SWITCHER_TIMEOUT_MS = 20_000;

/**
 * How long to wait for the suggestion list after typing into the switcher.
 *
 * Separate from the retry ceiling above: by this point the switcher is open and
 * filled, and Obsidian renders matches within a frame or two. Nothing here is
 * waiting out a boot race, so it keeps the ordinary short modal bound.
 */
const SUGGESTION_TIMEOUT_MS = MODAL_TIMEOUT_MS;

/**
 * Per-attempt wait for the switcher after issuing `switcher:open`.
 *
 * Deliberately short. When the command lands before Obsidian's modal layer is
 * wired, the modal never appears at all — no amount of further waiting on that
 * attempt helps, and the only thing that does is issuing the command again.
 * Small enough that several attempts fit inside SWITCHER_TIMEOUT_MS, large
 * enough to cover an attempt that genuinely worked but rendered slowly.
 *
 * Not lower than this. Each attempt also pays the 200ms renderer sleep inside
 * `executeCommandById`, so shrinking it mostly buys more command dispatches per
 * second at a UI that is not ready to receive them — which is load, not
 * progress, on exactly the loaded runner where this fails.
 */
const SWITCHER_RETRY_MS = 1_500;

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
 * Close any modal that is already on screen, so the quick switcher can open.
 *
 * Obsidian routes hotkeys and commands through the topmost modal: while one is
 * up, `switcher:open` is declined and no amount of reissuing it helps. A stray
 * modal therefore turns the retry loop in `openNote` into a 20s no-op that
 * reports the switcher as the fault.
 *
 * Nothing here is load-bearing for a healthy run — normally no modal is open
 * and this returns immediately after one cheap visibility check.
 */
async function dismissStrayModal(window: Page) {
  const modal = window.locator('.modal-bg');
  if (!(await modal.isVisible().catch(() => false))) return;

  // Escape is how Obsidian's own modals close, and it works regardless of which
  // modal it is — which matters because we cannot know what left it there.
  await window.keyboard.press('Escape').catch(() => {});
  await modal
    .waitFor({ state: 'hidden', timeout: SWITCHER_RETRY_MS })
    .catch(() => {
      // Some modals refuse Escape. Say nothing and let the caller's retry
      // budget run out against a real symptom rather than throwing from a
      // best-effort cleanup.
    });
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
  // Deliberately NOT swallowed. This used to be `.catch(() => {})` on the
  // theory that a dead page reports better downstream — but a workspace that
  // never reaches `layoutReady` sends us into the retry loop below, which then
  // burns its entire budget issuing a command that cannot work, and reports the
  // switcher as the fault. Failing here names the actual problem.
  await waitForLayoutReady(window);

  const quickSwitcher = window.getByPlaceholder('Find or create a note...');

  // Issue `switcher:open` until the modal actually appears.
  //
  // One call is not enough. `layoutReady` — which the guard above waits for —
  // means the workspace has deserialized, not that the UI is interactive:
  // Obsidian finishes wiring the modal layer and hotkey registry after it. In
  // that window the command runs and *returns true* (so `executeCommandById`'s
  // own check passes) while the modal it opens has nowhere to mount, and the
  // switcher never appears.
  //
  // This is why the failures cluster on the first `openNote` of a test — the
  // first interaction after `beforeEach` boots the vault. Tests whose first
  // action is something else have already given Obsidian the time this needs.
  //
  // Reissuing is safe: if an earlier call did open the switcher, `toPass` stops
  // at the visibility check without sending another command.
  //
  // A modal already on screen is not safe to type into, though: it swallows the
  // hotkey layer, so `switcher:open` is declined and we would retry against a
  // modal that is never going away on its own. Dismiss it first.
  await expect(async () => {
    if (await quickSwitcher.isVisible()) return;
    await dismissStrayModal(window);
    await executeCommandById(window, 'switcher:open');
    await quickSwitcher.waitFor({
      state: 'visible',
      timeout: SWITCHER_RETRY_MS,
    });
  }).toPass({ timeout: SWITCHER_TIMEOUT_MS });

  await quickSwitcher.fill(path);

  // Obsidian filters the suggestion list asynchronously. Pressing Enter before
  // the list has caught up either opens the wrong note or creates a new one
  // named after the query, so wait for a suggestion to exist first.
  await window
    .locator('.suggestion-item, .suggestion-empty')
    .first()
    .waitFor({ state: 'visible', timeout: SUGGESTION_TIMEOUT_MS });

  // Register the file-open listener now: after the switcher is up, but before
  // the keypress that navigates. Registering it earlier (before the retry loop
  // above) would start its internal timeout while we were still trying to open
  // the switcher at all, so a slow boot could burn the whole budget and let the
  // promise resolve spuriously — reporting a note as opened that never was.
  //
  // `.catch()` is attached immediately rather than at the await below. If the
  // context dies while this evaluate is in flight it rejects, and an unawaited
  // rejection that only gets a handler later is an unhandled rejection in the
  // meantime — which Playwright surfaces as a worker-level error detached from
  // any test. Swallowing it is correct: the modal-hidden wait below still
  // reports a note that failed to open, with a usable stack.
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
