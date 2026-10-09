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
 * seven elements of which six are not the review pane. Several of those six
 * are visible, and which ones depends on the leaf and the "Show tab title bar"
 * setting, which is what makes indexing into the list so treacherous: `.nth()`
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

/** The test-vault folder `scripts/make-pdf-fixtures.mjs` writes its PDFs to. */
export const PDF_FIXTURE_FOLDER = 'testing';

/** The three-page PDF fixture most PDF tests import. */
export const PDF_FIXTURE_PATH = `${PDF_FIXTURE_FOLDER}/PDF fixture.pdf`;

/**
 * Set Settings -> Editor -> "Default editing mode", which is the `livePreview`
 * vault config underneath.
 *
 * Every markdown editor seeds its own `sourceMode` from that config when it is
 * constructed — the review editor, and the throwaway one the plugin extracts
 * Obsidian's editor extensions from — so this has to be called before review
 * opens for it to be the mode review opens in.
 */
export async function setDefaultEditingMode(
  window: Page,
  mode: 'live-preview' | 'source'
) {
  await window.evaluate((livePreview) => {
    (window as unknown as TestWindow).app.vault.setConfig(
      'livePreview',
      livePreview
    );
  }, mode === 'live-preview');
}

/**
 * Flip the review tab between source mode and live preview, as the "Source
 * mode" entry in its ⋮ menu does.
 */
export async function toggleReviewSourceMode(window: Page) {
  await window.evaluate((viewType) => {
    const { app } = window as unknown as TestWindow;
    const view = app.workspace.getLeavesOfType(viewType)[0]?.view as
      | { toggleSourceMode?: () => void }
      | undefined;
    if (!view?.toggleSourceMode) {
      throw new Error('No review tab open to toggle');
    }
    view.toggleSourceMode();
  }, REVIEW_VIEW_TYPE);
}

/** The view header of the active review tab. */
export function reviewHeader(window: Page) {
  return window.locator(
    `.workspace-leaf.mod-active [data-type="${REVIEW_VIEW_TYPE}"] > .view-header`
  );
}

/**
 * Set Settings -> Appearance -> "Show tab title bar", which is the
 * `showViewHeader` vault config underneath. Obsidian applies it as a class on
 * `body`, so it takes effect at once, on tabs already open too.
 */
export async function setShowViewHeader(window: Page, show: boolean) {
  await window.evaluate((value) => {
    (window as unknown as TestWindow).app.vault.setConfig(
      'showViewHeader',
      value
    );
  }, show);
}

/**
 * Set Settings -> Appearance -> "Native menus", the `nativeMenus` vault
 * config. On macOS it defaults to on, and a native menu is drawn by Electron
 * outside the page, where no locator can see it. Turn it off before asserting
 * on a `.menu`. Takes effect at once, like `setShowViewHeader`.
 */
export async function setNativeMenus(window: Page, native: boolean) {
  await window.evaluate((value) => {
    (window as unknown as TestWindow).app.vault.setConfig('nativeMenus', value);
  }, native);
}

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
 * How many writes of the database file are still under way. Poll it to 0
 * before {@link emulateMobile}: a reload mid-write leaves an empty database.
 */
