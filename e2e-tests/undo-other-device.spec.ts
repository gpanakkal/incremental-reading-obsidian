import { expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  executeCommandById,
  setDefaultEditingMode,
  type RepoWindow,
} from './helpers';
import { test } from './setup/fixtures';
import {
  closeElectron,
  createVaultCopy,
  launchElectron,
  openVault,
} from './setup/helpers';

let app: ElectronApplication;
let window: Page;
let vaultPath: string;

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
  mutate(sql: string, params: unknown[]): unknown;
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

/** The ids of the snippets not deleted for good, once there are `count`. */
async function snippetIds(page: Page, count: number) {
  const read = () =>
    page.evaluate(async () => {
      const rows = await (
        (window as unknown as RepoWindow).app.plugins.plugins[
          'incremental-reading'
        ].reviewManager.repo as unknown as PageRepo
      ).query(
        "SELECT id FROM snippet WHERE reference NOT LIKE '/ir-deleted/%'"
      );
      return rows.map(({ id }) => String(id));
    });
  await expect.poll(async () => (await read()).length).toBe(count);
  return read();
}

const highlights = (page: Page) =>
  page.locator('.workspace-leaf.mod-active .cm-line .ir-snippet-highlight');

const confirmation = (page: Page) =>
  page.locator('.modal-container.mod-confirmation');

// #endregion

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('undo-elsewhere');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
});

test('asks before undoing a snippet another device reviewed: Cancel keeps it, and Undo anyway undoes it', async () => {
  await setDefaultEditingMode(window, 'source');
  await openNote(window, 'Source note.md', 'Intro\n\nSpaced repetition text.');
  await select(window, 'repetition');
  await executeCommandById(window, 'incremental-reading:extract-selection');
  const [snippet] = await snippetIds(window, 1);
  await expect(highlights(window)).toHaveText(['repetition']);

  // A review of the snippet and a card made from it on another device, as a
  // merge brings them in: stamped by that device, past any save of it this
  // database has seen. A statement that sets its own stamp keeps it. The
  // review is what asks: the card outlives the undo, so alone it would not.
  await window.evaluate(async (snippet) => {
    const repo = (window as unknown as RepoWindow).app.plugins.plugins[
      'incremental-reading'
    ].reviewManager.repo as unknown as PageRepo;
    const stamp = Date.now() + 24 * 60 * 60 * 1000;
    await repo.mutate(
      `INSERT INTO snippet_review (id, snippet_id, review_time, updated_at,
         updated_by)
       VALUES ('review-elsewhere', $1, $2, $3, 'other-device')`,
      [snippet, Date.now(), stamp]
    );
    await repo.mutate(
      `INSERT INTO srs_card (id, reference, parent, created_at, due,
         stability, difficulty, elapsed_days, scheduled_days, state,
         updated_at, updated_by)
       VALUES ('card-elsewhere', 'cards/elsewhere.md', $1, $2, $2, 0, 0, 0,
         0, 0, $3, 'other-device')`,
      [snippet, Date.now(), stamp]
    );
  }, snippet);

  await executeCommandById(window, 'incremental-reading:undo');
  await expect(confirmation(window)).toBeVisible();
  await confirmation(window).locator('button.mod-cancel').click();
  await expect(confirmation(window)).toHaveCount(0);
  // Kept: the snippet and its highlight stay, and undo still offers it
  await expect(highlights(window)).toHaveText(['repetition']);
  expect(await snippetIds(window, 1)).toEqual([snippet]);

  await executeCommandById(window, 'incremental-reading:undo');
  await expect(confirmation(window)).toBeVisible();
  await confirmation(window).locator('button.mod-cta').click();
  await expect(highlights(window)).toHaveCount(0);
  await snippetIds(window, 0);
});
