import { expect, type Page } from '@playwright/test';
import {
  executeCommandById,
  leafSnapshot,
  REVIEW_VIEW_TYPE,
  setDefaultEditingMode,
  type RepoWindow,
} from './helpers';
import { test } from './setup/fixtures';
import { createVaultCopy } from './setup/helpers';
import {
  closeDevices,
  launchDevice,
  launchSecondDevice,
  waitForTakenOn,
  type Device,
} from './setup/two-device';

let deviceA: Device | undefined;
let deviceB: Device | undefined;

// #region HELPERS

/** The page-side Obsidian these tests reach. Unofficial: `window.app`. */
type PageApp = {
  vault: {
    create(path: string, data: string): Promise<unknown>;
  };
  workspace: {
    getLeaf(newLeaf: 'tab'): {
      openFile(file: unknown, state?: unknown): Promise<void>;
    };
    setActiveLeaf(leaf: unknown, params: { focus: boolean }): void;
    activeEditor: {
      editor?: {
        cm: {
          state: { doc: { toString(): string } };
          dispatch(spec: { selection: { anchor: number; head: number } }): void;
        };
      };
    } | null;
  };
};

type PageRepo = {
  query(sql: string): Promise<Record<string, unknown>[]>;
  mutate(sql: string, params?: unknown[]): Promise<unknown>;
};

/** Open a new note of `text` at `path` in a tab of its own, active. */
const openNote = (page: Page, path: string, text: string) =>
  page.evaluate(
    async ([path, text]) => {
      const { app } = window as unknown as { app: PageApp };
      const file = await app.vault.create(path, text);
      const leaf = app.workspace.getLeaf('tab');
      await leaf.openFile(file, { active: true });
      app.workspace.setActiveLeaf(leaf, { focus: true });
    },
    [path, text] as const
  );

/** Select `text` in the active editor. */
const select = (page: Page, text: string) =>
  page.evaluate((text) => {
    const { app } = window as unknown as { app: PageApp };
    const { cm } = app.workspace.activeEditor!.editor!;
    const at = cm.state.doc.toString().indexOf(text);
    cm.dispatch({ selection: { anchor: at, head: at + text.length } });
  }, text);

/** Rows of `sql` in the database of the device on `page`. */
const query = (page: Page, sql: string) =>
  page.evaluate(
    async (sql) =>
      await (
        (window as unknown as RepoWindow).app.plugins.plugins[
          'incremental-reading'
        ].reviewManager.repo as unknown as PageRepo
      ).query(sql),
    sql
  );

/** The ids of the snippets not deleted for good, once there are `count`. */
async function snippetIds(page: Page, count: number) {
  const read = async () =>
    (
      await query(
        page,
        "SELECT id FROM snippet WHERE reference NOT LIKE '/ir-deleted/%'"
      )
    ).map(({ id }) => String(id));
  await expect.poll(async () => (await read()).length).toBe(count);
  return read();
}

/**
 * Bring every snippet due now. New snippets are filed for tomorrow, and a
 * later write of the row while the snippet is still being made can put the
 * date back, so the change is repeated until it holds. The schedule is no
 * change the undo prompt reports, so writing it here asks nothing later.
 */
async function bringSnippetsDue(page: Page) {
  await expect(async () => {
    await page.evaluate(async (at) => {
      await (
        (window as unknown as RepoWindow).app.plugins.plugins[
          'incremental-reading'
        ].reviewManager.repo as unknown as PageRepo
      ).mutate('UPDATE snippet SET due = $1', [at]);
    }, Date.now());
    await page.waitForTimeout(500);
    const rows = await query(page, 'SELECT due FROM snippet');
    expect(rows.every(({ due }) => Number(due) <= Date.now())).toBe(true);
  }).toPass();
}

/**
 * Which item the active review tab on `page` holds, once its note is open in
 * it: what the review commands need before they run. A snippet's review has
 * no title line for `waitForReviewItem` to wait on.
 */
async function reviewing(page: Page) {
  const { viewType, file, currentItemId } = await leafSnapshot(page);
  return viewType === REVIEW_VIEW_TYPE && file ? currentItemId : null;
}

const highlights = (page: Page) =>
  page.locator('.workspace-leaf.mod-active .cm-line .ir-snippet-highlight');

const confirmation = (page: Page) =>
  page.locator('.modal-container.mod-confirmation');

// #endregion

test.beforeEach(async () => {
  // One vault copy, two installs: each its own device to the plugin, each
  // seeing the other's saves through its own file watcher, as Sync delivers
  const vaultPath = await createVaultCopy('two-device');
  deviceA = await launchDevice(vaultPath);
  deviceB = await launchSecondDevice(vaultPath);
});

test.afterEach(async () => {
  await closeDevices([deviceA, deviceB]);
  deviceA = undefined;
  deviceB = undefined;
});

test('undoing a snippet another device has since reviewed asks first, and Cancel keeps it', async () => {
  const a = deviceA!.window;
  const b = deviceB!.window;

  // On A: make a snippet
  await setDefaultEditingMode(a, 'source');
  await openNote(a, 'Source note.md', 'Intro\n\nSpaced repetition text.');
  await select(a, 'repetition');
  await executeCommandById(a, 'incremental-reading:extract-selection');
  const [snippet] = await snippetIds(a, 1);
  await expect(highlights(a)).toHaveText(['repetition']);
  await bringSnippetsDue(a);
  await waitForTakenOn(a, b);

  // On B: review it, in the review tab
  expect(await snippetIds(b, 1)).toEqual([snippet]);
  await executeCommandById(b, 'incremental-reading:learn');
  await b.locator('css=#begin-review-button').click();
  await expect.poll(() => reviewing(b)).toBe(snippet);
  await executeCommandById(b, 'incremental-reading:mark-review');
  await expect
    .poll(async () =>
      (await query(b, 'SELECT snippet_id FROM snippet_review')).map(
        ({ snippet_id }) => String(snippet_id)
      )
    )
    .toEqual([snippet]);
  await waitForTakenOn(b, a);

  // On A: undo the snippet. The prompt names B's one review
  await executeCommandById(a, 'incremental-reading:undo');
  await expect(confirmation(a)).toBeVisible();
  await expect(confirmation(a).locator('li')).toHaveText([/^1 review$/]);

  // Cancel keeps it: the snippet and its highlight stay, and undo still
  // offers it
  await confirmation(a).locator('button.mod-cancel').click();
  await expect(confirmation(a)).toHaveCount(0);
  await expect(highlights(a)).toHaveText(['repetition']);
  expect(await snippetIds(a, 1)).toEqual([snippet]);
  await executeCommandById(a, 'incremental-reading:undo');
  await expect(confirmation(a)).toBeVisible();
  await confirmation(a).locator('button.mod-cancel').click();
  await expect(confirmation(a)).toHaveCount(0);
});