export async function pendingSaves(window: Page): Promise<number> {
  return await window.evaluate(() => {
    const { app } = window as unknown as TestWindow;
    const { reviewManager } = app.plugins.plugins[
      'incremental-reading'
    ] as unknown as { reviewManager: { repo: { pendingSaveCount: number } } };
    return reviewManager.repo.pendingSaveCount;
  });
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

/**
 * Turn Obsidian's "Automatically update internal links" off for this vault, so
 * a rename asks before it updates links to the file. The test vault ships with
 * it on.
 *
 * Undocumented: the setting is the `alwaysUpdateLinks` vault config, set
 * through `Vault.setConfig`.
 */
export async function askBeforeUpdatingLinks(window: Page) {
  await waitForLayoutReady(window);
  await window.evaluate(() => {
    const { app } = window as unknown as {
      app: { vault: { setConfig(key: string, value: unknown): void } };
    };
    app.vault.setConfig('alwaysUpdateLinks', false);
  });
}

/**
 * Set Obsidian's "New link format" for this vault: how a new link names its
 * file. The test vault ships with the default, the shortest path.
 *
 * Undocumented: the setting is the `newLinkFormat` vault config, set through
 * `Vault.setConfig`.
 */
export async function setNewLinkFormat(
  window: Page,
  format: 'shortest' | 'relative' | 'absolute'
) {
  await waitForLayoutReady(window);
  await window.evaluate((value) => {
    const { app } = window as unknown as {
      app: { vault: { setConfig(key: string, value: unknown): void } };
    };
    app.vault.setConfig('newLinkFormat', value);
  }, format);
}

/**
 * Rename the file at `from` to `to` as the file explorer does, through
 * `FileManager.renameFile`, and answer "Do not update" when Obsidian offers to
 * update the links to it (see {@link askBeforeUpdatingLinks}).
 */
export async function renameDecliningLinkUpdate(
  window: Page,
  from: string,
  to: string
) {
  const renaming = window.evaluate(
    ([from, to]) => {
      const { app } = window as unknown as {
        app: {
          vault: { getFileByPath(path: string): unknown };
          fileManager: {
            renameFile(file: unknown, newPath: string): Promise<void>;
          };
        };
      };
      // Settles only once the prompt is answered
      return app.fileManager.renameFile(app.vault.getFileByPath(from), to);
    },
    [from, to] as const
  );
  await window
    .locator('.modal-container')
    .getByRole('button', { name: 'Do not update' })
    .click();
  await renaming;
}

/**
 * Write a PDF of at least `minBytes` to `path` through the vault, so Obsidian
 * knows the file and its size at once. It is `fixture`, a PDF, with an
 * incremental update appended that adds one unreferenced stream of zeros:
 * still a valid PDF, only a large one. Built in the page, so the bytes never
 * cross the wire.
 */
export async function createLargePdf(
  window: Page,
  path: string,
  fixture: Uint8Array,
  minBytes: number
) {
  await window.evaluate(
    async ({ filePath, fixtureBytes, padding }) => {
      const base = Uint8Array.from(fixtureBytes);
      const text = new TextDecoder('latin1').decode(base);
      const match = (pattern: RegExp) => {
        const found = pattern.exec(text);
        if (!found) throw new Error(`Fixture has no ${pattern}`);
        return Number(found[1]);
      };
      const previousXref = match(/startxref\s+(\d+)\s+%%EOF\s*$/);
      const size = match(/\/Size (\d+)/);
      const root = match(/\/Root (\d+) 0 R/);
      const latin1 = (s: string) =>
        Uint8Array.from(s, (char) => char.charCodeAt(0));

      const head = latin1(`${size} 0 obj\n<</Length ${padding}>>\nstream\n`);
      const tail = latin1('\nendstream\nendobj\n');
      const xrefAt = base.length + head.length + padding + tail.length;
      const offset = String(base.length).padStart(10, '0');
      const update = latin1(
        `xref\n0 1\n0000000000 65535 f \n${size} 1\n${offset} 00000 n \n` +
          `trailer\n<</Size ${size + 1}/Root ${root} 0 R/Prev ${previousXref}>>\n` +
          `startxref\n${xrefAt}\n%%EOF\n`
      );

      const bytes = new Uint8Array(xrefAt + update.length);
      bytes.set(base, 0);
      bytes.set(head, base.length);
      // The padding is the zeros the array starts out as
      bytes.set(tail, base.length + head.length + padding);
      bytes.set(update, xrefAt);
      const { app } = window as unknown as TestWindow;
      await app.vault.createBinary(filePath, bytes.buffer);
    },
    { filePath: path, fixtureBytes: [...fixture], padding: minBytes }
  );
}

/** What {@link watchFileReads} saw of one file. */
export type FileReads = {
  /**
   * Each `fetch` of the file's resource URL: its `Range`, then its outcome,
   * and how many bytes of its body the server delivered before the read
   * stopped. The count can run a chunk ahead of what the reader took.
   */
  fetches: {
    range: string | null;
    status: number | string;
    bodyBytesRead: number;
  }[];
  /** How many times the vault read the whole file. */
  readBinary: number;
};

/**
 * Record, from now on, every `fetch` of the file at `path` and every whole-file
 * read of it through the vault adapter. The wrappers live in the page and keep
 * their log in `window.__diag`, so a read is seen however fast it is. Returns
 * a reader for that log.
 */
export async function watchFileReads(window: Page, path: string) {
  await window.evaluate((filePath) => {
    const { app } = window as unknown as TestWindow;
    const file = app.vault.getFileByPath(filePath);
    if (!file) throw new Error(`No such file: ${filePath}`);
    // The URL carries the file's mtime as a query, which any fetch may drop
    const resource = app.vault.getResourcePath(file).split('?')[0];
    const diag: FileReads = { fetches: [], readBinary: 0 };
    (window as unknown as { __diag: FileReads }).__diag = diag;

    const page = window as unknown as Window;
    const fetch = page.fetch.bind(page) as typeof page.fetch;
    page.fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.split('?')[0] !== resource) return fetch(input, init);
      const entry: FileReads['fetches'][number] = {
        range: new Headers(init?.headers).get('Range'),
        status: 'pending',
        bodyBytesRead: 0,
      };
      diag.fetches.push(entry);
      try {
        const response = await fetch(input, init);
        entry.status = response.status;
        if (response.body === null) return response;
        // Count what passes through on its way to the reader. Cancelling the
        // reader cancels the pipe, and that the response under it.
        const counted = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              entry.bodyBytesRead += chunk.length;
              controller.enqueue(chunk);
            },
          })
        );
        return new Response(counted, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        entry.status = String(error);
        throw error;
      }
    };

    const adapter = app.vault.adapter;
    const readBinary = adapter.readBinary.bind(
      adapter
    ) as typeof adapter.readBinary;
    adapter.readBinary = (normalizedPath: string) => {
      if (normalizedPath === filePath) diag.readBinary += 1;
      return readBinary(normalizedPath);
    };
  }, path);
  return () =>
    window.evaluate(() => (window as unknown as { __diag: FileReads }).__diag);
}

