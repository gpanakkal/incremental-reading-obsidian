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
 * The title of the item currently open in the review pane.
 *
 * Scoped to `.ir-title` — the review pane's own inline title, rendered by
 * `TitleEditor` from the item's basename — rather than searching the document
 * for the title text. The same string also sits in the window titlebar, in a
 * tab header per open tab, in a `.view-header-title` per leaf, and in the
 * source note's own `.inline-title`, so a document-wide `getByText` returns
 * seven elements of which six are not the review pane. Four of those six can
 * never be visible (the inactive leaf is display:none, and the review view
 * replaces its header row with the action bar) and two are always-visible tab
 * headers, which is what makes indexing into the list so treacherous: `.nth()`
 * off by one either way is vacuously true or impossible, never wrong loudly.
 *
 * Nor is the ordering stable. `ReviewView.setTitle` fills the review leaf's
 * `view-header-title` after the pane renders, so the list grows from six to
 * seven mid-assertion; an index that resolved correctly did so by winning a
 * render race, not because it named the review pane.
 *
 * @param title the item's expected name, matched as a substring
 */
export function reviewTitle(window: Page, title: string) {
  return window.locator('.ir-title', { hasText: title });
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

/**
 * Import a note from the vault as an article, starting from wherever the
 * workspace is: opens the note in the active tab first, since the import
 * command reads the active file.
 *
 * @param path passed to {@link openNote}
 */
export async function importArticle(window: Page, path: string) {
  await openNote(window, path);
  await executeCommandById(window, 'incremental-reading:import-article');
  await finalizeArticleImport(window);
}

/** The review tab's view type, as `ReviewView.viewType` registers it. */
export const REVIEW_VIEW_TYPE = 'incremental-reading-review';

/** What the review tab calls itself when it is not showing an item. */
export const REVIEW_VIEW_DEFAULT_TITLE = 'Incremental reading';

/**
 * The ephemeral-state key a review tab files its place under on history
 * entries. Mirrors `REVIEW_PLACE_KEY` in `src/lib/review-history.ts`; the e2e
 * suite runs against the built bundle and cannot import from `src/`.
 */
const REVIEW_PLACE_KEY = 'incrementalReadingPlace';

/** One entry of a leaf's back or forward stack, reduced to what tests read. */
export type HistoryEntrySnapshot = {
  title: string;
  /** View type the entry reopens. */
  type: string | null;
  /** The review place filed on the entry, or `null` for anything else. */
  place: { page: string; itemId: string | null } | null;
};

/** The active tab and the plugin's store, read in one round trip. */
export type LeafSnapshot = {
  viewType: string | null;
  /** `view.getDisplayText()`: what the tab header and taskbar show. */
  displayText: string | null;
  /** Text of the active tab header's title. */
  tabHeaderTitle: string | null;
  /** Vault path of `view.file`, or `null` when the view holds none. */
  file: string | null;
  page: string;
  currentItemId: string | null;
  back: HistoryEntrySnapshot[];
  forward: HistoryEntrySnapshot[];
};

type TestWindow = Page & {
  app: App & {
    plugins: {
      plugins: Record<
        string,
        {
          store: {
            getState(): { page: string; currentItemId: string | null };
            subscribe(listener: () => void): () => void;
          };
          settings: Record<string, unknown>;
        }
      >;
    };
    emulateMobile(on: boolean): void;
    isMobile: boolean;
    mobileNavbar: {
      backButtonEl: HTMLElement;
      forwardButtonEl: HTMLElement;
    } | null;
  };
};

/** Snapshot the active leaf, its history stacks, and the review store. */
export async function leafSnapshot(window: Page): Promise<LeafSnapshot> {
  return await window.evaluate((placeKey) => {
    const { app } = window as unknown as TestWindow;
    const plugin = app.plugins.plugins['incremental-reading'];
    if (!plugin) throw new Error('incremental-reading plugin is not loaded');
    const leaf = app.workspace.getMostRecentLeaf() as unknown as {
      view: {
        getViewType(): string;
        getDisplayText(): string;
        file?: { path: string } | null;
      } | null;
      tabHeaderInnerTitleEl?: HTMLElement;
      history: {
        backHistory: {
          title: string;
          state?: { type?: string };
          eState?: Record<string, unknown>;
        }[];
        forwardHistory: {
          title: string;
          state?: { type?: string };
          eState?: Record<string, unknown>;
        }[];
      };
    };
    const describe = (entry: {
      title: string;
      state?: { type?: string };
      eState?: Record<string, unknown>;
    }) => ({
      title: entry.title,
      type: entry.state?.type ?? null,
      place:
        (entry.eState?.[placeKey] as
          | { page: string; itemId: string | null }
          | undefined) ?? null,
    });
    const { page, currentItemId } = plugin.store.getState();
    return {
      viewType: leaf.view?.getViewType() ?? null,
      displayText: leaf.view?.getDisplayText() ?? null,
      tabHeaderTitle: leaf.tabHeaderInnerTitleEl?.textContent ?? null,
      file: leaf.view?.file?.path ?? null,
      page,
      currentItemId,
      back: leaf.history.backHistory.map(describe),
      forward: leaf.history.forwardHistory.map(describe),
    };
  }, REVIEW_PLACE_KEY);
}

/** An item as review shows it: its database id and its note's basename. */
export type ShownItem = { id: string; title: string };

/**
 * Wait for the active tab to settle on an item in review, and report which.
 *
 * Settled means every copy of "which item" agrees: the store, the view's file,
 * and the title the tab shows — plus the item's own title rendered in the pane.
 */
export async function waitForReviewItem(window: Page): Promise<ShownItem> {
  let shown: ShownItem | null = null;
  await expect(async () => {
    const snapshot = await leafSnapshot(window);
    expect(snapshot.viewType).toBe(REVIEW_VIEW_TYPE);
    expect(snapshot.page).toBe('review');
    expect(snapshot.currentItemId).not.toBeNull();
    expect(snapshot.file).not.toBeNull();
    const title = basename(snapshot.file ?? '');
    expect(snapshot.displayText).toBe(title);
    // Inside the retry, not after it. This helper takes whichever item the
    // store names, so it can otherwise latch onto a transitional one: opening
    // an item from the home screen flips `page` to 'review' a beat before
    // `currentItemId` and `file` stop naming the item review held last, and
    // those four agree with each other throughout. Settling there and only
    // then asking the pane would pin the assertion to an item the DOM is
    // already navigating away from, which can never become true — a hard
    // failure on a loaded runner where that beat is wide enough to be read.
    //
    // The short timeout is what makes the retry work: at the suite's 15s
    // default a single stale read would spend the whole budget here.
    await expect(reviewTitle(window, title)).toBeVisible({ timeout: 1000 });
    shown = { id: snapshot.currentItemId ?? '', title };
  }).toPass({ timeout: 15_000 });
  return shown as unknown as ShownItem;
}

/**
 * Assert the active tab is review, on `item`, with the store, the view's file,
 * the tab title and the pane's own title all naming it.
 */
export async function expectReviewOn(window: Page, item: ShownItem) {
  await expect
    .poll(async () => {
      const s = await leafSnapshot(window);
      return {
        viewType: s.viewType,
        page: s.page,
        currentItemId: s.currentItemId,
        displayText: s.displayText,
        tabHeaderTitle: s.tabHeaderTitle,
        fileBasename: s.file === null ? null : basename(s.file),
      };
    })
    .toEqual({
      viewType: REVIEW_VIEW_TYPE,
      page: 'review',
      currentItemId: item.id,
      displayText: item.title,
      tabHeaderTitle: item.title,
      fileBasename: item.title,
    });
  await expect(reviewTitle(window, item.title)).toBeVisible();
}

/** Assert the active tab is review, showing its home screen. */
export async function expectReviewHome(window: Page) {
  await expect
    .poll(async () => {
      const s = await leafSnapshot(window);
      return {
        viewType: s.viewType,
        page: s.page,
        displayText: s.displayText,
      };
    })
    .toEqual({
      viewType: REVIEW_VIEW_TYPE,
      page: 'home',
      displayText: REVIEW_VIEW_DEFAULT_TITLE,
    });
  await expect(window.locator('css=#begin-review-button')).toBeVisible();
  await expect(window.locator('.ir-queue-row').first()).toBeVisible();
}

function basename(path: string) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.endsWith('.md') ? name.slice(0, -'.md'.length) : name;
}

