import { expect, type Page } from '@playwright/test';
import {
  executeCommandById,
  leafSnapshot,
  REVIEW_VIEW_TYPE,
  type RepoWindow,
} from '../helpers';

/**
 * Steps on items that the undo specs share: making a note and a snippet of
 * it, reading the database, and bringing an item up in review.
 */

/** The page-side Obsidian these steps reach. Unofficial: `window.app`. */
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

export type PageRepo = {
  query(sql: string): Promise<Record<string, unknown>[]>;
  mutate(sql: string, params?: unknown[]): Promise<unknown>;
};

/** Open a new note of `text` at `path` in a tab of its own, active. */
export const openNote = (page: Page, path: string, text: string) =>
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
export const select = (page: Page, text: string) =>
  page.evaluate((text) => {
    const { app } = window as unknown as { app: PageApp };
    const { cm } = app.workspace.activeEditor!.editor!;
    const at = cm.state.doc.toString().indexOf(text);
    cm.dispatch({ selection: { anchor: at, head: at + text.length } });
  }, text);

/** Rows of `sql` in the database of the device on `page`. */
export const query = (page: Page, sql: string) =>
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
export async function snippetIds(page: Page, count: number) {
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
export async function bringSnippetsDue(page: Page) {
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
export async function reviewing(page: Page) {
  const { viewType, file, currentItemId } = await leafSnapshot(page);
  return viewType === REVIEW_VIEW_TYPE && file ? currentItemId : null;
}

/**
 * Open review and skip what comes up until the item `id` does, which must be
 * due. Skipping writes nothing, so whatever else is due (the article a
 * snippet was taken from, say) costs no change another device could see.
 */
export async function reviewUntil(page: Page, id: string) {
  await executeCommandById(page, 'incremental-reading:learn');
  await page.locator('css=#begin-review-button').click();
  // More than the items a test makes is a review that never gets there
  for (let skipped = 0; ; skipped++) {
    let current: string | null = null;
    await expect
      .poll(async () => (current = await reviewing(page)))
      .not.toBeNull();
    if (current === id) return;
    if (skipped === 5) throw new Error(`Review never brought up ${id}`);
    await executeCommandById(page, 'incremental-reading:skip-item');
    // Moved on before looking again, or the same item would be skipped twice
    await expect.poll(() => reviewing(page)).not.toBe(current);
  }
}

export const highlights = (page: Page) =>
  page.locator('.workspace-leaf.mod-active .cm-line .ir-snippet-highlight');

export const confirmation = (page: Page) =>
  page.locator('.modal-container.mod-confirmation');