/** What Obsidian's three parsers make of some Markdown: see {@link readMarkdown}. */
export type MarkdownReadings = {
  /** Reading view: each block element rendered, and every syntax element in them. */
  reading: { blocks: { tag: string; text: string }[]; syntax: string[] };
  /**
   * Live preview, with the cursor off its lines: their visible text, any class
   * on them but an escape's, and any element coloured unlike its line.
   */
  live: { text: string; classes: string[]; colours: string[] };
  /** What the metadata cache reads in it as a note, and its sections' kinds. */
  cache: { found: Record<string, unknown>; sections: string[] };
};

/**
 * What Obsidian makes of `markdown` in reading view, in live preview and in
 * its metadata cache, each in its real parser: unit tests can't run them.
 * Reading view renders in a probe note's own tab, live preview in another.
 *
 * @param allowed selectors of elements reading view may hold, as the hidden
 *   answer's `<mark>` in a card under review
 */
export function readMarkdown(
  window: Page,
  markdown: string,
  allowed: string[] = []
): Promise<MarkdownReadings> {
  return window.evaluate(
    async ({ markdown, allowed }) => {
      type ProbeView = {
        file: { path: string } | null;
        setViewData(data: string, clear: boolean): void;
        previewMode: { containerEl: HTMLElement };
        containerEl: HTMLElement;
        editor: {
          setValue(text: string): void;
          lastLine(): number;
          setCursor(pos: { line: number; ch: number }): void;
        };
      };
      type ProbeLeaf = {
        view: ProbeView;
        openFile(file: unknown, state: unknown): Promise<void>;
      };
      const { app } = window as unknown as {
        app: {
          vault: {
            getFileByPath(path: string): unknown;
            create(path: string, data: string): Promise<unknown>;
          };
          workspace: {
            getLeavesOfType(type: string): ProbeLeaf[];
            getLeaf(newLeaf: 'tab' | 'split'): ProbeLeaf;
          };
          metadataCache: {
            // Undocumented: what the cache's worker reads a note's bytes as
            computeMetadataAsync(
              data: ArrayBuffer
            ): Promise<Record<string, unknown> | null>;
          };
        };
      };
      const sleep = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));
      /**
       * The view of the probe note at `path`, opened in `state` once, in a new
       * tab or beside the last: both stay shown, as a hidden one never renders.
       */
      const probe = async (
        path: string,
        state: unknown,
        where: 'tab' | 'split'
      ) => {
        const open = app.workspace
          .getLeavesOfType('markdown')
          .find(({ view }) => view.file?.path === path);
        if (open) return open.view;
        const file =
          app.vault.getFileByPath(path) ?? (await app.vault.create(path, ''));
        const tab = app.workspace.getLeaf(where);
        await tab.openFile(file, { active: true, state });
        return tab.view;
      };
      // Unique to this call: the probe is rendered once it is
      const token = `END${Math.random().toString(36).slice(2)}`;

      // Reading view. Undocumented: its DOM, where `.markdown-preview-sizer`
      // holds a div per section, besides its header, footer and pusher
      const preview = await probe(
        'Render probe.md',
        { mode: 'preview' },
        'tab'
      );
      preview.setViewData(`${markdown}\n\n${token}`, true);
      const sizer = () =>
        preview.previewMode.containerEl.querySelector(
          '.markdown-preview-sizer'
        );
      for (let i = 0; i < 250 && !sizer()?.textContent?.includes(token); i++) {
        await sleep(20);
      }
      if (!sizer()?.textContent?.includes(token)) {
        throw new Error('Reading view never rendered the probe');
      }
      const blocks = [...sizer()!.children]
        .filter(
          (section) =>
            !section.matches(
              '.mod-header, .mod-footer, .markdown-preview-pusher'
            )
        )
        .flatMap((section) => [...section.children])
        .filter((block) => block.textContent !== token);
      const syntax = blocks.flatMap((block) =>
        [
          ...block.querySelectorAll(
            'a, img, .tag, .internal-embed, .math, code, mark, del, s, ' +
              'em, strong, h1, h2, h3, h4, h5, h6, ul, ol, li, ' +
              'blockquote, hr, sup, table, input, .callout, .footnotes'
          ),
        ]
          .filter((el) => !allowed.some((selector) => el.matches(selector)))
          .map((el) => el.outerHTML.slice(0, 80))
      );

      // Live preview, with the cursor on a line of its own after the text
      const live = await probe(
        'Live probe.md',
        // Undocumented: the view state of live preview
        { mode: 'source', source: false },
        'split'
      );
      live.editor.setValue(`${markdown}\n\n${token}`);
      live.editor.setCursor({ line: live.editor.lastLine(), ch: 0 });
      let lines: HTMLElement[] = [];
      for (let i = 0; i < 250; i++) {
        await sleep(20);
        lines = [
          ...live.containerEl.querySelectorAll<HTMLElement>('.cm-content > *'),
        ];
        if (lines.at(-1)?.innerText === token) break;
      }
      const textLines = lines.slice(0, -1);
      /**
       * An escape's own marks, and a line's. CodeMirror puts a
       * `cm-widgetBuffer` image beside each hidden backslash for the cursor;
       * a real widget shows itself in the text and its own classes.
       */
      // Undocumented: the classes of Obsidian 1.13.7's live preview, and its
      // lines as `.cm-content`'s children
      const ESCAPE_CLASSES = new Set([
        'cm-line',
        'cm-widgetBuffer',
        'cm-escape',
        'cm-hmd-escape-char',
        'cm-hmd-escape-backslash',
        'cm-formatting-escape',
      ]);
      /**
       * What live preview adds for a line's leading spaces, as a card's
       * closing delimiter starts a line with one after an answer ending in a
       * line break: their spacing, and the fold arrow on the line above,
       * which folds by indent. Neither is syntax, nor shows any text.
       */
      const INDENT_UI =
        '.cm-indent-spacing, .cm-fold-indicator, .cm-fold-indicator *';
      const classes = [
        ...new Set(
          textLines.flatMap((line) =>
            [
              line,
              ...[...line.querySelectorAll('*')].filter(
                (el) => !el.matches(INDENT_UI)
              ),
            ].flatMap((el) =>
              [...el.classList].filter(
                (name) =>
                  !ESCAPE_CLASSES.has(name) &&
                  // Trailing spaces, shown as a line break would be
                  !name.startsWith('cm-trailing-space')
              )
            )
          )
        ),
      ];
      const colours = textLines.flatMap((line) => {
        const colour = getComputedStyle(line).color;
        return [...line.querySelectorAll<HTMLElement>('*')]
          .filter(
            (el) =>
              !el.matches(INDENT_UI) && getComputedStyle(el).color !== colour
          )
          .map((el) => `${el.innerText}: ${getComputedStyle(el).color}`);
      });

      const cache =
        (await app.metadataCache.computeMetadataAsync(
          new TextEncoder().encode(markdown).buffer
        )) ?? {};
      const { sections, ...found } = cache;
      return {
        reading: {
          blocks: blocks.map((block) => ({
            tag: block.tagName,
            text: block.textContent ?? '',
          })),
          syntax,
        },
        live: {
          text: textLines.map((line) => line.innerText).join('\n'),
          classes,
          colours,
        },
        cache: {
          found,
          sections: ((sections as { type: string }[] | undefined) ?? []).map(
            ({ type }) => type
          ),
        },
      };
    },
    { markdown, allowed }
  );
}

/** `text` with each run of whitespace one space, and none at its ends. */
export const squashed = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * Check `readings` show `text`, whitespace aside, as plain paragraphs with no
 * syntax in any of Obsidian's three parsers.
 */
export function expectPlainText(readings: MarkdownReadings, text: string) {
  expect(readings.reading.syntax).toEqual([]);
  expect(readings.reading.blocks.map(({ tag }) => tag)).toEqual(
    readings.reading.blocks.map(() => 'P')
  );
  expect(
    squashed(readings.reading.blocks.map((block) => block.text).join(' '))
  ).toBe(squashed(text));
  expect(squashed(readings.live.text)).toBe(squashed(text));
  expect(readings.live.classes).toEqual([]);
  expect(readings.live.colours).toEqual([]);
  expect(readings.cache.found).toEqual({});
  expect(readings.cache.sections).toEqual(
    readings.cache.sections.map(() => 'paragraph')
  );
}