/**
 * Open a vault file in the active tab itself — the tab navigating, as a link
 * followed inside it does — rather than wherever the quick switcher decides.
 */
export async function openFileInActiveLeaf(window: Page, path: string) {
  await window.evaluate(async (filePath) => {
    const { app } = window as unknown as TestWindow;
    const file = app.vault.getFileByPath(filePath);
    if (!file) throw new Error(`No such file: ${filePath}`);
    const leaf = app.workspace.getMostRecentLeaf();
    if (!leaf) throw new Error('No active leaf');
    await leaf.openFile(file);
  }, path);
}

/**
 * Collect every Obsidian notice shown from now on, for asserting that nothing
 * like "tab is busy" went by. Returns a reader for what has been seen so far.
 */
export async function watchNotices(window: Page) {
  await window.evaluate(() => {
    const w = window as unknown as { __irNotices?: string[] };
    w.__irNotices = [];
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof HTMLElement && node.matches('.notice')) {
            w.__irNotices?.push(node.textContent ?? '');
          }
        });
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  return async () =>
    await window.evaluate(
      () => (window as unknown as { __irNotices?: string[] }).__irNotices ?? []
    );
}

/**
 * Turn Obsidian's mobile emulation on or off. Obsidian reloads the renderer to
 * apply it, which also reloads every plugin, so this waits for the reloaded
 * workspace and plugin rather than returning into the old page.
 */
export async function emulateMobile(window: Page, on: boolean) {
  const reloaded = window.waitForEvent('domcontentloaded');
  await window
    .evaluate((value) => {
      (window as unknown as TestWindow).app.emulateMobile(value);
    }, on)
    .catch((error: unknown) => {
      if (!isContextDestroyedError(error)) throw error;
    });
  await reloaded;
  await waitForLayoutReady(window);
  await window.waitForFunction(
    (value) => {
      const { app } = window as unknown as TestWindow;
      return (
        app?.isMobile === value &&
        !!app.plugins?.plugins?.['incremental-reading']?.store
      );
    },
    on,
    { timeout: 15_000 }
  );
}

/**
 * Flip one of the plugin's settings from inside the running app.
 *
 * In memory only — no `saveSettings` — because that is where everything reads
 * it from, and writing `data.json` here would also have to be undone before the
 * next command picked it back up.
 */
export async function setPluginSetting(
  window: Page,
  key: string,
  value: unknown
) {
  await waitForLayoutReady(window);
  await window.evaluate(
    ([settingKey, settingValue]) => {
      const plugins = (
        window as Page & {
          app: App & {
            plugins: {
              plugins: Record<string, { settings: Record<string, unknown> }>;
            };
          };
        }
      ).app.plugins.plugins;
      const plugin = plugins['incremental-reading'];
      if (!plugin) throw new Error('incremental-reading plugin is not loaded');
      plugin.settings[settingKey] = settingValue;
    },
    [key, value] as [string, unknown]
  );
}
